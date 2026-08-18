'use strict'

/**
 * dsh-llm-injection-filter — LLM 响应流注入过滤器（Host 插件，动态插件 / npm 包双形态）。
 *
 * 挂载点：llm/stream waterfall（对所有适配器生效）。waterfall 语义：listener 必须调用并
 * 返回 next() 才能触达底层 adapter 流；返回自己的 AsyncIterable 即包装/过滤流。
 *
 * 轨道 A（硬性规则，默认开启）：模型输出中出现不属于允许脚本集合的少见 Unicode 脚本字符
 * （泰文、亚美尼亚文、马拉雅拉姆文等）→ 立即 yield 一个 error finish chunk
 * （code=RESPONSE_FILTERED）中断当前 agent turn，强制模型停止，前端会话视图显示错误横幅。
 * 轨道 A 无视 mode、不参与评分、不等 block-end——宁可误杀，不可放过。
 *
 * 轨道 B（评分制规则）：控制字符 / ASCII 协议标记 / 多脚本混合 / 垃圾关键词，按 mode
 * （audit/strip/reject）处置；重点保护工具调用参数（唯一可执行面）——tool-call 的完整
 * arguments 在 block-end 才评分处置（单个 delta 太短无法综合判断；轨道 A 的罕见脚本检测
 * 恰好可以逐 delta 立即命中）。
 *
 * 已知取舍（勿擅自放宽默认）：
 * - 默认允许脚本集合不含日文（假名）/韩文（谚文）/俄文（西里尔）等，含这些脚本的合法
 *   输出也会被硬阻断。这是刻意设计的极端严格语义；逃生门是 allowedScripts 配置。
 * - maxScanLen 只约束轨道 B 的逐段扫描/替换（超出部分原样保留不处理）；轨道 A 不设上限
 *   （先做非 ASCII 快筛，宁可慢，不可放过）。
 * - reject 模式依赖 block-end 携带完整 arguments 做整块改写；极少数不发 block-end 的
 *   delta-only 流中 tool-call 参数无法整块改写（原样透传，仅审计）。
 */

// ============================ 配置 ============================

const DEFAULTS = {
  enabled: true,                 // 总开关；false 时直接透传 next()，零开销
  // —— 轨道 A：硬性阻断（最高优先级，命中即中断，无视 mode）——
  hardBlockRareScripts: true,    // 罕见脚本 → 立即中断
  allowedScripts: ['Latin', 'Han', 'Common', 'Inherited'], // 允许脚本白名单；可追加如 'Thai' 放行泰文
  checkReasoning: false,         // 是否对 reasoning-delta 也做轨道 A 检测（默认关：reasoning 不可执行且常含多语言思考）
  // —— 轨道 B：评分制 ——
  mode: 'audit',                 // 'audit'（只记录）| 'strip'（命中子串替换为 [FILTERED:n]）| 'reject'（block-end 改写 tool-call arguments）
  minScore: 100,                 // 轨道 B 触发阈值（CTRL=100，PROTO=100，PROTO-in-args +30，SCRIPT=80，KW=40）
  applyToProviders: [],          // 空 = 全部 provider；可填 ['openai'] 等
  extraPatterns: [],             // 额外正则字符串（编译失败捕获并报错，停用该规则，不炸流）
  extraKeywords: [],             // 额外关键词（按字面匹配，自动转义）
  maxScanLen: 16384,             // 轨道 B 单段扫描/替换长度上限
  maxSampleLen: 120,             // 审计样本截断长度
  recordMaxLen: 8192,            // 中断记录中载荷详情（delta / 已累积 arguments）的截断长度
}

// 运行时配置：在此覆盖默认值（动态插件：编辑源码后重新 define 新 Package；npm 包：导入后改）
const CFG = { ...DEFAULTS }

const BASE_ALLOWED = ['Latin', 'Han', 'Common', 'Inherited']
const HAS_NON_ASCII = /[^\x00-\x7F]/

