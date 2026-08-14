# Changelog

## 0.1.0（2026-08-14）

首个公开版本：在 VS Code 侧边栏使用 DeepSeek Harness（dsh）。

### 功能

- **embedded 模式**（默认）：侧边栏 iframe 嵌入 dsh 官方 Web UI
- ~~native 模式~~（自 0.1.0 起禁用，见 README）：基于官方 JSON-RPC SDK（`@deepseek-ai/dsh-sdk-client`）的自建聊天 UI —— 流式消息、工具卡片、会话树、停止/重建运行时
- **辅助侧边栏支持**：主/辅侧边栏同时显示，状态广播同步
- **工作区集成**：状态栏按钮一键将当前 VS Code 工作区收编为 dsh 工作区（`workspace.create` RPC）
- **进程管理**：系统 node 启动、stdout 就绪行解析、SIGTERM → taskkill 进程树清理、崩溃自动重启
- **会话渲染**：按线上 wire 结构渲染（envelope `data` 字段）、seq 去重、流式 chunk 折叠、reasoning 展示

### 修复

- VS Code 内置 node（Code.exe）破坏 tsx 解析 → 改用系统 node 启动
- 侧边栏切走再切回后空白 → webview 重建 ready 握手
- 事件渲染与线上结构不匹配 → 按真实 envelope 读取

### 测试

- 33 个 vitest 用例（纯函数 + 真实 SDK 运行时握手 + 真实对话 e2e，无 key 自动跳过）
