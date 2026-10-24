# DS-Codex Bridge（穷鬼OAI plus会员外挂梁圣）

供 Codex 使用的本地 Responses 兼容桥：按请求模型名前缀，将 `deepseek-*` 转发到 DeepSeek，将 `gpt-*` 转发到 ChatGPT Codex OAuth 上游，并处理已知的历史消息兼容问题。

```text
Codex → http://127.0.0.1:8799 → deepseek-* → DeepSeek /responses
                            → gpt-*      → ChatGPT Codex /responses
```

核心运行时零第三方依赖，监听地址强制为 loopback。未知模型直接拒绝；上游出错时不自动换模。兼容处理仅作用于发出的请求副本，不修改已有聊天或 SQLite。

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