// 轨道 B 规则
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/
const BASE_PROTO = [
  /\bassistant\s+to=/i,          // 模仿 Claude 工具调用头
  /\/\*<+/,                      // 注释注入 /*<<<
  /<system-reminder>/i,
  /<compacted-checkpoint>/i,
  /<!--/,
  /\[\/?(?:system|instruction)\]/i,
]
const BASE_KW = /彩神|争霸|天天中彩票|博彩|casino|gambling|betting/i
// 轨道 B SCRIPT 规则的候选脚本（识别 arguments 中"非 Latin/Han/Common"的具体脚本名）
const MIXED_SCRIPTS = [
  'Thai', 'Armenian', 'Malayalam', 'Devanagari', 'Cyrillic', 'Greek', 'Arabic',
  'Hebrew', 'Hangul', 'Hiragana', 'Katakana', 'Bengali', 'Tamil', 'Telugu',
  'Kannada', 'Gujarati', 'Gurmukhi', 'Sinhala', 'Georgian', 'Tibetan', 'Khmer',
  'Lao', 'Mongolian', 'Myanmar', 'Ethiopic', 'Syriac', 'Thaana', 'Cherokee',
  'Yi', 'Bopomofo', 'Runic', 'Ogham',
]

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 编译允许脚本白名单；任一脚本名非法 → 报错并回退默认集合（防止手滑把拉丁文输出也误杀）。 */
function compileScriptRes(scripts) {
  const res = {}
  let ok = true
  const list = Array.isArray(scripts) && scripts.length > 0 ? scripts : BASE_ALLOWED
  for (const s of list) {
    try {
      res[s] = new RegExp('\\p{Script=' + s + '}', 'u')
    } catch (e) {
      ok = false
      console.error('[llm-injection-filter] invalid allowedScript "' + s + '", falling back to defaults:', e && e.message)
      break
    }
  }
  if (!ok) {
    for (const s of BASE_ALLOWED) res[s] = new RegExp('\\p{Script=' + s + '}', 'u')
  }
  return res
}

/** 编译全部正则规则；规则编译失败 → apply 时即报错并停用该规则（不炸流）。 */
function compileRules(cfg) {
  const c = { ...DEFAULTS, ...cfg }
  const proto = BASE_PROTO.slice()
  for (const p of c.extraPatterns || []) {
    if (typeof p !== 'string' || p.length === 0) continue
    try {
      proto.push(new RegExp(p, 'i'))
    } catch (e) {
      console.error('[llm-injection-filter] invalid extraPattern, rule disabled:', p, '->', e && e.message)
    }
  }
  const kw = [BASE_KW]
  for (const k of c.extraKeywords || []) {
    if (typeof k !== 'string' || k.length === 0) continue
    try {
      kw.push(new RegExp(escapeRegex(k), 'i'))
    } catch (e) {
      console.error('[llm-injection-filter] invalid extraKeyword, rule disabled:', k, '->', e && e.message)
    }
  }
  const allowedRes = compileScriptRes(c.allowedScripts)
  const baseRes = {}
  for (const s of BASE_ALLOWED) baseRes[s] = new RegExp('\\p{Script=' + s + '}', 'u')
  const mixedRes = {}
  for (const s of MIXED_SCRIPTS) {
    try {
      mixedRes[s] = new RegExp('\\p{Script=' + s + '}', 'u')
    } catch (e) { /* 引擎不支持该脚本名则忽略 */ }
  }
  return { ctrlRE: CTRL_RE, proto, kw, allowedRes, baseRes, mixedRes }
}

function bounded(text, cfg) {
  const max = Number.isFinite(cfg.maxScanLen) && cfg.maxScanLen > 0 ? cfg.maxScanLen : 16384
  return text.length > max ? text.slice(0, max) : text
}

function sampleOf(text, cfg) {
  const max = Number.isFinite(cfg.maxSampleLen) && cfg.maxSampleLen > 0 ? cfg.maxSampleLen : 120
  const s = String(text)
  return s.length > max ? s.slice(0, max) : s
}

// ============================ 轨道 A：罕见脚本硬性阻断 ============================

function detectScript(ch, rules) {
  const keys = Object.keys(rules.mixedRes)
  for (let i = 0; i < keys.length; i++) {
    if (rules.mixedRes[keys[i]].test(ch)) return keys[i]
  }
  return 'unknown'
}

/**
 * 轨道 A 核心：在文本中查找第一个不属于允许脚本集合的字符。
 * 性能快筛：纯 ASCII（Latin-1 基本区）直接放行，零逐字符开销。
 * 健壮性：自身异常绝不外抛（try/catch 包裹，异常时返回 null，宁可漏检一次，不可炸流）。
 * @returns {{char: string, charCode: number, script: string, sample: string} | null}
 */
