# Changelog

## 0.1.2（2026-08-25）

### 功能

- 自动安装前弹确认（modal）：需要下载 dsh 运行时前先询问用户，同意后才开始安装；拒绝则进入失败态（横幅 Retry 可重新选择），且不再叠加错误弹窗
- 安装超时提示移除镜像源引导（镜像不可达已自动回退官方源，该提示已无意义）
- 打开侧边栏自动收编当前工作区：新设置 `dsh.autoAddWorkspace`（默认开启）——侧边栏视图打开时把当前工作区文件夹自动加入 dsh 工作区，与「＋ 工作区」按钮范围一致（仅第一个文件夹）；未就绪时等服务器就绪后自动执行；成功/失败均静默（仅日志），每激活一次
- **profile 切换**：侧边栏底部「＋ 工作区」右侧新增 `profile:` 按钮——QuickPick 列出 `$DSH_HOME/profiles` 下有效 profile（也可手动输入，**不存在时自动初始化**，web 模板 `base + web-app`），选择即切换（无确认弹窗）；新设置 `dsh.profile`（默认 `web`）持久化选择，启动失败不回滚（failed 态可 Retry）
- profile 切换改为「**目标在运行则直接接管**」：已运行的实例（插件 spawn / 持久化接管 / 外部固定端口服务）若与目标 profile 一致则零重启接管；持久化状态记录 profile（异 profile 实例不接管、切换时保留目标实例不被误杀）；固定端口（3080）按约定仅归属 web profile，非 web 目标不接管。会话与工作区数据由 dsh 全局共享，切换仅改变插件的 profile 选择（确认弹窗与文档文案同步修正）
- 修复切换 web 时仍随机端口冷启动：固定端口接管探测改用**配置端口**（`dsh.runtime.port`）而非 launch 参数——端口冲突回退后 launch 携带 `--port 0`，原探测恒为空，外部 web 不再被接管
- **端口回退自动恢复**：冷启动前若 launch 携带 `--port 0`（此前冲突回退的激活级记忆），先探测固定端口是否已空闲（连接被拒 = 空闲），空闲则自动改回固定端口（如 3080）——外部进程关闭后不再一直用随机端口
- 初始化 profile 清理半成品与 registry 强制（两处旧方案已废弃）
- 手动输入不存在的 profile **离线初始化**（骨架，零下载）：bundles 用 web 模板（base + web-app），从 dsh 安装包解析（`resolveBundleDir` installation-first 契约），无需 pnpm/registry——`dsh plugin add` 的 pnpm 阶段常被用户全局镜像 404（npmmirror 缺 dsh 新包）与官方源网络不稳双重阻断；已实测：仅骨架的 profile 在隔离 DSH_HOME 下直接启动出 ready 行
- **错误面板移到侧边栏底部**：失败时底部（footer 上方）显示错误面板——左侧可滚动错误信息，右侧垂直排列「重试」「反馈」（中文）按钮
- 修复确认弹窗双取消按钮：modal 弹窗自带取消（X/ESC），不再传显式「取消」/「跳过」按钮（安装确认与 profile 切换确认同步修正）

### 修复

- native 会话 id 一致性：会话 id 统一由宿主生成（`newSession` / 首次 `prompt` 经 `activeSession` 广播回传），webview 不再自行造 id —— 修复首条消息/新建会话不显示的问题（native 恢复前已修）
- 运行时握手失败不再泄漏子进程：失败的 harness 会被关闭，旧订阅迭代器按代际（epoch）失效，不会向 UI 转发陈旧事件
- `dsh.logLevel` 设置生效：过滤进入 DSH 输出通道的日志（npm 安装进度始终显示）
- 镜像源失败回退标记提升到激活级作用域：用户重试时不再重复支付死镜像的超时
- Windows 之外不再使用 shell 启动 npm（argv 直传，无 shell 注入面）；npx 缓存探测补上 POSIX 路径（`~/.npm/_npx` / XDG）
- `__DSH_BOOT__` 接管校验从子串匹配升级为结构校验（`{ rev, entries[{id,url,rev}] }`），非 dsh 页面不会被误认
- 端口冲突与缺模块重试拆分为独立的一次性旗标（此前端口回退会耗尽缺模块自愈机会）
- 就绪前失败改为等 stdio 排空（`close` 事件）后再判定——此前 `exit` 先于 stderr 管道送达，`EADDRINUSE`/缺模块检测会读到空诊断而漏掉自愈（测试暴露的真实竞态）
- 崩溃重启预算改为稳定窗口制：就绪后需稳定运行 30s 才重置预算，崩溃循环不再无限重启
- `stop()` 清理安装超时定时器；junction 失效（repo 移动）时删除重建；webview nonce 改用 `crypto.randomBytes`；`workspace.create` RPC 增加 10s 超时
- 全局安装探测修复：`npm root -g` 输出的是 node_modules 目录本身，此前 `dshBinIn` 再多拼一层 `node_modules` 导致全局安装永远探测不到（只能回退 npx 缓存）；现在两种布局（含 node_modules 的根 / node_modules 目录本身）都识别，`dsh.runtime.path` 直接填 node_modules 目录也可用
- sharp 判坏逻辑只针对坏版本 0.35.3：此前任何非 0.35.2 版本都被当作坏版拒绝，误伤健康的老/新版本（全局/npx 副本被白白放弃、提示文案误导）
- `npm root -g` 成功结果缓存 60s：installed 模式每次启动都会多次探测，不再重复 spawn npm（失败不缓存，刚装好的 dsh 下次立即能被发现）
- **代码审查修复**（2026-08-25 独立审查反馈，全部落实）：
  - 测试套件与实现对齐：`start()` 不再为 `--port` 探测调用 `launch()`（改用配置端口），测试移除「probe 计数」假设、全局 stub `fetch` 拒绝（与 3080 真实 dsh 解耦）、ready 超时用例改用永不打印 ready 的脚本（消除时序 flaky）；`sessionManager.spec` 不再依赖兄弟仓库（id 铸造提炼为纯函数）
  - `start()` 增加 single-flight 守卫：双击 Retry 不再弹两个确认框、不再并发执行两次安装
  - `stop()` 在安装/启动期间调用后，在途安装完成不再静默重启（状态置 stopped 并抑制多余报错）
  - 安装超时提示改用安装开始时的 cwd（不再在 60s 定时器内重跑运行时解析/npm）
  - `dsh.profile` 手写非法值时回退 web 并提示（不再把非法名传给 launcher）
  - 日志阈值激活级缓存（配置变更时刷新），逐行日志不再调用 `getConfiguration`
  - 自动收编工作区改为每激活一次（失败也不在每次视图重建时重试）
  - deactivate 现在 dispose 服务器状态发射器（进程仍按设计保留，仅释放宿主侧监听）
  - `isPortFree` 导出并补「仅 ECONNREFUSED 视为空闲」语义测试

