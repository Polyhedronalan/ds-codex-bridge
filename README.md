# DS-Codex Bridge（穷鬼OAI plus会员外挂梁圣）

供 Codex 使用的本地 Responses 兼容桥：按请求模型名前缀，将 `deepseek-*` 转发到 DeepSeek，将 `gpt-*` 转发到 ChatGPT Codex OAuth 上游，并处理已知的历史消息兼容问题。

```text
Codex → http://127.0.0.1:8799 → deepseek-* → DeepSeek /responses
                            → gpt-*      → ChatGPT Codex /responses
```

核心运行时零第三方依赖，监听地址强制为 loopback。未知模型直接拒绝；上游出错时不自动换模。兼容处理仅作用于发出的请求副本，不修改已有聊天或 SQLite。

## 主要功能

| 功能 | 能帮你做什么 |
| --- | --- |
| 一个入口连接两类模型 | 在 Codex 中统一配置 `bridge` provider，由模型名前缀选择 DeepSeek 或 ChatGPT Codex 上游。客户端支持会话内切换且已配置对应模型时，可以在同一会话中手动切换模型。 |
| 跨模型历史兼容 | 处理 DeepSeek 推理历史在 GPT 上游的已知格式冲突，并根据当前请求的工具声明整理不同工具模式的历史，减少切换后的请求拒绝与错误工具调用示范。 |
| 长会话历史整理 | 将当前工具模式无法直接使用的历史调用转为有长度上限的文字记录，区分已执行结果、被拒绝调用和未知结果，保持记录与原有对话的先后关系；截断文字时避免拆开 Unicode 代理对。 |
| 流式输出与请求取消 | 转发上游 SSE 流；客户端停止生成或断开连接时，取消对应上游请求并释放并发名额，避免被中断的请求持续占用本地处理能力。 |
| 请求保护与错误定位 | 支持请求体大小、并发数及连接、响应、空闲和总时长限制；提供明确错误码，对部分暂时性连接故障或 5xx 做有限重试，便于区分凭据、代理、限流和格式问题。 |
| 分别配置网络与认证 | DeepSeek 使用自己的 API Key，GPT 透传 Codex 客户端的 ChatGPT OAuth；两个上游可分别设置代理，并支持 HTTP CONNECT。 |
| 本地健康检查与 Windows 运维 | `/health` 提供本地状态；Windows 工具支持首次配置、后台启动、身份核验、停止和手动修复。日志按大小轮转，便于排查问题并限制磁盘占用。 |
| 可选额度保留保护 | 配合外部 Alan Router 读取官方额度，在剩余不超过 3% 时暂停经本桥发送的 GPT 请求；DeepSeek 分支独立可用。该功能默认关闭，启用依赖见下文。 |

## 项目特色