function findBlockedChar(text, rules) {
  try {
    if (typeof text !== 'string' || text.length === 0) return null
    if (!HAS_NON_ASCII.test(text)) return null
    const allowedKeys = Object.keys(rules.allowedRes)
    for (const ch of text) {
      let ok = false
      for (let i = 0; i < allowedKeys.length; i++) {
        if (rules.allowedRes[allowedKeys[i]].test(ch)) { ok = true; break }
      }
      if (!ok) {
        return { char: ch, charCode: ch.codePointAt(0), script: detectScript(ch, rules), sample: text.slice(0, 60) }
      }
    }
    return null
  } catch (e) {
    console.error('[llm-injection-filter] findBlockedChar error, passing delta through:', e && e.message)
    return null
  }
}

// ============================ 轨道 B：评分制规则 ============================

/** 逐 delta 快速扫描：CTRL / PROTO。命中规则名进入 hits。 */
function scanDelta(text, rules, cfg) {
  const slice = bounded(text || '', cfg)
  let ctrl = false
  let proto = false
  if (rules.ctrlRE.test(slice)) ctrl = true
  for (const re of rules.proto) {
    if (re.test(slice)) { proto = true; break }
  }
  const hits = []
  if (ctrl) hits.push('CTRL')
  if (proto) hits.push('PROTO')
  return { ctrl, proto, hits }
}

/** 统计文本中非 Latin/Han/Common 的脚本种类与字符数（SCRIPT 规则判定）。 */
function countMixedScripts(text, rules, cfg) {
  const slice = bounded(text || '', cfg)
  if (!HAS_NON_ASCII.test(slice)) return { mixed: false, count: 0, chars: 0, scripts: [] }
  const baseKeys = Object.keys(rules.baseRes)
  const mixKeys = Object.keys(rules.mixedRes)
  let nonBase = 0
  const found = new Set()
  for (const ch of slice) {
    let base = false
    for (let i = 0; i < baseKeys.length; i++) {
      if (rules.baseRes[baseKeys[i]].test(ch)) { base = true; break }
    }
    if (base) continue
    nonBase++
    if (found.size < 8) {
      let name = null
      for (let i = 0; i < mixKeys.length; i++) {
        if (rules.mixedRes[mixKeys[i]].test(ch)) { name = mixKeys[i]; break }
      }
      found.add(name || 'Other')
    }
    if (nonBase >= 8 && found.size >= 3) {
      return { mixed: true, count: found.size, chars: nonBase, scripts: [...found] }
    }
  }
  return { mixed: found.size >= 3 && nonBase >= 8, count: found.size, chars: nonBase, scripts: [...found] }
}

/**
 * block-end 全量评分（仅 tool-call 完整 arguments）。
 * CTRL=100；PROTO=100（命中 tool-call arguments 另 +30）；KW=40（仅加分，不单独触发）；
 * SCRIPT=80（≥3 种非 Latin/Han/Common 脚本且非基础字符 ≥8，且必须与 ≥1 个 PROTO/CTRL 同现才计入总分）。
 */
function evaluateBlock(fullArgs, rules, cfg) {
  const scan = scanDelta(fullArgs, rules, cfg)
  const kw = rules.kw.some((re) => re.test(bounded(fullArgs, cfg)))
  const mix = countMixedScripts(fullArgs, rules, cfg)
  const detected = []
  if (scan.ctrl) detected.push('CTRL')
  if (scan.proto) detected.push('PROTO')
  if (kw) detected.push('KW')
  if (mix.mixed) detected.push('SCRIPT')
  let score = 0
  const scoreParts = []
  if (scan.ctrl) { score += 100; scoreParts.push('CTRL') }
  if (scan.proto) { score += 100 + 30; scoreParts.push('PROTO') }
  if (kw && (scan.ctrl || scan.proto)) { score += 40; scoreParts.push('KW') }
  if (mix.mixed && (scan.ctrl || scan.proto)) { score += 80; scoreParts.push('SCRIPT') }
  return { score, scoreParts, detected, ctrl: scan.ctrl, proto: scan.proto, kw, mixed: mix.mixed, mixCount: mix.count, mixChars: mix.chars, scripts: mix.scripts }
}

/** 把命中子串替换为 [FILTERED:<n>]（只替换字符串值内部，保持 JSON 引号/结构不变）。 */
function replaceHits(text, rules, nextFilter, cfg) {
  const src = String(text)
  let head = src
  let tail = ''
  const max = Number.isFinite(cfg.maxScanLen) && cfg.maxScanLen > 0 ? cfg.maxScanLen : 16384
  if (src.length > max) { head = src.slice(0, max); tail = src.slice(max) }
  let count = 0
  const apply = (re) => {
    const g = new RegExp(re.source, re.flags.indexOf('g') >= 0 ? re.flags : re.flags + 'g')
    head = head.replace(g, () => { count++; return '[FILTERED:' + nextFilter() + ']' })
  }
  apply(rules.ctrlRE)
  for (const re of rules.proto) apply(re)
  return { text: head + tail, count }
}

