# dsh-preset-generator

[English](../README.md) | 中文

从**应用内自带的基底 preset** 生成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 agent preset。

```sh
node src/gen-presets.mjs              # 写进 ~/.dsh/profiles/desktop
node src/gen-presets.mjs --dry-run    # 只打印块，不写文件
node src/gen-presets.mjs --out FILE   # 写到别处
node src/gen-presets.mjs --daily-only # 文件里已有 heavy 时拒绝
```

## 为什么需要它

DSH 的 agent preset **没有继承**。一个 preset 的 `plugins` 列表就是它完整的组合，而 patch 是**整体替换**一个条目而不是合并进去。所以自定义 preset 必须把基底 preset 重述一遍 —— 而基底随应用一起发布、会随 DSH 升级变化，手抄注定跟不上。

本工具做的就是这份"重述"：从已安装的 `app.asar` 里读出基底，套用一份策略，写进某个 profile 的 `cordis.patch.yml` 的**标记区间**。

它**刻意不属于任何插件**。它生成的 preset 服务于不止一个插件，而它写入的那个区间**DSH 自己的设置 UI 也会写**。一个属于某个插件的工具，最后就在改写一个多方共有的文件；这个工具不属于任何一方，这才是诚实的描述。

## 标记是承重的

`BEGIN` 标记里写着这个文件**曾经所在的路径**。它必须继续写着那个路径：在本次搬迁之前生成的 profile 里已经含有那串确切文本，换一串会让本脚本**追加第二个块**而不是替换第一个。

## 它写什么

| preset | 基底 | 策略 |
|---|---|---|
| `daily`（日常） | 自带的 `ptc` preset | 各插件行；Codex 委派由一套独立 provider 提供 |
| `heavy`（重活） | 同上，且 `tool-presentation: both` | 以上全部，外加 computer use |

`tool-presentation: both` 是刻意的：纯 `ptc` 呈现下模型只看得到 `run_code`，一个可直接调用的工具就得嵌成另一个 JavaScript 程序里的字符串。

官方的 `tool-subagent-codex` 行保持**禁用** —— 和基底一致。另有一套独立 provider 自己注册 `subagent_codex`，而两行在同一个 scope 里注册同名工具会冲突：后一次注册抛错，它的工具**永远不会出现**。

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
npm test    # node --test；基底来自已安装的应用
```

测试跑在一份**合成的 profile patch** 上，应用未安装时自动跳过，所以在本地有意义、在 CI 上也能过。

## 许可

MIT。
