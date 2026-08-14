# DeepSeek Harness for VSCode Unofficial

> ⚠️ **非官方插件**：本项目由社区开发者维护，**与 DeepSeek AI 及其官方产品没有任何关联**，非 DeepSeek 官方发布、认可或支持。

## 与官方 DeepSeek Harness（dsh）的联系

本插件是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek AI 开源的 MIT 项目）的**第三方 VS Code 客户端**，两者关系如下：

- **不包含、不修改官方源码**：插件本身不含任何 dsh 代码，也不对其做补丁或修改；dsh 的源码、版权与发布权归 DeepSeek AI 所有。
- **驱动方式**：插件启动你本机安装的 dsh（源码检出或安装包），通过其公开接口驱动：
  - **embedded 模式**：spawn `dsh web`，在侧边栏 iframe 中嵌入官方 Web UI（界面本身即 dsh 官方 UI）
  - **native 模式**：通过官方 JSON-RPC SDK（`@deepseek-ai/dsh-sdk-client`）协议驱动 dsh 运行时
- **需要自备**：dsh 运行时（本仓库不随插件分发）与 DeepSeek API Key。
- **上游依赖**：dsh 仍处开发者预览阶段（0.1.0-rc.x），其更新可能改变行为、影响本插件 —— 上游变更不受本插件控制。

两种侧边栏界面（`dsh.ui.mode` 切换）：

- **embedded（阶段 1，默认）**：在侧边栏 Webview 中嵌入 dsh 自带的 Web UI（iframe 模式，参考 VS Code 官方 Live Preview 的做法）。
- **native（阶段 2）**：基于官方 `@deepseek-ai/dsh-sdk-client` 自建聊天 UI，提供原生 VS Code 交互体验（参考 Claude Code 官方扩展）。

## 前置要求

- VS Code `^1.85.0`
- Node.js `^22.19 || >=24`（dsh 的引擎要求）
- pnpm（仅 repo 模式：构建 dsh 源码时需要）

## 获取 dsh 运行时（三选一）

插件通过 `dsh.runtime.mode` 决定 dsh 运行时的来源：

| 模式 | 说明 | 适合 |
|---|---|---|
| `repo`（默认） | 从 `deepseek-harness-master` 源码检出运行 | 开发/调试 dsh 本身 |
| `installed` | **自动探测**已安装的 dsh：全局安装（`npm i -g @deepseek-ai/dsh`）或 npx 缓存（跑过一次 `npx @deepseek-ai/dsh web` 即可）；`dsh.runtime.path` 可显式指定 | 已装过 dsh 的普通用户 |
| `auto-install` | 首次启动自动 `npm install @deepseek-ai/dsh` 到扩展存储 | 不想装任何东西的用户 |

普通用户推荐：`dsh.runtime.mode: installed` + 全局安装一次：
```sh
npm i -g @deepseek-ai/dsh
```
或者完全不装 + `auto-install` 模式（首次启动自动下载）。

> ℹ️ **模式适用性**：`installed` / `auto-install` 支持 **embedded 模式**（npm 包可完整运行 `dsh web`，已实测）。**native 模式**当前仅支持 `repo` —— 上游 npm 包（`dsh-sdk-jsonrpc-demo`）未包含 cordis.yml 所需的插件依赖（llm-deepseek、agent-spine 等），npm 形态下无法独立运行。

## 开发环境（repo 模式）

扩展默认从 `deepseek-harness-master/` 源码检出运行 dsh（自动探测扩展目录的兄弟目录，也可用 `dsh.runtime.path` 显式指定）：

```sh
# 1. 准备 dsh 源码（一次性）
cd deepseek-harness-master
pnpm install
pnpm run build:lib:host && pnpm run build:lib:client   # 或 pnpm run build
pnpm run build:web          # 产出 apps/web/dist，否则 dsh 启动即失败

# 2. 安装并启动扩展（F5，Extension Development Host）
cd dsh-vscode
npm install
npm run watch               # esbuild watch（launch.json 的 preLaunchTask 会自动执行）
```

## 使用

1. 点击活动栏的 DSH 图标打开侧边栏；embedded 模式会自动启动 `dsh web`（随机端口）。
2. 首次使用需配置 API Key：设置 → `dsh.deepseekApiKey`（或让扩展继承宿主环境的 `DEEPSEEK_API_KEY`）。
3. 状态栏显示当前端口，点击可在外置浏览器打开；`DSH: Show server logs` 查看进程日志。
4. 切换到 native 模式：设置 → `dsh.ui.mode: native`，重启扩展（或重新打开侧边栏）即用自建聊天 UI，首次发送消息时自动拉起 JSON-RPC 运行时。

