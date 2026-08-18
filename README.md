# dsh-llm-injection-filter

DeepSeek Harness 的 **LLM 响应流注入过滤器**：在模型流式响应进入 agent 之前，实时检测疑似提示词注入 / 污染内容并处置。挂载于 `llm/stream` waterfall，对所有适配器生效，不改动任何运行时源码。

## 背景动机（真实安全事件）

一个 coding agent 会话（`gpt-5.6-terra` / `openai` / OpenAI Responses API）中，模型在生成 `edit` 工具的 `new_string` 参数时，于正常代码之后无缝接续输出了一段注入式载荷并被逐字写入源码、进入 Git 历史。污染样本：

```
  //ฤศจassistant to=functions.edit  彩神争霸网站՞ւjson /*<<<ി՞նչ սպասի  微信天天中彩票】【。json
  //
```

特征：协议控制标记（`assistant to=`、`/*<<<`、`json` 碎片）、垃圾广告语义（博彩）、多语种混淆（泰文/亚美尼亚文/马拉雅拉姆文）。

**关键教训**：主载荷是普通 ASCII（`assistant to=`），纯"特殊字符"检测不够；且模型输出是 token 粒度分片（`"ฤศจ"` `"assistant"` `" to"` …），单个 delta 往往太短无法综合判断。因此：

- **轨道 A**（罕见脚本）恰好可以**逐 delta 立即命中**（`"ฤศจ"` 单独一个 delta 就含泰文）→ 硬性中断；
- **轨道 B**（评分制）必须**累积到完整 tool-call arguments（block-end）再评分**处置。

## 两条轨道

### 轨道 A：罕见脚本硬性阻断（默认开启，最高优先级）

- 模型输出中出现**任何一个不属于允许脚本集合**的 Unicode 字符 → **立即中断**（不等 block-end、不参与评分、无视 `mode` 取值）。
- 允许脚本集合（默认）：`Latin`、`Han`、`Common`、`Inherited`。
- 检测含性能快筛：纯 ASCII（`/[^\x00-\x7F]/`）直接放行，零逐字符开销。
- 触发即中断：丢弃未发布 chunk，yield 一个终止性 error `finish` chunk（`code=RESPONSE_FILTERED`），关闭底层 adapter 流，结束包装流。
- **为什么能中断 agent turn（已从源码确认）**：
  1. agent loop 消费完流后检查 `assembler.finish`，`finish.kind === 'error'` 分支先于消息组装执行（不落 assistant/message）；
  2. 进入 `agent/request-error` waterfall（`dsh-llm-retry` 检查 `failure.code`）：`RESPONSE_FILTERED` 不在默认可重试集合（`EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT`）→ 不自动重试；
  3. agent loop `throw new LlmError(message, code, failure)` → `turn/end { reason: { kind: 'error', ... } }` → 该 turn 立即终止，agent 回到 idle；
  4. 前端 `dsh-client-ui-conversation` 专门渲染 `turn/end reason.kind==='error'` 错误横幅——`failure.message` 即用户可见错误文本（含 provider/model/被阻断字符/样本/原因）。

### 轨道 B：评分制规则（audit / strip / reject）

| 规则 | 判定 | 权重 | 应用层 |
|---|---|---|---|
| CTRL 控制字符 | `[\x00-\x08\x0b-\x1f\x7f]` | 100 | 逐 delta（text/args） |
| PROTO 协议标记 | `assistant to=`、`/*<<<`、`<system-reminder>`、`<compacted-checkpoint>`、`<!--`、`[system]`/`[instruction]` | 100 | 逐 delta + block-end |
| SCRIPT 混合脚本 | arguments 中非 Latin/Han/Common 脚本 **≥3 种且非基础字符 ≥8** | 80 | 仅 block-end 完整 arguments |
| KW 垃圾关键词 | 彩神/争霸/天天中彩票/博彩/casino/gambling/betting | 40 | block-end |
| 组合加成 | PROTO 命中且发生在 **tool-call arguments**（可执行面） | +30 | block-end |

- 总分 ≥ `minScore`(100) 触发。KW 永不单独触发（仅加分）；SCRIPT 必须与 ≥1 个 PROTO/CTRL 同现才计入总分。
- 处置模式：
  - `audit`：只记录一行结构化日志，不改动输出；
  - `strip`：命中子串替换为 `[FILTERED:<n>]`（只替换字符串值内部，保持 JSON 引号/结构不变；逐 delta 与 block-end 权威内容同步改写）；
  - `reject`：block-end 把命中 tool-call 的 `block.arguments` 改写为 `{"$rejected":"dsh-injection-filter","reason":"<摘要>"}`（缺必需字段 → 工具 schema 校验失败 → `INVALID_ARGS` 返回模型，模型可自我纠正）；text 命中替换为 `[FILTERED:<n>]`；reasoning 只 audit。
