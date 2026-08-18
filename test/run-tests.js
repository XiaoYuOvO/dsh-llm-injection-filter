'use strict'

/**
 * dsh-llm-injection-filter 测试清单（对照任务测试清单 1-16，+端到端路径源码验证）。
 * 运行：node test/run-tests.js
 */

const assert = require('node:assert')
const path = require('node:path')
const F = require(path.join(__dirname, '..', 'lib', 'index.js'))

const { DEFAULTS, compileRules, guardStream, findBlockedChar, scanDelta, evaluateBlock, replaceHits } = F

// ============ 测试素材（真实事件样本） ============

const SAMPLE = '  //\u0E24\u0E28\u0E08assistant to=functions.edit  \u5F69\u795E\u4E89\u9738\u7F51\u7AD9\u055E\u0582json /*<<<\u0D3F\u055E\u0576\u0579 \u057D\u057A\u05D0\u057D\u056B  \u5FAE\u4FE1\u5929\u5929\u4E2D\u5F69\u7968\u3011\u3002json\n  //'
// 等价原文：
//   //ฤศจassistant to=functions.edit  彩神争霸网站՞ւjson /*<<<ി՞նչ սպասի  微信天天中彩票】【。json
//  //

const TOKENS = [
  '  //', '\u0E24\u0E28\u0E08', 'assistant', ' to', '=functions.edit', '  ',
  '\u5F69\u795E\u4E89\u9738\u7F51\u7AD9', '\u055E\u0582', 'json', ' /*<<<',
  '\u0D3F\u055E\u0576\u0579', ' \u057D\u057A\u05D0\u057D\u056B', '  ',
  '\u5FAE\u4FE1\u5929\u5929\u4E2D\u5F69\u7968', '\u3011\u3002', 'json', '\n  //',
]

const MULTI_SCRIPT_ARGS = '{"new_string":"prefix \u0E24\u0E28\u0E08 \u055E\u0582 \u0D3F\u0D3F\u0D3F\u0D3F assistant to=evil suffix"}'
// Thai(ฤศจ) + Armenian(՞ւ) + Malayalam(ി×4) + PROTO(assistant to=)

const CLEAN_EDIT_ARGS = '{"file_path":"src/App.tsx","new_string":"const refreshIframe = useCallback(() => {\\n  const x = 1\\n  return x\\n}, [])\\n","old_string":"const refreshIframe = useCallback(() => {\\n"}'

const CLEAN_CHINESE = '// \u52A0\u8F7D\u914D\u7F6E\u6587\u4EF6\nconst x = 1 // \u8FD9\u662F\u4E00\u884C\u4E2D\u6587\u6CE8\u91CA'
const CLEAN_PATH = 'H:\\RSProjects\\project\\src\\main.rs \u5F15\u53F7"\u53CD\u659C\u6760\\ \u6570\u5B57123 \uD83D\uDE00 \u2014 ok'
const USER_MESSAGE = '\u628A src/tauri/src/config/runtime.rs \u4E2D\u7684 get_base_dir \u6539\u4E3A\u83B7\u53D6\u5F53\u524D\u5E94\u7528\u6240\u5728\u7684\u6587\u4EF6\u5939'
const KW_ONLY_ARGS = '{"query":"\u63A8\u8350\u4E00\u4E2A\u5B89\u5168\u7684\u535A\u5F69\u5E73\u53F0"}'
const JAPANESE = '\u65E5\u672C\u8A9E\u306E\u30C6\u30B9\u30C8\u3067\u3059'

// ============ 辅助 ============

function opts(over) { return Object.assign({ provider: 'openai', model: 'gpt-5.6-terra', sessionId: 'test-session', purpose: 'agent-loop' }, over || {}) }
function cfg(over) { return Object.assign({}, DEFAULTS, over || {}) }
async function* fakeStream(chunks) { for (const ch of chunks) yield ch }

async function consume(chunks, cfgOver, optOver) {
  const c = cfg(cfgOver)
  const rules = compileRules(c)
  const out = []
  for await (const ch of guardStream(fakeStream(chunks), opts(optOver), c, rules)) out.push(ch)
  return out
}