## 配置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.deepseekApiKey` | （继承环境） | DeepSeek API Key，spawn 时注入进程环境 |
| `dsh.deepseekBaseUrl` | — | 可选自定义端点；仅接受进程环境注入 |
| `dsh.runtime.mode` | `repo` | `repo`（源码检出）/ `installed` / `auto-install`（规划中） |
| `dsh.runtime.path` | 自动探测 | runtime 绝对路径 |
| `dsh.runtime.nodePath` | `node`（PATH） | 用于 spawn dsh 的 Node 可执行文件。**必须用系统 Node**（`process.execPath` 在扩展宿主里指向 Code.exe，其内置 node 会破坏 tsx 的 tsconfig-paths 解析） |
| `dsh.permissionMode` | `workspace-write` | 注入为 `DSH_PERMISSION_MODE` |
| `dsh.model` | `deepseek-v4-flash` | 新会话默认模型 |
| `dsh.ui.mode` | `embedded` | 侧边栏界面：`embedded`（iframe 嵌入）/ `native`（自建聊天 UI） |

## 架构要点

- **进程归属**：`dsh web`（embedded）与 `dsh-jsonrpc-agent`（native）子进程均由扩展宿主（Extension Host）持有，不随侧边栏视图销毁；退出时先 `SIGTERM` 优雅停止，Windows 上 3 秒未退则 `taskkill /T /F` 清理进程树。
- **就绪检测**：embedded 模式解析 dsh stdout 的 `dsh web: http://127.0.0.1:<port>` 就绪行（`--port 0` 随机端口），而非轮询端口。
- **嵌入安全**：iframe 与 dsh 服务同源（127.0.0.1），通过 dsh 的浏览器信任栅栏；服务器无 CSP / X-Frame-Options，不阻止嵌入。
- **密钥注入**：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DSH_*` 只通过 spawn 环境注入 —— 这与 dsh 的 BOOTSTRAP 约束（禁止从 `.env` 读取）一致。
- **native 运行时**：`dsh-jsonrpc-agent` 以 tsx 源码形态从 repo 启动（`node --import tsx/esm`）；生成的 cordis.yml 位于扩展 globalStorage，通过 Windows junction 链接到 `examples/node_modules` 解析插件（与 dsh 的 `healProfilesModuleFallback` 同机制）。
- **native 事件流**：`DeepSeekHarness` 持子进程，`HarnessClient.subscribe()` 流式接收 `session.event` / `session.status` / `subagent.*` 通知，事件缓冲在扩展侧，视图重建时重放快照。

## 已知限制

- dsh 处于 developer preview（0.1.0-rc.x），兼容性可能变更；扩展锁定版本。
- 扩展用系统 `node`（PATH）spawn dsh 而非 `process.execPath` —— VS Code 扩展宿主内置 node（Code.exe）会让 tsx 源码启动失败；如需指定其它 node，用 `dsh.runtime.nodePath`。
- embedded 界面是 dsh 自带 Web UI，主题与 VS Code 不完全统一（native 模式解决）。
- embedded 的 iframe 会捕获键盘焦点，部分 VS Code 快捷键在聊天区域不可用。
- native 模式的 `stopAgent` 会终止并重建运行时（协议无 mid-turn cancel，进行中的回合进度丢失）；跨扩展重启的会话历史为只读浏览（协议无 session resume）。
- native 模式无交互式权限弹窗（JSON-RPC 协议无权限请求方法）；`dsh.permissionMode: workspace-write` 下危险命令实际被拒绝，需切换 `danger-full-access` 才能放行。

## 测试

```sh
npm test    # vitest：portParser / config / eventRenderer 纯函数 + SDK 握手 smoke
```
`tests/sdk-smoke.spec.ts` 会真实 spawn JSON-RPC 运行时并握手，需要 repo 已安装并构建。

## 打包

```sh
npm run package    # esbuild build + vsce package → dsh-vscode-0.1.0.vsix
```
VSIX 不捆绑 dsh 运行时；发布形态的 `auto-install` 模式（首次按需安装 `@deepseek-ai/dsh` 到 globalStorage）为规划中功能。

## 许可

[MIT](LICENSE) —— 本项目（扩展本体）为独立开源项目。注意：DeepSeek Harness（`dsh`）本身是 [DeepSeek AI](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 开源项目，本扩展只是它的外部驱动客户端，不包含其源码。