### 代码审查修复（第二轮，2026-08-25）

- 端口回退探针只在 launch **确实携带** `--port` 时执行：`portOfArgs` 把「无 `--port` token」与「`--port 0`」同视为 0，裸 `node -e` 命令会被追加 `--port`（node 自身报 bad option exit 9）——干净机器/CI 上套件确定性红；修复后探测恒跳过无 token 的 launch，测试默认路径零探针
- 安装中 stop 失效修复：`stop()` 在无子分支会**同步复位** `stopping`，原「await 后复查 stopping」形同虚设——改为 `startEpoch` 生成代际令牌（每次 stop 递增），在途安装完成后校验令牌并中止（状态置 stopped、不 spawn、抑制多余报错）；新增 stop-during-install 回归测试
- `sessionManager` 模块图与兄弟仓库解耦：`newSessionId`/`newSessionMeta`/`parseSessionEvent`/`parseSubagentStarted`/类型抽到无依赖的 `src/sdk/sessionCore.ts`，spec 从纯模块导入——新克隆无 `deepseek-harness-master` 时该 spec 不再加载即失败（SDK 值导入只留在 `SessionManager.ts`）

### 代码审查修复（第三轮，2026-08-25）

- 中止令牌捕获上移到 `doStart` 顶部（任何 await 之前），并新增确认弹窗后与 preflight/spawn 前两个检查点——`stop()` 落在复用探测/确认弹窗期也会中止（此前窗口偏晚，确认弹窗打开时点停止仍会启动）
- 基线既有的新鲜克隆加载问题：`sdk-smoke.spec` / `native-chat.e2e.spec` 的顶层仓库 SDK 导入改为「仓库存在性守卫（skipIf）+ 变量路径动态 import」——无 `deepseek-harness-master` 时不再收集期失败（静态类型也零解析，tsc 同样可用）
- 测试补充：确认弹窗期 stop 中止、abort 后干净重启、默认 `probePort` 注入（冷启动路径零真实端口连接）

### 测试

- 新增 `DshServerManager` 状态机测试：就绪启动/幂等、崩溃自动重启与退避、就绪超时、preflight 失败、端口冲突与缺模块自愈、持久化/外部服务复用
- `portParser` 补 `__DSH_BOOT__` 清单校验用例；`sessionManager` 补 `newSession` 用例
- `runtimeDetect` 补 `resolveInstallRoot` 布局兼容、`sharpVersion` 读取、坏版本常量用例；`globalNpmRoot` 改为 mock（避免测试依赖真实机器的全局安装）

### 文档

- README 中英文同步：安装/打包文件名、移除已不存在的 `dsh.ui.mode`、`dsh.model`/`dsh.logLevel` 说明、外部服务接管提示

## 0.1.1（2026-08-15）

- 禁用 native 模式（功能不完整，源码与测试保留待恢复）
- 修复：重试后错误横幅未关闭、npx 坏实例就地修复复用（不再重复下载）
- 修复：安装完整性即时验证（js-yaml 等缺失自动独立缓存重装）、镜像源不可达自动回退官方源
- 图标更换为 DeepSeek logo 黑色版；作者标识 Mu-X-Yun

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
