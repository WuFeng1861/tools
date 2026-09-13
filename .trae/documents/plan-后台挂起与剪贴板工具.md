# 计划：平台后台挂起 + 剪贴板工具（完整版）

## 一、目标

两个需求：

1. **平台后台挂起**：点右上角“关闭”时弹窗选择“转入后台运行 / 退出程序”，可勾选“记住选择，不再询问”；新增系统托盘图标（右键菜单含“显示主界面 / 退出程序”，并**动态列出后台常驻工具**，点击直达）。

2. **剪贴板工具（完整版）**：在 `example/clipboard-history/` 新增一个平台工具，后台常驻捕获剪贴板历史（文字 + 图片 + 文件清单），支持保存条数上限、持久化、去重、类型筛选/置顶/暂停、删除/清空、再复制，以及**全局快捷键独立悬浮面板** + **平台窗口内完整管理页**两者都要。

### 已确认的决策清单（与用户多次沟通定稿）
- **唤醒形态**：独立垂直悬浮小窗口（全局快捷键唤起，always-on-top）+ 平台主窗口内完整管理页，**两者都要**。
- **悬浮面板点击行为**：写回系统剪贴板，**面板不关闭**（方便连续粘贴多次）。
- **记录类型 v1**：文字 + 图片 + 文件清单（富文本按纯文本处理）。
- **去重（顶部重复检测）**：连续复制相同内容 → **不新增，把已有条刷新时间并置顶**（文字比对内容、图片比对文件哈希），应对 Ctrl+C 连按不刷屏。
- **隐私过滤**：第一版**不做**任何过滤/忽略名单（纯记录），入口和设置项留待后续。
- **容量控制**：**总条数上限（默认 200，可设）+ 图片单独张数上限（默认 50）双上限**，超限淘汰最旧，置顶项永不淘汰。
- **关闭弹窗偏好**：存 `localStorage`（WebView 数据目录，跨重启保留）。
- **后台常驻工具**：manifest 加 `autoStart` 标志，host 启动自拉起；**托盘右键列出这些后台工具，点击 → 启动（若未运行）→ 显示主窗口并导航到该工具**。
- **全局快捷键可自定义**：默认 `Ctrl+Shift+V`，可在工具“设置”页修改；因工具跑在 iframe（无 Tauri 权限）而全局快捷键是平台级资源（Rust 注册），故用一条 **postMessage 桥**让工具设置页调 Rust 命令 `set_clipboard_hotkey` 动态注销+重新注册并持久化（平台 settings 文件），重启后按保存值恢复。
- **采集方案**：工具后端 spawn 常驻 PowerShell 子进程（STA）用序列号检测变化再读取内容，零原生 Node 模块。

---

## 二、现状分析（Phase 1 探索结论）

### 架构
```
Vue3 前端 ──invoke──▶ Rust(Tauri) ──HTTP(127.0.0.1)──▶ Node 宿主 host.js
                                                          │  spawn 每工具一个 node.exe
                                     iframe 直接加载 ◀────┘ 监听随机端口
```
关键文件：
- [lib.rs](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/src/lib.rs) —— 入口；`RunEvent::Exit → shutdown_host`，目前**关窗即整程序退出并杀宿主与所有工具**。
- [sidecar.rs](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/src/sidecar.rs) —— 宿主生命周期；数据目录 `%APPDATA%\com.tools.platform`。
- [host.js](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/resources/host/host.js) —— `runtimes` 常驻工具进程，**工具进程不随 iframe 关闭而停止**。
- [runtime.js](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/resources/runtime/runtime.js) —— 工具 `ToolServer`（静态服务 + JSON 路由），端口取 `process.env.TOOL_PORT`。
- 前端 [App.vue](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/App.vue)（全局壳）、[api/tauri.ts](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/api/tauri.ts)（invoke 封装）、[LauncherView.vue](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/views/LauncherView.vue)。
- 示例工具规范见 [example/README.md](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/example/README.md)：`example/<id>/{manifest.json,index.html,app.js,…}`，复制进 `toolbox/` 即安装。