- 轨道 A 与 B 独立、同时生效；A 命中时不做 strip/reject，直接中断。

## 配置

```js
const CFG = {
  enabled: true,                 // 总开关
  hardBlockRareScripts: true,    // 轨道 A：罕见脚本 → 直接中断（最高优先级，无视 mode）
  allowedScripts: ['Latin', 'Han', 'Common', 'Inherited'], // 允许脚本白名单，可追加 'Thai' 等放行
  checkReasoning: false,         // 是否对 reasoning-delta 也做轨道 A 检测（默认关）
  mode: 'audit',                 // 轨道 B：'audit' | 'strip' | 'reject'
  minScore: 100,                 // 轨道 B 触发阈值
  applyToProviders: [],          // 空 = 全部 provider；可填 ['openai']
  extraPatterns: [],             // 额外正则字符串（编译失败捕获并报错，停用该规则，不炸流）
  extraKeywords: [],             // 额外关键词
  maxScanLen: 16384,             // 轨道 B 单段扫描长度上限
  maxSampleLen: 120,             // 审计样本截断长度
  recordMaxLen: 8192,            // 中断记录中载荷详情（delta / 已累积 arguments）的截断长度
}
```

## 审计日志

每次命中输出一行结构化日志（`console.error`）：

```
[llm-injection-filter] {"provider":"openai","model":"gpt-5.6-terra","sessionId":"...","callId":"call_1","toolName":"edit","rule":"HARD_BLOCK","mode":"audit","score":210,"detail":{...},"sample":"..."}
```

`rule` ∈ `HARD_BLOCK | CTRL | PROTO | SCRIPT | KW`；只提取标量，`sample` 截断 ≤ `maxSampleLen`。

## 中断时详细记录（RECORD）

**轨道 A 命中、需要中断 agent loop 时**，除上述紧凑审计行外，额外输出一条结构化 RECORD 行，包含**出现问题的请求身份**与**相应载荷的详细信息**（取证用）：

```
[llm-injection-filter][RECORD] {"event":"llm-stream-filtered","code":"RESPONSE_FILTERED","time":"<ISO8601>","request":{"provider":"openai","model":"gpt-5.6-terra","sessionId":"...","purpose":"agent-loop"},"block":{"kind":"tool-call-arguments","index":0,"callId":"call_1","toolName":"edit","deltaText":"<命中 delta 原文，截断>","deltaLength":<完整长度>,"accumulatedArguments":"<拦截瞬间已累积的完整 arguments，截断>","accumulatedLength":<完整长度>},"char":"<被阻断字符>","charCode":<U+ 码点>,"script":"Thai","sample":"<样本截断>"}
```

- `block.kind` ∈ `text | tool-call-arguments | reasoning`；tool-call 场景额外携带 `index/callId/toolName/accumulatedArguments`（拦截瞬间的完整载荷，含命中 delta 本身）。
- 载荷详情按 `recordMaxLen` 截断（`deltaLength` / `accumulatedLength` 保留完整长度）；只提取标量/有界文本，不触碰 `options.messages` 等大型 live 对象；不落盘，随插件 fiber 输出到结构化日志通道。

## 已知取舍（文档化）

- **默认允许集合不含日文（假名）/韩文（谚文）/俄文（西里尔）等**，含这些脚本的合法输出也会被硬阻断。这是刻意设计的极端严格语义（宁可误杀，不可放过）；逃生门是 `allowedScripts` 配置（如追加 `'Thai'` 放行泰文）。
- `maxScanLen` 只约束轨道 B 的逐段扫描/替换（超出部分原样保留、不处理）；轨道 A 不设上限（快筛优先，宁可慢，不可放过）。
- `reject` 模式依赖 block-end 携带完整 arguments 做整块改写；极少数不发 block-end 的 delta-only 流中 tool-call 参数无法整块改写（原样透传，仅审计）。
- 轨道 A 检测自身绝不抛异常（try/catch 包裹，异常时放行该 delta）；规则编译失败在 apply 时即报错并停用该规则。

## 交付形态

- **动态插件**：`code.host` 即本源码（纯 JS、无 import、顶层常量配置），`return { apply, CFG }` 收尾；`ctx.on('llm/stream', ...)` 注册的监听器随插件 fiber 自动清理，停止/卸载零残留（无定时器/全局订阅）。
- **npm 包**：`lib/index.js`（本文件）+ `package.json`，`module.exports = { apply, CFG, ... }`；Node ≥18。

## 正式安装（web profile，官方 CLI）

包声明了 `dsh.bundle.patch`（`cordis.patch.yml`），`dsh plugin` 的 bundle 协调会自动把它加进
`dsh.profile.bundles`，下次启动即随 host 组合挂载（对所有会话的 `llm/stream` 生效）。