- **把不同模型放进已有 Codex 工作流。** 可以按任务需要手动选择 DeepSeek 或账号可用的 GPT 模型，组合使用自己的 DeepSeek API 与 ChatGPT Codex 权限；模型选择和任务执行仍由 Codex 客户端负责。
- **针对跨模型切换中的具体问题做兼容。** 兼容逻辑读取当前请求的工具声明，只整理已知冲突。已有聊天、rollout 和 SQLite 保持原样；未知结果仍标记为未知，历史记录受长度上限约束，详见 [兼容规则](COMPATIBILITY.md)。
- **轻量、易查看和自行部署。** 核心由 Node.js 原生模块组成，运行时零第三方依赖；配置示例、兼容规则、隔离测试和打包脚本随源码提供。Windows / Ubuntu、Node 22 / 24 的 CI 结果可在 [Actions](https://github.com/Polyhedronalan/ds-codex-bridge/actions) 查看。
- **本地入口与凭据分开管理。** 强制监听 loopback，校验本地访问 Key 并在转发前移除；支持环境变量和 Windows 当前用户 DPAPI。常规日志使用字段白名单并对已注册密钥脱敏，发布包按白名单排除本地凭据与运行状态。

## 适用场景与边界

适合已经使用 Codex，希望在一个客户端里结合 DeepSeek 与 GPT、继续已有任务上下文，或需要排查长会话中模型切换兼容问题的用户。实际可选模型取决于客户端模型目录、账号权限和上游接口支持。

请求内容仍会发送到所选上游，因此这不是离线推理。上游失败时由客户端或用户决定后续操作，本桥不自动换模；它也不增加账号额度或赋予额外模型权限。Windows 后台工具和额度门禁的条件分别见后文。

## 环境要求

- Node.js 22 或更新版本；无需 `npm install`。
- Codex CLI / Desktop，须支持自定义 Responses provider。DeepSeek 模型目录和账号可用模型由客户端自行配置；本包不安装或伪造模型目录。
- DeepSeek 分支需要自己的 API Key；GPT 分支需要当前 Codex 的有效 ChatGPT 登录及对应模型权限。本包不附带账号、OAuth 或 API Key。
- Windows PowerShell 5.1 用于 DPAPI 和可选后台生命周期工具；前台环境变量方式无需这些工具。
- 打包与发布检查使用 Python 3.10+，Bridge 运行不需要 Python。可选额度门禁另有依赖，见下文。

## Windows 首次配置

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\Initialize-Bridge.ps1
```

脚本提示隐藏输入 DeepSeek Key（可留空，仅用 GPT），生成随机本地 Key，写入当前用户 DPAPI 文件和 `config.json`，并生成 `examples/codex.local.toml`。它只写本目录，不修改全局 Codex 配置、不启动服务、不创建计划任务。已存在的配置和凭据会阻止重复初始化，避免覆盖。

打开生成的 TOML，将 provider 表合并到 `%USERPROFILE%\.codex\config.toml`，在顶层选择 `model_provider = "bridge"` 和实际可用的模型。先备份原文件，已有同名表时合并而非重复添加。生成的 TOML 包含本地 Key，请勿提交。使用 GPT 前先通过官方 Codex 登录流程登录。

```powershell
npm start
# 另开一个终端；此接口不调用上游
Invoke-RestMethod http://127.0.0.1:8799/health
```

`status=ok` 表示本地 Bridge 正常。缺少 DeepSeek Key 时会报告 `deepseek_configured=false`，DeepSeek 请求返回 503，GPT 路径仍可使用。健康检查不证明真实模型请求成功。

## 环境变量方式

适用于前台运行和非 Windows 环境。先复制 `config.example.json` 为 `config.json`，用自己的安全输入/密钥管理方式设置 `BRIDGE_LOCAL_KEY` 和 `DEEPSEEK_API_KEY`，将同一个本地 Key 写入 Codex provider 的 `query_params.bridge_key`，然后运行 `npm start`。示例 TOML 位于 [examples/](examples/codex.config.example.toml)。

本地 Key 在转发前移除。GPT 使用客户端传来的 OAuth Bearer，DeepSeek 使用独立 API Key；不使用 `OPENAI_API_KEY`。本地 Key 通过 query 参数传输，可能出现在客户端 URL 日志中，应按凭据管理。

## 代理与配置

配置优先级为环境变量 > `config.json` > 内置默认。完整字段见 [config.example.json](config.example.json)。

- GPT 默认读取 `HTTPS_PROXY`，DeepSeek 默认直连。需要代理时显式设置，例如 `$env:HTTPS_PROXY = 'http://127.0.0.1:你的端口'`。
- 保证本地客户端绕过代理：`NO_PROXY=127.0.0.1,localhost,::1`。支持 HTTP CONNECT，不支持 SOCKS。
- 已配置代理时启动会探测可达性；代理不可达会拒绝启动。
- 默认最多 4 个并发请求，16 MiB 请求体；日志每个 10 MiB，保留 5 个归档。
- TLS 校验默认开启，请保留默认值。
- 兼容规则及开关见 [COMPATIBILITY.md](COMPATIBILITY.md)。

## 可选 Windows 后台工具

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File start-production.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File tools\bridge-health.ps1 -Report
powershell -NoProfile -ExecutionPolicy Bypass -File stop-production.ps1
```

后台工具沿用现有的短时 ensurer、身份验证和持久 stop flag。启动仅在健康检查与监听进程身份验证后成功；停止只处理能证明属于当前目录的 Bridge。也可双击 `BridgeHealth.cmd` / `BridgeRepair.cmd`。修复可能重启当前目录的 Bridge，使用前结束在途请求。

这些工具仅支持默认的 `127.0.0.1:8799` 和本目录 `config.json`；自定义端口或 `BRIDGE_CONFIG` 时请使用前台运行。不会注册自启或计划任务。没有 `CodexBridgeSupervisor` 计划任务时，详细健康工具会报告恢复链缺失；前台运行可直接查看 `/health`。请勿在同一端口运行两份 Bridge。

## 可选 GPT 额度保留门禁

公开包默认关闭门禁（不附带本机生产策略）。只有主动将 `examples/gpt-quota-gate.example.json` 复制为根目录 `gpt-quota-gate.json` 并设为 `enabled:true` 才启用。

该可选集成依赖使用者另行安装的 `~/.codex/skills/alan-model-router/scripts/model_router.py quota`，并要求 Windows `codex.exe` 与 Python 可用；这些依赖未包含在包中。不具备该环境请保持关闭。开启后官方额度剩余 <=3% 拒绝 GPT；读取失败可能使用最多 15 分钟的官方缓存，否则拒绝 GPT。DeepSeek 分支不受影响。具体变化见 [发布说明](docs/RELEASE-NOTES.md)。

## 测试与打包

```powershell
npm test
npm run check
npm run release
```

测试使用隔离目录、临时端口、合成数据和本地模拟上游，无需真实账号。`check` 检查白名单文件、敏感内容特征和源码来源哈希。`release` 只将白名单文件写入 `dist/ds-codex-bridge-0.1.0.zip`，含 SHA-256 文件清单及 ZIP 校验和；本地配置、凭据、运行状态和旧工程不会进入包中。

GitHub Actions 已配置 Windows / Ubuntu、Node 22 / 24 测试矩阵。配置了 CI 不代表远端已运行，通过状态以实际 Actions 结果为准。

## 上传 GitHub

将**本目录中的文件（含 `.github`、`.gitignore`）**作为仓库根目录上传，或将发布 ZIP 解压后上传。不要上传外层维护项目或历史资料。命令行方式：

```powershell
git init
git add .
git diff --cached --stat
git commit -m "Prepare DS-Codex Bridge package"
# 在 GitHub 建立空仓库后，使用它提供的 remote/push 命令
```

尚未指定开源许可证，package 标记为 `UNLICENSED`，未授予额外使用/再分发许可。公开上传前由权利人选择需要的许可证。包整理不表示与 Codex、DeepSeek 或 ChatGPT 官方存在隶属关系，账号权限和接口兼容性取决于上游及客户端版本。