### 关键结论
- “工具后台运行”在现有架构下天然成立（host 常驻工具，关卡只在 host 是否退出）→ 需求 A 只需让“关窗”不再导致整程序退出，host 与工具进程保留。
- 工具目前不会自动启动，需为 autoStart 类工具在 host 启动时自拉起。
- 全局快捷键用 Rust 插件最稳；托盘右键动态列后台工具需在 Rust 维护动态菜单。
- 事件/导航等前端能力经 `@tauri-apps/api`（已装 v2）+ 新增 Rust 命令完成。

---

## 三、需求 A：窗口关闭 → 后台/退出 + 托盘（含后台工具列表）

### A1. Rust（[src-tauri/src/lib.rs](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/src/lib.rs)）
- **拦截关窗**：`.on_window_event` 匹配 `WindowEvent::CloseRequested { api, .. }` → `api.prevent_close()` + `window.emit("app://close-requested")`。
- **托盘图标 + 动态菜单**：`TrayIconBuilder`（图标用 `app.default_window_icon()`）。
  - 常驻菜单项：`显示主界面`、`后台工具 ▸`（动态子菜单）、分隔线、`退出程序`。
  - `后台工具 ▸`：调 host `GET /tools` 过滤 `autoStart`（或运行中）的工具生成子菜单项；点击某项 → 若未运行先 `start_tool` → `show()` 主窗口 + `emit("app://open-tool", { id })` → 前端导航到该工具运行页。
  - 托盘菜单在**应用启动 host 就绪后**重建一次，并在 `start_tool`/`stop_tool` 成功后重建（保持与运行状态一致）。
- **新增命令**（注册进 `invoke_handler`）：
  - `hide_to_tray()`：隐藏主窗口（窗口仍在，host 与工具照常运行）。
  - `quit_app()`：真正退出（`app.exit(0)`），复用 `shutdown_host` 清理。
  - `open_quick_panel()`：见 B6，供全局快捷键唤起悬浮面板。
  - `get_clipboard_hotkey()` / `set_clipboard_hotkey(accel)`：读取/设置全局快捷键。
    - `set_*`：用 global-shortcut 插件先 unregister 当前、再 register 新的；写入平台设置文件 `%APPDATA%\com.tools.platform\settings.json`；校验非法/占用的快捷键给出中文错误。
    - 应用**启动时读取 settings.json**，无则用默认 `Ctrl+Shift+V` 注册。
- **保留**：`RunEvent::Exit → shutdown_host`。

### A2. 前端
- [App.vue](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/App.vue)：`listen("app://close-requested")` 弹窗（后台/退出 + 记住选择）；`listen("app://open-tool")` → `router.push({ name:"tool-runner", params:{ id }})`；并监听 **postMessage 桥**消息（见 B8）。
- [api/tauri.ts](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/api/tauri.ts)：新增 `hideToTray()`、`quitApp()`、`openQuickPanel()`、`getClipboardHotkey()`、`setClipboardHotkey(accel)`。

---

## 四、需求 B：剪贴板工具 —— 功能详细设计

> 按示例工具规范建在 `example/clipboard-history/`，复制进 `toolbox/` 即可用。工具零 npm 依赖（只用 node 内置模块 + 系统 PowerShell）。

### B1. 两种界面（同一端口，两种入口）
| 入口 | 形态 | 用途 |
|---|---|---|
| `/`（主窗口完整页） | 平台 iframe 内打开 | 历史列表、搜索/筛选/置顶、删除/清空、暂停监控、设置、来源显示 |
| `/quick.html`（悬浮面板） | 独立 always-on-top 小窗口 | 快捷键呼出后快速过滤、点击复制、连续粘贴 |

### B2. 数据模型 `ClipItem`
`id`、`type(text|image|files)`、`ts`、`pinned`、`text`/`subText(前80字)`、`imageFile/size/w/h`、`files[]`、`sourceApp(前台窗口标题)`。