function summarize(evalRes) {
  const rules = evalRes.scoreParts.slice(0, 4).join('+') || evalRes.detected.slice(0, 4).join('+') || '?'
  let extra = ''
  if (evalRes.scripts && evalRes.scripts.length) extra = ' scripts=' + evalRes.scripts.slice(0, 4).join(',')
  return 'score=' + evalRes.score + ' rules=' + rules + extra
}

// ============================ 中断机制 / 审计 ============================

/**
 * 轨道 A 命中时的终止性 finish chunk。
 * 不要直接 throw 普通 Error（会被包成 code:'UNKNOWN'）；yield error finish 后结束包装流，
 * agent loop 即按 turn error 终止（RESPONSE_FILTERED 不在默认可重试集合 → 不重试）。
 * message 必须人类可读（前端直接展示）：包含 provider/model/被阻断字符/样本截断/原因。
 */
function hardBlockFinish(options, bad, where) {
  const code = 'RESPONSE_FILTERED'
  const u = 'U+' + bad.charCode.toString(16).toUpperCase().padStart(4, '0')
  const message = '[RESPONSE_FILTERED] rare-script output blocked: character "' + bad.char + '" (' + u
    + ', script: ' + (bad.script || 'unknown') + ') in ' + where
    + '; provider=' + (options && options.provider ? options.provider : '?')
    + ', model=' + (options && options.model ? options.model : '?')
    + (options && options.sessionId ? ', sessionId=' + options.sessionId : '')
    + (bad.sample ? '; sample: ' + JSON.stringify(bad.sample) : '')
  const info = { kind: where, char: bad.char, charCode: bad.charCode, script: bad.script || 'unknown', sample: bad.sample }
  return { type: 'finish', reason: { kind: 'error', failure: { message, code, info } } }
}

/** 每次命中输出一行结构化审计日志（只提取标量；undefined 字段自动省略）。 */
function emitAudit(options, fields) {
  const entry = {
    provider: options && options.provider,
    model: options && options.model,
    sessionId: options && options.sessionId,
    callId: fields.callId,
    toolName: fields.toolName,
    rule: fields.rule,
    mode: fields.mode,
    score: fields.score,
    detail: fields.detail,
    sample: fields.sample,
  }
  console.error('[llm-injection-filter]', JSON.stringify(entry))
}

function isoTime() {
  try {
    if (typeof Date === 'function') return new Date().toISOString()
  } catch (e) { /* 忽略 */ }
  return undefined
}

/** 中断记录用的载荷截断（recordMaxLen，默认 8192）。 */
function payloadSlice(text, cfg) {
  const max = Number.isFinite(cfg.recordMaxLen) && cfg.recordMaxLen > 0 ? cfg.recordMaxLen : 8192
  const s = String(text)
  return s.length > max ? s.slice(0, max) : s
}

/**
 * 中断 agent loop 时的详细记录（结构化一行 JSON）：出现问题的请求身份 + 相应载荷详情。
 * 只提取标量/有界文本（delta 原文、已累积的 tool-call arguments 按 recordMaxLen 截断），
 * 不触碰 options.messages 等大型 live 对象；随 fiber 输出到结构化日志通道，不落盘。
 * @param options GenerateOptions（只读标量）
 * @param bad findBlockedChar 命中结果 {char, charCode, script, sample}
 * @param where 命中位置：'text' | 'tool-call arguments' | 'reasoning'
 * @param info 载荷详情 {kind, index?, callId?, toolName?, deltaText, deltaLength, accumulatedArguments?, accumulatedLength?}
 */
function recordInterrupt(options, bad, where, info, cfg) {
  const entry = {
    event: 'llm-stream-filtered',
    code: 'RESPONSE_FILTERED',
    time: isoTime(),
    request: {
      provider: options && options.provider,
      model: options && options.model,
      sessionId: options && options.sessionId,
      purpose: options && options.purpose,
    },
    block: info,
    char: bad.char,
    charCode: bad.charCode,
    script: bad.script || 'unknown',
    sample: bad.sample,
  }
  console.error('[llm-injection-filter][RECORD]', JSON.stringify(entry))
}

// ============================ 包装流 ============================