```powershell
# 路径含空格需用 8.3 短路径（cmd 批处理转发会吞掉空格段）
dsh plugin --profile web add "link:G:/DEEPSE~1/data/dsh/plugins/LLM-IN~1"
# 验证：组合树中应出现 id: llm-injection-filter / name: dsh-llm-injection-filter
dsh --profile web --dump-config
```

安装后：
- `profiles\web\package.json` → `dependencies` 增加 `"dsh-llm-injection-filter": "link:G:/DEEPSE~1/data/dsh/plugins/LLM-IN~1"`；
  `dsh.profile.bundles` 末尾自动追加 `"dsh-llm-injection-filter"`。
- `profiles\web\node_modules\dsh-llm-injection-filter` → Junction 指向源码目录（改源码即生效，下次重启加载）。
- **重启 DSH 后生效**；重启前由会话内动态插件（`injf-1`）继续覆盖。

## 从 GitHub 一键安装（推上 GitHub 后）

仓库根目录 = **包根目录**（`package.json` 必须在仓库根）。包无构建脚本、无运行时依赖 →
安装无 `allowBuilds` 拦截、无 peer 警告。推上公开 GitHub 后，一条命令完成安装 + 挂载：

```powershell
# 默认分支
dsh plugin --profile web add github:XiaoYuOvO/dsh-llm-injection-filter
# 指定分支/提交/tag（可选）
dsh plugin --profile web add github:XiaoYuOvO/dsh-llm-injection-filter#main
# 按 tag 安装（推荐，锁定已验证版本）
dsh plugin --profile web add github:XiaoYuOvO/dsh-llm-injection-filter#v1.0.0
```

原理：`dsh plugin` 把参数转发给 pnpm（原生支持 `github:` 规格，走 codeload tarball），
安装后 CLI 的 bundle 协调读取已装包 manifest 的 `dsh.bundle.patch` 并自动追加到
`dsh.profile.bundles`——与本地 `link:` 安装走完全相同的挂载路径（已实证）。

**打包约定（重要，勿改回；均经实测验证）**：
- **不要加回 `package.json` 的 `files` 字段**——pnpm 的 packlist 语义在 tarball 安装路径下
  会因 `files`（或包内 `.npmignore`）使 packlist 输出与 tarball 条目数不一致，走重加路径，
  可能触发其 `parseTarball` 的"剥首个路径分量"行为（专为 registry `package/...` 包裹格式
  设计），把未包裹 tarball 里的 `lib/index.js` 误剥成根 `index.js`、`lib/` 丢失。已实测。
- **根入口 `index.js` = 双保险**：`main` 指向包根的一行转发（`module.exports = require('./lib/index.js')`），
  即便遇到未包裹 tarball 的路径剥离，真实实现 `lib/index.js` 也不受影响。勿删除该文件。
- **`github:` 安装本身安全**：codeload tarball 天然带 `<repo>-<commit>/` 顶层包裹，pnpm 剥掉
  包裹层后 `lib/` 结构完好——已用 codeload 同构（包裹式）tarball 实测：`lib/index.js`、
  `cordis.patch.yml`、`README.md`、`LICENSE`、`package.json` 全部就位，require 正常。
- 发布内容用两层控制：`.gitattributes export-ignore`（codeload 瘦身，排除 `test/`、
  `plugin-body.js`、`scripts/`）+ `.npmignore`（npm publish 瘦身）。两者都
  **不得排除 `cordis.patch.yml`**（bundle 挂载声明）。
- 验证脚本：`scripts/git-install-test.ps1`（git resolver + codeload 等价 tarball +
  带 `.gitignore` 场景）、`scripts/codeload-sim-test.ps1`（包裹式 tarball）。

前置条件 / 注意：
- 仓库公开，或本机已配置 GitHub 凭据；本机需能访问 github.com（本部署 git 代理
  `http://127.0.0.1:7800`，必要时先配置）。
- 已用 `link:` 本地装过的机器，再次 `add github:...` 会替换 dependency spec
  （bundles 条目保持不变，不会双挂载）。
- 若之后选择 `npm publish`，等价命令为 `dsh plugin --profile web add dsh-llm-injection-filter@1.0.0`
  （`.npmignore` 已含 `lib`、`cordis.patch.yml`、`README.md`、`LICENSE`、`package.json` 之外的全部内容）。

## 测试

```bash
npm test   # node test/run-tests.js —— 24 项，覆盖测试清单 1-16 及处置模式/流完整性
```

端到端（清单 17）：挂载后真实模型调用应零延迟零中断；构造含泰文的 delta 时 turn 以 `RESPONSE_FILTERED` 错误结束、前端会话视图出现错误横幅、`llm/retry` 事件不产生（以上路径已通过源码核实：`dsh-agent-loop` step() → `agent/request-error` → LlmError → `turn/end`；`dsh-llm-retry` 默认可重试码不含 `RESPONSE_FILTERED`）。