### B3. 采集 / 监控（app.js 后端）
- 常驻轮询（默认 300ms）：spawn 常驻 PowerShell 子进程（STA），`Add-Type` 一次性编译 C# P/Invoke 拿 `GetClipboardSequenceNumber()`，配合 `System.Windows.Forms.Clipboard` 读取；序列号变化=新复制，经 stdout 打 JSON，Node 解析。
- 类型识别：`FileDropList`(文件) → `Image`(存 PNG) → `UnicodeText`(文字)。
- **去重（顶部重复检测）**：新内容与“最顶端第一条”比较 —— 文字比对内容、图片比对文件哈希。相同 → 不新增，仅把该条 `ts` 刷新并置顶；不同 → 新增。
- **暂停监控**开关：暂停时停止更新（历史仍只读）。

### B4. 存储与容量（工具目录内）
- `history.json`（ClipItem 数组，按 ts 倒序）+ `settings.json` + `images/`。
- **双上限**：`maxEntries=200`（可设）+ `maxImages=50`（图片张数）。超出 → 淘汰最旧（`pinned` 项除外，且 pinned 不占“需淘汰”名额）。
- 写盘追加 + 启动加载，容错损坏（损坏则告警并空启）。

### B5. 交互（完整页 + 悬浮面板共用后端 API）
- 列表：文字摘要/图片缩略图/文件清单；文字与图片切换筛选。
- 单条：复制回剪贴板（悬浮面板：**写回剪贴板、面板不关闭**）、置顶/取消置顶、删除。
- 清空：二次确认，`pinned` 项保留。
- 搜索：按关键词（文字内容 / 文件名）。
- 实时更新：后端经 SSE 推送 `history-changed`，两个界面即时刷新。
- **回贴**：文字→`Set-Clipboard`；图片→`DataObject` 设 Image；文件→写文件清单。

### B6. 全局快捷键悬浮面板（Rust + 插件）
- 新增 `tauri-plugin-global-shortcut`，启动时按平台设置文件里的值注册（默认 `Ctrl+Shift+V`）。
- 热键触发 → Rust 命令 `open_quick_panel()`：
  1. 确保工具运行且拿到端口（host `GET /tools/clipboard-history`；未运行先 `start_tool`）；
  2. 用 `WebviewWindowBuilder` 创建/复用 `clipboard-quick` 窗口，加载 `http://127.0.0.1:<port>/quick.html`，尺寸约 380×560、always-on-top、无边框、失焦不关（便于连续粘贴）、Esc 隐藏。
- 热键冲突/非法时返回中文错误，由设置页提示。

### B7. 设置项
- 工具 `settings.json`：`monitoringEnabled`、`maxEntries(200)`、`maxImages(50)`、`pollIntervalMs(300)`、`dedupe(开)`、`showSourceApp`、`keepPinnedOnClear`。
- **全局快捷键**为平台级配置（存平台 `settings.json`，Rust 支配），不在工具 settings.json；工具设置页经 postMessage 桥读写它（见 B8）。

### B8. 工具 iframe ↔ 平台 postMessage 桥（让工具调到平台能力）
工具跑在 iframe（跨源），拿不到 Tauri `invoke`。为此平台 [App.vue](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/App.vue) 监听 `message` 事件，支持：
- 请求：`{ type:"platform:get-hotkey" }` / `{ type:"platform:set-hotkey", accel }`。
- 平台侧校验来源（仅允许本机工具端口源），转调 `get_clipboard_hotkey`/`set_clipboard_hotkey` 命令，再把结果 `postMessage` 回工具。
- 工具侧在**非平台环境**（单独浏览器跑、无法访问 parent 平台）时优雅降级：热键设置项灰显并提示“需在平台内使用”。

---

## 五、实现步骤（文件级改动清单）

