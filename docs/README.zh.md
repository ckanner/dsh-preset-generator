# dsh-preset-generator

[English](../README.md) | 中文

从**应用内自带的基底 preset** 生成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent preset。

```sh
node src/gen-presets.mjs              # 写进 ~/.dsh/profiles/desktop
node src/gen-presets.mjs --dry-run    # 只打印块，不写文件
node src/gen-presets.mjs --out FILE   # 写到别处
node src/gen-presets.mjs --daily-only # 文件里已有 heavy 时拒绝
```

目标文件不存在时，会在已有的父目录中创建文件；首次使用、profile 里尚无
`cordis.patch.yml` 时也可以直接生成。已有文件则原地更新并保留其他设置。
父目录必须已经存在；无法读取的文件、目录类型的目标及其他文件系统错误会终止
操作，不会把已有内容当作空文件处理。
新文件以独占方式创建，运行期间其他程序抢先写入的补丁不会被覆盖。

## 为什么需要它

DSH 的 agent preset **没有继承**。一个 preset 的 `plugins` 列表就是它完整的组合，而 patch 是**整体替换**一个条目而不是合并进去。所以自定义 preset 必须把基底 preset 重述一遍 —— 而基底随应用一起发布、会随 DSH 升级变化，手抄注定跟不上。

本工具做的就是这份"重述"：从已安装的 `app.asar` 里读出基底，套用一份策略，写进某个 profile 的 `cordis.patch.yml` 的**标记区间**。

它**刻意不属于任何插件**。它生成的 preset 服务于不止一个插件，而它写入的那个区间**DSH 自己的设置 UI 也会写**。一个属于某个插件的工具，最后就在改写一个多方共有的文件；这个工具不属于任何一方，这才是诚实的描述。

## 标记是承重的

`BEGIN` 标记里写着这个文件**曾经所在的路径**。它必须继续写着那个路径：在本次搬迁之前生成的 profile 里已经含有那串确切文本，换一串会让本脚本**追加第二个块**而不是替换第一个。

## 它写什么

| preset | 基底 | 策略 |
|---|---|---|
| `daily`（日常） | 自带的 `ptc` preset | PTC executor；标记为日常编码 |
| `heavy`（重活） | 同一个 `ptc` preset | 相同的 executor 策略；标记为重活 |

两个 preset 都使用 PTC。LCU 通过 PTC 的 `cua` 桥暴露 ChatGPT 应用的 Computer/Browser runtime；`cua.getApp`、`cua.getTab`、截图和 handle 方法都经 `run_code` 运行，重活不再切换到 native executor 的直接 `js` 工具。目前生成的插件列表使用相同策略；GUI 与 Codex 委派是否可用取决于另外挂载的 provider 和各自 allowlist，`heavy` 这个名字本身不授予这些能力。

官方的 Codex 工具不再是 per-preset 行：从 DSH 0.2.1 起，`@deepseek-ai/dsh-subagent-codex` bundle 提供的是**全局**的 `subagent_codex` 工具；独立 provider（`dsh-subagent-codex-pro`）在这些 preset 里按 Agent 注册同名工具，遮蔽全局那个。而**同一个** scope 内的两次注册仍会冲突，所以不能在这个 provider 之外再启用同名的 `tool-subagent` 行。

## 它绝不能碰的东西

标记之间的区间**不是本脚本独占的**。DSH 的设置 UI 会把它的条目追加在那里 —— `agent-preset-registry` 和 `subagent-model-selection-settings` 都曾落在标记之间 —— 别的往 profile patch 里写东西的组件也可能如此。

所以一次运行**只替换它自己那一个条目**：那个携带 preset 行的 `- insert:` 外壳。区间内其他一切**逐字节留在原位**。

这比"小心处理它们"是更强的性质。早先的实现替换整个区间，然后把不是自己写的条目重新发到块后面，再对区间外的副本做去重 —— 三个机制，每一个都在补前一个的失败：