/**
 * guardStream：按 chunk.index 维护累积器 Map（仅轨道 B 需要）；每个 chunk 先过轨道 A 硬性
 * 检测（命中立即中断），再走轨道 B 逐 delta 扫描，block-end 对完整 tool-call arguments
 * 做全量评分 + 混合脚本检测后处置；处置后 yield（原样或改写后的）chunk。
 * 消费用 for await（自动转发取消/return 到底层 adapter 流）。
 */
async function* guardStream(raw, options, cfg, rules) {
  const c = { ...DEFAULTS, ...cfg }
  const accum = new Map()
  let filterSeq = 0
  const nextFilter = () => ++filterSeq
  const audit = (fields) => emitAudit(options, fields)
  try {
    for await (const chunk of raw) {
      try {
        if (!chunk || typeof chunk.type !== 'string') { yield chunk; continue }
        switch (chunk.type) {
          case 'text-delta': {
            if (c.hardBlockRareScripts) {
              const bad = findBlockedChar(chunk.text, rules)
              if (bad !== null) {
                recordInterrupt(options, bad, 'text', { kind: 'text', deltaText: payloadSlice(chunk.text, c), deltaLength: String(chunk.text).length }, c)
                audit({ rule: 'HARD_BLOCK', mode: c.mode, detail: { kind: 'text', char: bad.char, charCode: bad.charCode, script: bad.script, sample: bad.sample }, sample: bad.sample })
                yield hardBlockFinish(options, bad, 'text')
                return
              }
            }
            const scan = scanDelta(chunk.text, rules, c)
            if (scan.hits.length === 0) { yield chunk; continue }
            if (scan.ctrl) audit({ rule: 'CTRL', mode: c.mode, detail: { layer: 'delta', kind: 'text' }, sample: sampleOf(chunk.text, c) })
            if (scan.proto) audit({ rule: 'PROTO', mode: c.mode, detail: { layer: 'delta', kind: 'text' }, sample: sampleOf(chunk.text, c) })
            if (c.mode === 'strip' || c.mode === 'reject') {
              const r = replaceHits(chunk.text, rules, nextFilter, c)
              if (r.count > 0) { yield { ...chunk, text: r.text }; continue }
            }
            yield chunk
            continue
          }
          case 'tool-call-delta': {
            let acc = accum.get(chunk.index)
            if (!acc) { acc = { id: chunk.id, name: chunk.name, args: [] }; accum.set(chunk.index, acc) }
            else { if (chunk.id) acc.id = chunk.id; if (chunk.name !== undefined) acc.name = chunk.name }
            if (typeof chunk.argumentsDelta === 'string') acc.args.push(chunk.argumentsDelta)
            if (c.hardBlockRareScripts) {
              const bad = findBlockedChar(chunk.argumentsDelta, rules)
              if (bad !== null) {
                const joined = acc.args.join('')
                recordInterrupt(options, bad, 'tool-call arguments', {
                  kind: 'tool-call-arguments',
                  index: chunk.index,
                  callId: acc.id,
                  toolName: acc.name,
                  deltaText: payloadSlice(chunk.argumentsDelta, c),
                  deltaLength: String(chunk.argumentsDelta).length,
                  accumulatedArguments: payloadSlice(joined, c),
                  accumulatedLength: joined.length,
                }, c)
                audit({ rule: 'HARD_BLOCK', mode: c.mode, callId: acc.id, toolName: acc.name, detail: { kind: 'tool-call-arguments', char: bad.char, charCode: bad.charCode, script: bad.script, sample: bad.sample }, sample: bad.sample })
                yield hardBlockFinish(options, bad, 'tool-call arguments')
                return
              }
            }
            const scan = scanDelta(chunk.argumentsDelta, rules, c)
            if (scan.hits.length === 0) { yield chunk; continue }
            if (scan.ctrl) audit({ rule: 'CTRL', mode: c.mode, callId: acc.id, toolName: acc.name, detail: { layer: 'delta', kind: 'tool-call-arguments' }, sample: sampleOf(chunk.argumentsDelta, c) })
            if (scan.proto) audit({ rule: 'PROTO', mode: c.mode, callId: acc.id, toolName: acc.name, detail: { layer: 'delta', kind: 'tool-call-arguments' }, sample: sampleOf(chunk.argumentsDelta, c) })
            if (c.mode === 'strip') {
              const r = replaceHits(chunk.argumentsDelta, rules, nextFilter, c)
              if (r.count > 0) { yield { ...chunk, argumentsDelta: r.text }; continue }
            }
            yield chunk
            continue
          }
          case 'reasoning-delta': {
            if (c.checkReasoning && c.hardBlockRareScripts) {
              const bad = findBlockedChar(chunk.text, rules)
              if (bad !== null) {
                recordInterrupt(options, bad, 'reasoning', { kind: 'reasoning', deltaText: payloadSlice(chunk.text, c), deltaLength: String(chunk.text).length }, c)
                audit({ rule: 'HARD_BLOCK', mode: c.mode, detail: { kind: 'reasoning', char: bad.char, charCode: bad.charCode, script: bad.script, sample: bad.sample }, sample: bad.sample })
                yield hardBlockFinish(options, bad, 'reasoning')
                return
              }
            }
            const scan = scanDelta(chunk.text, rules, c)
            if (scan.hits.length > 0) {
              if (scan.ctrl) audit({ rule: 'CTRL', mode: c.mode, detail: { layer: 'delta', kind: 'reasoning' }, sample: sampleOf(chunk.text, c) })
              if (scan.proto) audit({ rule: 'PROTO', mode: c.mode, detail: { layer: 'delta', kind: 'reasoning' }, sample: sampleOf(chunk.text, c) })
            }
            yield chunk // reasoning 只 audit，永不改写
            continue
          }
          case 'block-end': {
            if (chunk.block && chunk.block.type === 'tool-call') {
              const acc = accum.get(chunk.index)
              const fullArgs = typeof chunk.block.arguments === 'string'
                ? chunk.block.arguments
                : (acc ? acc.args.join('') : '')
              if (acc && fullArgs.length > 0) {
                const ev = evaluateBlock(fullArgs, rules, c)
                const base = { callId: acc.id, toolName: acc.name, mode: c.mode, detail: { layer: 'block-end', kind: 'tool-call-arguments' }, sample: sampleOf(fullArgs, c) }
                if (ev.detected.indexOf('CTRL') >= 0) audit({ ...base, rule: 'CTRL', score: ev.score })
                if (ev.detected.indexOf('PROTO') >= 0) audit({ ...base, rule: 'PROTO', score: ev.score })
                if (ev.detected.indexOf('KW') >= 0) audit({ ...base, rule: 'KW', score: ev.score })
                if (ev.detected.indexOf('SCRIPT') >= 0) audit({ ...base, rule: 'SCRIPT', score: ev.score, detail: { layer: 'block-end', kind: 'tool-call-arguments', scripts: ev.scripts, mixChars: ev.mixChars } })
                if (c.mode === 'reject' && ev.score >= c.minScore && (ev.ctrl || ev.proto)) {
                  const rejected = JSON.stringify({ '$rejected': 'dsh-injection-filter', reason: summarize(ev) })
                  accum.delete(chunk.index)
                  yield { ...chunk, block: { ...chunk.block, arguments: rejected } }
                  continue
                }
                if (c.mode === 'strip' && (ev.ctrl || ev.proto)) {
                  const r = replaceHits(fullArgs, rules, nextFilter, c)
                  if (r.count > 0) {
                    accum.delete(chunk.index)
                    yield { ...chunk, block: { ...chunk.block, arguments: r.text } }
                    continue
                  }
                }
              }
            } else if (chunk.block && chunk.block.type === 'text' && c.mode !== 'audit') {
              // text 块在 block-end 是权威内容（替换累积 delta），strip/reject 都需同步改写
              const scan = scanDelta(chunk.block.text, rules, c)
              if (scan.hits.length > 0) {
                const r = replaceHits(chunk.block.text, rules, nextFilter, c)
                if (r.count > 0) { yield { ...chunk, block: { ...chunk.block, text: r.text } }; continue }
              }
            }
            accum.delete(chunk.index)
            yield chunk
            continue
          }
          default:
            yield chunk
        }
      } catch (e) {
        // 自身异常绝不炸流：放行该 chunk
        console.error('[llm-injection-filter] internal error, passing chunk through:', e && e.message)
        yield chunk
      }
    }
  } finally {
    accum.clear()
  }
}

// ============================ 插件入口 ============================

function apply(ctx) {
  const rules = compileRules(CFG)
  ctx.on('llm/stream', (options, next) => {
    if (!CFG.enabled) return next()
    if (Array.isArray(CFG.applyToProviders) && CFG.applyToProviders.length > 0
      && (!options || !options.provider || CFG.applyToProviders.indexOf(options.provider) < 0)) return next()
    const raw = next()
    return guardStream(raw, options || {}, CFG, rules)
  })
}

return { apply, CFG }