### E 组：平台层改动
1. **[src-tauri/Cargo.toml](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/Cargo.toml)**：`tauri` 加 feature `"tray-icon"`；新增 `tauri-plugin-global-shortcut = "2"`。
2. **[src-tauri/src/lib.rs](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/src/lib.rs)**：托盘（动态菜单）+ 关窗拦截 + `.plugin(global_shortcut)` + 命令 `hide_to_tray`/`quit_app`/`open_quick_panel`/`get_clipboard_hotkey`/`set_clipboard_hotkey` + 启动时按平台 settings 注册热键 + 托盘“后台工具”联动 + 保留 shutdown_host。
3. **[src-tauri/capabilities/default.json](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/capabilities/default.json)**：加 `global-shortcut:default`（含 `register`/`unregister`）。
4. **[src-tauri/resources/host/host.js](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/resources/host/host.js)**：`loadManifest` 透出 `autoStart`；启动时自拉起 `autoStart` 工具（best-effort）；`GET /tools` 已能返回运行状态/端口供托盘与快速面板用。
5. **[commands/tools.rs](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src-tauri/src/commands/tools.rs)**：`start_tool`/`stop_tool` 成功后触发托盘菜单重建（通过 emit 或调用刷新函数）。
6. **[src/api/tauri.ts](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/api/tauri.ts)** + **[src/App.vue](file:///c:/Users/WuFeng/Desktop/project/AiTest/ccp/tools/src/App.vue)**：新命令封装；关闭弹窗（记住选择）；`open-tool` 事件导航；**postMessage 桥**（`platform:get-hotkey`/`set-hotkey` → invoke Rust，回传工具）。

### C 组：剪贴板工具本体 `example/clipboard-history/`
7. `manifest.json`：`{ id:"clipboard-history", name:"剪贴板历史", description:"后台记录复制历史（文字/图片/文件）", main:"app.js", html:"index.html", port:0, autoStart:true }`。
8. `app.js`：PowerShell 常驻采集、去重、双上限淘汰、持久化、SSE、REST API、回贴逻辑。
9. `index.html` + `front.js` + `styles.css`：完整管理页（列表/筛选/置顶/删除/清空/设置）。设置页含**全局快捷键设置项**（点击捕获组合键 → 经 postMessage 桥调用 set；非平台环境灰显）。
10. `quick.html` + `quick.js`（或同文件 `#quick` 分支）：悬浮面板（过滤 + 点击复制不关闭）。
11. `README.md`：安装/使用说明 + 安全提示（本地明文存储，参照 ssh 示例）。

---

## 六、验证步骤
1. `cargo build` / `npm run tauri dev` 通过，托盘图标出现。
2. **需求 A**：关窗弹窗（后台/退出 + 记住选择）；后台 → 隐藏 & 托盘仍在，工具端口/状态不变，恢复后工具照常；退出 → 无残留 node.exe；勾选记住后下次直接按选择执行；托盘右键出现 `后台工具 ▸`，点击某后台工具 → 主窗口显示并进入该工具。
3. **需求 B**：
   - 复制文字/图片/文件 → 历史即时出现（缩略图/清单正确）。
   - **连按 Ctrl+C 同内容 N 次 → 列表只有一条并置顶**（去重生效）。
   - 设 `maxEntries=3` 复制 4 条 → 最旧被淘汰（置顶除外）；`maxImages` 同理。
   - 重启应用 → 历史仍在；损坏的 history.json 不导致工具崩溃。
   - 完整页搜索/筛选/置顶/暂停/清空生效；悬浮面板 `Ctrl+Shift+V` 呼出、点击写回剪贴板且**面板不关闭**、Esc 收起。
   - **改全局快捷键**（如 → `Ctrl+Alt+V`）：旧的失效、新的生效；重启后仍按新键生效；非法/占用组合返回中文错误并保持在设置页提示。
   - 后台（关窗最小化）后继续复制 → 仍录入（验证后台常驻）。
4. 无残留：退出后 taskkill 无 node.exe / powershell 子进程残留。

## 七、不在本期
云同步；敏感内容过滤/忽略应用（已确认暂不做，留好设置入口）；富文本 HTML 还原；OCR 识别图片文字；片段模板/常用语；来源应用按 App 分组；TTL 自动清理；来源应用名（sourceApp 尽力实现，若 PowerShell 取前台窗口不稳定则降级为空）。