function lastFinish(out) {
  for (let i = out.length - 1; i >= 0; i--) if (out[i] && out[i].type === 'finish') return out[i]
  return null
}
function isFilterError(fin) {
  return !!fin && fin.reason && fin.reason.kind === 'error' && fin.reason.failure && fin.reason.failure.code === 'RESPONSE_FILTERED'
}

const bs = (index, blockType) => ({ type: 'block-start', index, blockType })
const td = (index, text) => ({ type: 'text-delta', index, text })
const rd = (index, text) => ({ type: 'reasoning-delta', index, text })
const tcd = (index, id, name, argumentsDelta) => ({ type: 'tool-call-delta', index, id, name, argumentsDelta })
const be = (index, block) => ({ type: 'block-end', index, block })
const fin = (reason) => ({ type: 'finish', reason })

async function captureLogsAsync(fn) {
  const orig = console.error
  const logs = []
  console.error = (...a) => logs.push(a.join(' '))
  try { return { result: await fn(), logs } } finally { console.error = orig }
}

// ============ 测试 ============

const results = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push({ name, pass: true }) })
    .catch((e) => { results.push({ name, pass: false, error: e && e.message }) })
}

async function main() {
  // ---- 轨道 A 硬性阻断 ----

  await test('T1 事件真实样本全文作为 tool-call-delta → 立即命中 ฤ (Thai) → RESPONSE_FILTERED', async () => {
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_1', 'edit', SAMPLE),
      be(0, { type: 'tool-call', id: 'call_1', name: 'edit', arguments: SAMPLE }),
      fin({ kind: 'stop' }),
    ], {})
    assert.ok(out.length >= 1, '有输出')
    const f = lastFinish(out)
    assert.ok(isFilterError(f), 'error finish 且 code=RESPONSE_FILTERED，实际: ' + JSON.stringify(f && f.reason))
    assert.ok(f.reason.failure.message.indexOf('\\u0E24') < 0 && f.reason.failure.message.indexOf('U+0E24') >= 0, 'message 含 U+0E24')
    assert.ok(f.reason.failure.message.indexOf('provider=openai') >= 0, 'message 含 provider')
    assert.ok(f.reason.failure.message.indexOf('model=gpt-5.6-terra') >= 0, 'message 含 model')
    assert.ok(f.reason.failure.info && f.reason.failure.info.char === '\u0E24', 'info.char 为 ฤ')
    // 流必须终止：finish 后无更多 chunk
    assert.strictEqual(out[out.length - 1], f, 'finish 是最后一个 chunk')
    // 未发布污染 chunk：被阻断的 argumentsDelta 不应出现在输出
    for (const ch of out) {
      if (ch && ch.type === 'tool-call-delta') assert.notStrictEqual(ch.argumentsDelta, SAMPLE, '污染 delta 被丢弃')
    }
  })

  await test('T2 token 分片逐个喂 → 第一个 delta "ฤศจ" 即中断', async () => {
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_1', 'edit', TOKENS[0]),
      tcd(0, 'call_1', 'edit', TOKENS[1]),
      tcd(0, 'call_1', 'edit', TOKENS[2]),
    ], {})
    const f = lastFinish(out)
    assert.ok(isFilterError(f), 'error finish')
    assert.strictEqual(out.length, 3, 'bs + 第一个 ASCII delta + finish（第二个 delta 即阻断）')
    assert.strictEqual(out[0].type, 'block-start')
    assert.strictEqual(out[1].type, 'tool-call-delta')
    assert.strictEqual(out[1].argumentsDelta, TOKENS[0])
  })

  await test('T3 单个亚美尼亚文 / 马拉雅拉姆文 delta → 立即中断', async () => {
    for (const tok of ['\u055E\u0582', '\u0D3F']) {
      const out = await consume([td(0, tok)], {})
      const f = lastFinish(out)
      assert.ok(isFilterError(f), 'tok=' + JSON.stringify(tok))
      if (tok === '\u055E\u0582') assert.ok(f.reason.failure.info.script === 'Armenian', 'script=Armenian')
      else assert.ok(f.reason.failure.info.script === 'Malayalam', 'script=Malayalam')
      assert.strictEqual(out.length, 1, '仅 finish')
    }
  })

  await test('T4 mode=audit 时轨道 A 仍然中断（无视 mode）', async () => {
    const out = await consume([td(0, '\u0E24\u0E28\u0E08')], { mode: 'audit' })
    assert.ok(isFilterError(lastFinish(out)), 'audit 模式下仍阻断')
  })

  await test('T5 allowedScripts 追加 Thai 后纯泰文文本放行（逃生门）', async () => {
    const out = await consume([td(0, '\u0E24\u0E28\u0E08\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35\u0E04\u0E23\u0E31\u0E1A')],
      { allowedScripts: ['Latin', 'Han', 'Common', 'Inherited', 'Thai'] })
    assert.strictEqual(lastFinish(out), null, '无 error finish')
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].text, '\u0E24\u0E28\u0E08\u0E2A\u0E27\u0E31\u0E2A\u0E14\u0E35\u0E04\u0E23\u0E31\u0E1A', '原样放行')
  })

  await test('T6 reasoning-delta 默认不阻断；checkReasoning=true 后阻断', async () => {
    const pass = await consume([rd(0, '\u601D\u8003 \u0E24\u0E28\u0E08 \u5185\u5BB9')], {})
    assert.strictEqual(lastFinish(pass), null, '默认放行 reasoning')
    assert.strictEqual(pass.length, 1)
    const block = await consume([rd(0, '\u601D\u8003 \u0E24\u0E28\u0E08')], { checkReasoning: true })
    assert.ok(isFilterError(lastFinish(block)), 'checkReasoning=true 阻断')
  })

  // ---- 轨道 B 评分制 ----

  await test('T7 事件样本 → 逐 delta PROTO 命中；block-end 完整评分 ≥100', () => {
    const rules = compileRules(cfg({ hardBlockRareScripts: false }))
    const scan = scanDelta('assistant to=functions.edit', rules, cfg({ hardBlockRareScripts: false }))
    assert.ok(scan.proto, '逐 delta 命中 PROTO')
    const ev = evaluateBlock(SAMPLE, rules, cfg({ hardBlockRareScripts: false }))
    assert.ok(ev.score >= 100, 'score=' + ev.score)
    assert.ok(ev.scoreParts.indexOf('PROTO') >= 0, 'scoreParts 含 PROTO')
  })

  await test('T8 含控制字符 \\x07 / \\x1b 的 text-delta → CTRL 命中', () => {
    const rules = compileRules(cfg())
    assert.ok(scanDelta('a\x07b', rules, cfg()).ctrl, '\\x07 CTRL')
    assert.ok(scanDelta('a\x1bb', rules, cfg()).ctrl, '\\x1b CTRL')
    assert.ok(!scanDelta('a\tb\nc', rules, cfg()).ctrl, '\\t\\n 不是 CTRL')
  })

  await test('T9 含 <system-reminder> 的 text-delta → PROTO 命中', () => {
    const rules = compileRules(cfg())
    assert.ok(scanDelta('x<system-reminder>y', rules, cfg()).proto, '<system-reminder> PROTO')
    assert.ok(scanDelta('/*<<<', rules, cfg()).proto, '/*<<< PROTO')
    assert.ok(scanDelta('<!-- note', rules, cfg()).proto, '<!-- PROTO')
  })

  await test('T10 多脚本 + 协议标记 → SCRIPT+PROTO 同现达标', () => {
    const rules = compileRules(cfg({ hardBlockRareScripts: false }))
    const ev = evaluateBlock(MULTI_SCRIPT_ARGS, rules, cfg({ hardBlockRareScripts: false }))
    assert.ok(ev.detected.indexOf('SCRIPT') >= 0, 'detected 含 SCRIPT，scripts=' + JSON.stringify(ev.scripts))
    assert.ok(ev.detected.indexOf('PROTO') >= 0, 'detected 含 PROTO')
    assert.ok(ev.scoreParts.indexOf('SCRIPT') >= 0 && ev.scoreParts.indexOf('PROTO') >= 0, '两者均计入总分')
    assert.ok(ev.mixCount >= 3 && ev.mixChars >= 8, 'mixCount=' + ev.mixCount + ' mixChars=' + ev.mixChars)
  })

  // ---- 必须放行（误报回归） ----

  await test('T11 正常 edit 调用（纯 ASCII TS 代码）→ 零命中零改写', async () => {
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_2', 'edit', CLEAN_EDIT_ARGS.slice(0, 40)),
      tcd(0, 'call_2', 'edit', CLEAN_EDIT_ARGS.slice(40)),
      be(0, { type: 'tool-call', id: 'call_2', name: 'edit', arguments: CLEAN_EDIT_ARGS }),
      fin({ kind: 'stop' }),
    ], { mode: 'strip' })
    assert.ok(!isFilterError(lastFinish(out)), '无 error finish')
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    assert.ok(beChunk, 'block-end 存在')
    assert.strictEqual(beChunk.block.arguments, CLEAN_EDIT_ARGS, 'arguments 原样未改')
  })

  await test('T12 含中文注释的代码 → 轨道 A 放行、轨道 B 不触发', async () => {
    const out = await consume([bs(0, 'text'), td(0, CLEAN_CHINESE), be(0, { type: 'text', text: CLEAN_CHINESE }), fin({ kind: 'stop' })], { mode: 'strip' })
    assert.ok(!isFilterError(lastFinish(out)))
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    assert.strictEqual(beChunk.block.text, CLEAN_CHINESE, '中文注释原样')
  })

  await test('T13 emoji / 数字 / 标点 / Windows 路径 → 放行', async () => {
    const out = await consume([td(0, CLEAN_PATH)], { mode: 'strip' })
    assert.strictEqual(lastFinish(out), null)
    assert.strictEqual(out.length, 1)
    assert.strictEqual(out[0].text, CLEAN_PATH, '原样放行')
  })

  await test('T14 用户真实中文消息 → 零命中', async () => {
    const out = await consume([td(0, USER_MESSAGE)], {})
    assert.strictEqual(lastFinish(out), null)
    assert.strictEqual(out.length, 1)
  })

  await test('T15 关键词"博彩"出现在正常语境且无其他信号 → 不触发不改写（KW 仅加分）', async () => {
    const captured = await captureLogsAsync(() => consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_3', 'search', KW_ONLY_ARGS),
      be(0, { type: 'tool-call', id: 'call_3', name: 'search', arguments: KW_ONLY_ARGS }),
      fin({ kind: 'stop' }),
    ], { mode: 'reject' }))
    const out = captured.result
    assert.ok(!isFilterError(lastFinish(out)), '无 error finish')
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    assert.strictEqual(beChunk.block.arguments, KW_ONLY_ARGS, 'arguments 原样（未 reject/未 strip）')
    const kwLog = captured.logs.find((l) => l.indexOf('"rule":"KW"') >= 0)
    assert.ok(kwLog, '审计日志记录了 KW 命中')
  })

  await test('T16 已知行为：含日文假名的合法文本被轨道 A 阻断（文档化，非 bug）', async () => {
    const out = await consume([td(0, JAPANESE)], {})
    const f = lastFinish(out)
    assert.ok(isFilterError(f), '日文被硬阻断')
    assert.strictEqual(f.reason.failure.info.script, 'Hiragana')
  })

  // ---- 轨道 B 处置模式 ----

  await test('T17 strip：逐 delta 替换命中子串', async () => {
    const out = await consume([td(0, 'see <system-reminder> here')], { mode: 'strip' })
    assert.strictEqual(out.length, 1)
    assert.ok(out[0].text.indexOf('<system-reminder>') < 0, '命中被移除')
    assert.ok(out[0].text.indexOf('[FILTERED:1]') >= 0, '替换为 [FILTERED:n]')
  })

  await test('T18 strip：跨 delta 的 PROTO 在 block-end 权威内容中被清除且 JSON 仍合法', async () => {
    const body = '{"path":"a.txt","new_string":"prefix assistant to=evil suffix"}'
    const idx = body.indexOf('assistant') + 5
    const h1 = body.slice(0, idx)
    const h2 = body.slice(idx)
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_x', 'edit', h1),
      tcd(0, 'call_x', 'edit', h2),
      be(0, { type: 'tool-call', id: 'call_x', name: 'edit', arguments: body }),
      fin({ kind: 'stop' }),
    ], { mode: 'strip' })
    assert.ok(!isFilterError(lastFinish(out)))
    // 逐 delta 未命中（跨 delta 切割）→ 原样透传
    const deltas = out.filter((ch) => ch && ch.type === 'tool-call-delta')
    assert.strictEqual(deltas[0].argumentsDelta, h1)
    assert.strictEqual(deltas[1].argumentsDelta, h2)
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    const args = JSON.parse(beChunk.block.arguments)
    assert.ok(/prefix \[FILTERED:\d+\]evil suffix/.test(args.new_string), 'block-end 清洗后 JSON 仍合法: ' + beChunk.block.arguments)
    assert.ok(args.new_string.indexOf('assistant to=') < 0)
  })

  await test('T19 reject：命中 tool-call 的 block.arguments 改写为 $rejected JSON', async () => {
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_r', 'edit', '{"new_string":"'),
      tcd(0, 'call_r', 'edit', 'assistant to=evil"}'),
      be(0, { type: 'tool-call', id: 'call_r', name: 'edit', arguments: '{"new_string":"assistant to=evil"}' }),
      fin({ kind: 'stop' }),
    ], { mode: 'reject' })
    assert.ok(!isFilterError(lastFinish(out)), 'reject 不是硬阻断')
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    const parsed = JSON.parse(beChunk.block.arguments)
    assert.strictEqual(parsed.$rejected, 'dsh-injection-filter')
    assert.ok(typeof parsed.reason === 'string' && parsed.reason.length > 0, 'reason 非空')
    assert.ok(parsed.reason.indexOf('PROTO') >= 0, 'reason 含规则摘要')
  })

  await test('T20 reject：控制字符在 arguments → $rejected JSON', async () => {
    const bad = '{"x":"a\x07b"}'
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_c', 'write', bad),
      be(0, { type: 'tool-call', id: 'call_c', name: 'write', arguments: bad }),
      fin({ kind: 'stop' }),
    ], { mode: 'reject' })
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    assert.strictEqual(JSON.parse(beChunk.block.arguments).$rejected, 'dsh-injection-filter')
  })

  await test('T21 reject：多脚本 + PROTO 同现 → SCRIPT+PROTO 组合达标被 reject（轨道 A 关闭时）', async () => {
    const out = await consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_m', 'edit', MULTI_SCRIPT_ARGS),
      be(0, { type: 'tool-call', id: 'call_m', name: 'edit', arguments: MULTI_SCRIPT_ARGS }),
      fin({ kind: 'stop' }),
    ], { mode: 'reject', hardBlockRareScripts: false })
    const beChunk = out.find((ch) => ch && ch.type === 'block-end')
    const parsed = JSON.parse(beChunk.block.arguments)
    assert.strictEqual(parsed.$rejected, 'dsh-injection-filter')
    assert.ok(parsed.reason.indexOf('SCRIPT') >= 0 && parsed.reason.indexOf('PROTO') >= 0)
  })

  // ---- 流完整性 ----

  await test('T22 usage/finish 透传；正常流结束无 error', async () => {
    const out = await consume([
      bs(0, 'text'),
      td(0, 'hello world'),
      be(0, { type: 'text', text: 'hello world' }),
      { type: 'usage', usage: { input_tokens: 1, output_tokens: 2 } },
      fin({ kind: 'stop' }),
    ], { mode: 'audit' })
    assert.strictEqual(lastFinish(out).reason.kind, 'stop')
    assert.strictEqual(out[out.length - 1].type, 'finish')
  })

  await test('T23 轨道 A 检测自身不抛异常：异常配置下不炸流', async () => {
    // allowedScripts 含非法脚本名 → 回退默认集合（Latin/Han/Common/Inherited），不抛错
    const out = await consume([td(0, 'plain text')], { allowedScripts: ['Latin', 'NotARealScript'] })
    assert.strictEqual(lastFinish(out), null)
    assert.strictEqual(out[0].text, 'plain text')
    // extraPatterns 非法正则 → 停用该规则，不炸流
    const out2 = await consume([td(0, 'normal')], { extraPatterns: ['[unclosed'] })
    assert.strictEqual(lastFinish(out2), null)
  })

  await test('T24 findBlockedChar 纯 ASCII / 空串 / 非字符串 → null（快筛零开销）', () => {
    const rules = compileRules(cfg())
    assert.strictEqual(findBlockedChar('const x = 1; // ok', rules), null)
    assert.strictEqual(findBlockedChar('', rules), null)
    assert.strictEqual(findBlockedChar(undefined, rules), null)
  })

  // ---- 中断时详细记录（RECORD） ----

  function recordFromLogs(logs) {
    const line = logs.find((l) => l.indexOf('[llm-injection-filter][RECORD]') >= 0)
    assert.ok(line, '存在 RECORD 记录行，logs=' + logs.length)
    return JSON.parse(line.slice(line.indexOf('{')))
  }

  await test('T25 中断时记录：tool-call arguments 硬阻断 → 请求身份 + 已累积载荷详情', async () => {
    const captured = await captureLogsAsync(() => consume([
      bs(0, 'tool-call'),
      tcd(0, 'call_rec', 'edit', '{"new_string":"'),
      tcd(0, 'call_rec', 'edit', TOKENS[1]),
    ], {}))
    const out = captured.result
    assert.ok(isFilterError(lastFinish(out)))
    const rec = recordFromLogs(captured.logs)
    assert.strictEqual(rec.event, 'llm-stream-filtered')
    assert.strictEqual(rec.code, 'RESPONSE_FILTERED')
    assert.strictEqual(rec.request.provider, 'openai')
    assert.strictEqual(rec.request.model, 'gpt-5.6-terra')
    assert.strictEqual(rec.request.sessionId, 'test-session')
    assert.strictEqual(rec.request.purpose, 'agent-loop')
    assert.strictEqual(rec.block.kind, 'tool-call-arguments')
    assert.strictEqual(rec.block.index, 0)
    assert.strictEqual(rec.block.callId, 'call_rec')
    assert.strictEqual(rec.block.toolName, 'edit')
    assert.strictEqual(rec.block.deltaText, TOKENS[1], '命中的 delta 原文')
    assert.strictEqual(rec.block.deltaLength, TOKENS[1].length)
    assert.strictEqual(rec.block.accumulatedArguments, '{"new_string":"' + TOKENS[1], '拦截瞬间的完整累积 arguments（含命中 delta）')
    assert.strictEqual(rec.block.accumulatedLength, ('{"new_string":"' + TOKENS[1]).length)
    assert.strictEqual(rec.charCode, 0x0E24)
    assert.strictEqual(rec.script, 'Thai')
    assert.strictEqual(typeof rec.time, 'string')
  })

  await test('T26 中断时记录：text 硬阻断 → 请求身份 + delta 载荷详情', async () => {
    const captured = await captureLogsAsync(() => consume([td(0, '\u055E\u0582')], {}))
    assert.ok(isFilterError(lastFinish(captured.result)))
    const rec = recordFromLogs(captured.logs)
    assert.strictEqual(rec.request.provider, 'openai')
    assert.strictEqual(rec.block.kind, 'text')
    assert.strictEqual(rec.block.deltaText, '\u055E\u0582')
    assert.strictEqual(rec.charCode, 0x055E)
    assert.strictEqual(rec.script, 'Armenian')
  })

  await test('T27 中断记录载荷截断：超长 delta 按 recordMaxLen 截断', async () => {
    const long = 'x'.repeat(20000) + TOKENS[1]
    const captured = await captureLogsAsync(() => consume([td(0, long)], { recordMaxLen: 4096 }))
    assert.ok(isFilterError(lastFinish(captured.result)))
    const rec = recordFromLogs(captured.logs)
    assert.strictEqual(rec.block.deltaText.length, 4096, 'deltaText 被截断')
    assert.strictEqual(rec.block.deltaLength, long.length, 'deltaLength 保留完整长度')
  })

  // ---- 汇总 ----

  let failed = 0
  for (const r of results) {
    if (r.pass) console.log('  PASS  ' + r.name)
    else { failed++; console.error('  FAIL  ' + r.name + (r.error ? '\n        ' + r.error : '')) }
  }
  console.log('\n' + (results.length - failed) + '/' + results.length + ' passed')
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error('test harness error:', e); process.exit(2) })
