# DeepSeek Harness for VSCode Unofficial

**中文** | [English](README.en.md)

> ⚠️ **非官方插件**：本项目由社区开发者维护，**与 DeepSeek AI 及其官方产品没有任何关联**，非 DeepSeek 官方发布、认可或支持。

在 VS Code 侧边栏中使用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek 官方的 AI 编程代理框架）的非官方客户端。

侧边栏嵌入 **dsh 官方 Web UI**（iframe 模式，功能最全）。

## 快速开始

### 1. 安装

扩展面板 → `...` → **Install from VSIX** → 选择 [Release](https://github.com/Mu-X-Yun/deepseek-harness-for-vscode-unofficial/releases) 中下载的 `dsh-vscode-0.1.0.vsix`。

### 2. 打开侧边栏

点击活动栏的 **DSH 鲸鱼图标** 打开侧边栏。首次使用会自动安装 dsh 运行时并启动（约 1 分钟，界面会显示加载进度），之后 Reload / 重启 VSCode 均秒开（复用运行中的 dsh）。

状态栏右侧显示 dsh 服务状态与端口，点击可在外置浏览器打开完整界面：

![DSH 状态栏端口](media/DSH_port.png)

### 3. 配置 API Key

设置（`Ctrl+,`）→ 搜索 `dsh.deepseekApiKey` → 填入你的 DeepSeek API Key（或让扩展继承宿主环境的 `DEEPSEEK_API_KEY`）。

### 4. 开始对话

在侧边栏中输入问题即可与 dsh 代理对话（embedded 为官方 Web UI 的完整交互，含会话、工具调用、模型选择等）。

**将当前工作区加入 dsh 工作区**：点击状态栏的 **Add workspace** 按钮，即可把当前 VS Code 打开的文件夹收编为 dsh 工作区（会话自动归属该工作区）：

![Add workspace 按钮](media/Add_workspace.png)

其他常用命令（命令面板 `Ctrl+Shift+P`）：

| 命令 | 说明 |
|---|---|
| `DSH: Open in Secondary Sidebar` | 在右侧辅助侧边栏打开（主/辅可同时显示，状态同步） |
| `DSH: Open in browser` | 外置浏览器打开完整界面 |
| `DSH: Show server logs` | 查看 dsh 进程与插件日志（排障用） |
| `DSH: Stop server` | 停止 dsh 服务器 |

## 与官方 DeepSeek Harness（dsh）的联系

本插件是官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，DeepSeek AI 开源的 MIT 项目）的**第三方 VS Code 客户端**，两者关系如下：

- **不包含、不修改官方源码**：插件本身不含任何 dsh 代码，也不对其做补丁或修改；dsh 的源码、版权与发布权归 DeepSeek AI 所有。
- **驱动方式**：插件启动你本机安装的 dsh（自动安装、全局安装或源码检出），通过其公开接口驱动：
  - **embedded 模式**：spawn `dsh web`，在侧边栏 iframe 中嵌入官方 Web UI（界面本身即 dsh 官方 UI）
- **需要自备**：DeepSeek API Key（dsh 运行时可由插件自动安装）。
- **上游依赖**：dsh 仍处开发者预览阶段（0.1.0-rc.x），其更新可能改变行为、影响本插件 —— 上游变更不受本插件控制。

## 获取 dsh 运行时（三选一）

插件通过 `dsh.runtime.mode` 决定 dsh 运行时的来源：

| 模式 | 说明 | 适合 |
|---|---|---|
| `auto-install`（默认） | 首次启动自动 `npm install @deepseek-ai/dsh` 到扩展存储，之后复用 | 开箱即用（推荐） |
| `installed` | **自动探测**已安装的 dsh：全局安装（`npm i -g @deepseek-ai/dsh`）或 npx 缓存（跑过一次 `npx @deepseek-ai/dsh web` 即可）；`dsh.runtime.path` 可显式指定 | 已装过 dsh 的用户 |
| `repo` | 从 `deepseek-harness-master` 源码检出运行 | 开发/调试 dsh 本身 |

普通用户默认 `auto-install` 即可（首次启动自动下载）；已装过 dsh 的切到 `installed` 模式直接复用：
```sh
npm i -g @deepseek-ai/dsh   # 然后设 dsh.runtime.mode: installed
```


## 配置项

| 设置 | 默认 | 说明 |
|---|---|---|
| `dsh.deepseekApiKey` | （继承环境） | DeepSeek API Key，spawn 时注入进程环境 |
| `dsh.deepseekBaseUrl` | — | 可选自定义端点；仅接受进程环境注入 |
| `dsh.runtime.mode` | `auto-install` | `auto-install`（自动安装）/ `installed`（探测全局/npx）/ `repo`（源码检出） |
| `dsh.runtime.path` | 自动探测 | runtime 绝对路径（repo 检出目录或含 dsh 的 node_modules 根） |
| `dsh.runtime.nodePath` | `node`（PATH） | 用于 spawn dsh 的 Node 可执行文件。**必须用系统 Node**（`process.execPath` 在扩展宿主里指向 Code.exe，其内置 node 会破坏 tsx 的 tsconfig-paths 解析） |
| `dsh.runtime.registry` | （官方源） | npm 镜像源（如 `https://registry.npmmirror.com`），可加速首次安装 |
| `dsh.runtime.port` | `3080` | dsh web 端口；`0` = 随机（3080 被占用时自动回退） |
| `dsh.permissionMode` | `workspace-write` | 注入为 `DSH_PERMISSION_MODE` |
| `dsh.model` | `deepseek-v4-flash` | 新会话默认模型 |
| `dsh.ui.mode` | `embedded` | 侧边栏界面（当前仅支持 `embedded`） |

## 前置要求

- VS Code `^1.85.0`
- Node.js `^22.19 || >=24`（dsh 的引擎要求）
- pnpm（仅 repo 模式：构建 dsh 源码时需要）

## 已知限制

- dsh 处于 developer preview（0.1.0-rc.x），兼容性可能变更；扩展锁定版本。
- embedded 界面是 dsh 自带 Web UI，主题与 VS Code 不完全统一。
- embedded 的 iframe 会捕获键盘焦点，部分 VS Code 快捷键在聊天区域不可用。
- 关闭 VSCode 时 dsh 进程会保留运行（便于下次秒开）；需手动停止时用 `DSH: Stop server` 命令。

## 架构要点

- **进程归属**：`dsh web` 子进程由扩展宿主（Extension Host）持有，不随侧边栏视图销毁；**Reload 时保留复用**（状态持久化到扩展存储，健康检查通过则秒开），Windows 上停止时 `taskkill /T /F` 清理进程树。
- **就绪检测**：embedded 模式解析 dsh stdout 的 `dsh web: http://127.0.0.1:<port>` 就绪行（`--port 0` 随机端口），而非轮询端口。
- **状态同步**：宿主广播 + webview ready 握手 + 15 秒轮询兜底 —— 任何丢失的状态推送都会自愈。
- **嵌入安全**：iframe 与 dsh 服务同源（127.0.0.1），通过 dsh 的浏览器信任栅栏；服务器无 CSP / X-Frame-Options，不阻止嵌入。
- **密钥注入**：`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` / `DSH_*` 只通过 spawn 环境注入 —— 这与 dsh 的 BOOTSTRAP 约束（禁止从 `.env` 读取）一致。
- **依赖修复**：npm sharp 0.35.3 为坏发布（二进制无法加载），扩展通过 npm overrides 钉定 0.35.2（auto-install 自动处理；installed 模式检测并提示）。

## 开发环境（repo 模式）

扩展从 `deepseek-harness-master/` 源码检出运行 dsh（自动探测扩展目录的兄弟目录，也可用 `dsh.runtime.path` 显式指定）：

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

## 测试

```sh
npm test    # vitest：渲染/解析/运行时探测纯函数 + SDK 握手 + 真实对话 e2e（无 key 自动跳过）
```
`tests/native-chat.e2e.spec.ts` 会用真实 API Key 跑完整对话链路（需要 `DEEPSEEK_API_KEY` 环境变量）。

## 打包

```sh
npm run package    # esbuild build + vsce package → dsh-vscode-0.1.0.vsix
```
VSIX 不捆绑 dsh 运行时（`auto-install` 模式首次启动自动安装到扩展存储）。

## 许可

[MIT](LICENSE) —— 本项目（扩展本体）为独立开源项目。注意：DeepSeek Harness（`dsh`）本身是 [DeepSeek AI](https://github.com/deepseek-ai/deepseek-harness) 的 MIT 开源项目，本扩展只是它的外部驱动客户端，不包含其源码。