| 做法 | 出了什么问题 |
|---|---|
| 替换整个区间 | 静默删掉了设置项 |
| 把它们重新发到块后 | 下一次设置写入又落进区间，每次运行多留一份 |
| 按 id 去重 | 对了，但那是约 60 行只为撤销一次**本不该发生的搬动** |

只替换一个条目就不存在这些失败模式，因为**什么都不搬动**：没有副本要去重，也没有东西会累积。不属于我们的条目**连读都不读、不重写、不搬移** —— 包括我们不会选的值。

## 开发

```sh
npm test    # 跨平台 CLI/ASAR 夹具及 SDK composition 契约
```

测试使用合成 ASAR 与 profile patch，配置保留、幂等、旧 selector 和新 executor 行都会在没有桌面应用的 CI 上实际执行。它们不认证用户已安装的应用，也不调用模型。

## SDK composition API

本包还导出纯 ESM API。导入不会读取文件、启动 runtime、调用模型或改写桌面 profile。桌面生成器与 SDK composition 共用 `src/policy.mjs`，SDK 调用方将 patch 应用于独立 profile。

```js
import {
  inspectPtcBundle, createSdkPtcComposition, validateSdkPtcAdmission,
} from 'dsh-preset-generator'

// 调用方从确切的已安装 bundle 读取这些值，不能只猜版本号。
const evidence = inspectPtcBundle({ packageJson, files, sourceRevision })
const composition = createSdkPtcComposition({
  runtimeProfile: 'flywheel-sdk', preset: 'heavy', baseRows, ptcEvidence: evidence,
})
// 经 SDK 宿主的 profile loader 应用 composition.overlay，然后执行探针。
const admission = validateSdkPtcAdmission(composition, observed, { requireImages: true })
```

`baseRows` 是宿主解析完配置后的有效 JSON 插件行，id 必须唯一，不能传未展开的 `insert` 指令。overlay 禁用 native executor、启用 PTC、设置 `tool-fs.applyPatch: false`，同时保留已提供的 fs/PTC 配置。已知的旧 `tool-presentation` 行也会被禁用。SDK profile 拒绝 `desktop`；不提供 `baseRows` 时，只产生官方最小 SDK PTC patch，不声称检查过自定义配置。

返回的 `digest` 绑定 profile、策略、基底、overlay 和 bundle 证据。`compositionDigest(value)` 对规范化 JSON 求哈希；`files` 是相对路径到确切文本的映射。`inspectPtcBundle` 返回各文件哈希、实际 manifest exports 和描述性的源码线索，始终保留 `outputContract: 'unknown'`：rc.3 release 与后续 master 可能同为 `0.2.2-rc.3`，但 exports 与图片/输出语义不同，因此版本必须附带源码身份。参见 [release PTC manifest](https://github.com/deepseek-ai/deepseek-harness/blob/38a6a5c965aa99ab525161efb7cc5cf1fe62fced/packages/core/tool-executor-ptc/package.json) 与[后续 manifest](https://github.com/deepseek-ai/deepseek-harness/blob/39163dd30f703a79079e2d2446545cff3c453738/packages/core/tool-executor-ptc/package.json)。

准入要求实际观测到匹配的 `compositionDigest`、`runtimeProfile`、`executor: 'ptc'`、`activeExecutors: ['ptc']`、包含 `run_code` 的 `tools`、`probeStatus: 'passed'`，以及已验证的 `outputContract`（`deferred-context-v1` 或 `inspect-image-v1`）。若 composition 提供了 bundle 证据，观测的 `bundleDigest` 也必须匹配。`requireImages` 还要求 `imageProbeStatus: 'passed'`，缺少图片探针永远不能声明已支持图片。worker 应从真实 runtime 获取这些事实；本库只校验回执、哈希 JSON 观测，并拒绝生成后被修改的 composition，不认证回执的传输通道。

`provenance.kind` 为 `sdk-global-composition`，`namedPresetMounted` 恒为 false：共享日常/重活策略不代表存在 named-preset SDK RPC。GUI 与委派必须分别授权。消费方另外增加权限或 provider overlay 后，仍需在自己的总摘要中绑定完整最终配置。executor 图片探针与 provider 向模型传图是不同的验证。

## 许可

MIT。
