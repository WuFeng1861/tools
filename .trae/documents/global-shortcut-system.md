# 改造方案：全局快捷键系统

## Context（为什么做这个改造）

当前平台只有一个「写死」的全局快捷键 `Ctrl+Shift+V`，硬编码绑定到剪贴板历史工具，唤起它的无边框悬浮面板（见 `src-tauri/src/lib.rs` 的 `register_default_shortcut` / `toggle_quick_panel` / `ensure_quick_panel`）。

需求：升级成一套**通用的全局快捷键注册表**，让任意工具都能在 `manifest.json` 里静态声明**多个**快捷键（每把对应一个不同动作）；所有快捷键在一个集中界面统一查看/修改，修改时**自动检测组合键冲突**。

用户已拍板的三点方向：
1. **快捷键来源**：工具在 `manifest.json` 静态声明（`shortcuts` 数组）。
2. **触发动作**：按下后平台把事件派发给对应工具进程（**纯通用事件**），由工具决定响应。
3. **配置界面**：主界面新增独立「快捷键」页，并在 ⚙️ 设置里加入口。

## 关键设计决定（基于用户反馈修订）

**悬浮窗交给用户代码，平台不把「面板」绑定到快捷键动作上。**

原因：窗口（Webview）只能由平台创建——工具的 Node 进程没有 Tauri API，仅有 HTTP 与 host 通信。因此：
- **快捷键动作只有一种语义 = 事件转发**，没有任何内置「弹面板」类型。
- **悬浮窗被抽成平台通用原语 `open_tool_panel(toolId, panelId)`**，但**何时弹、弹哪个面板、何时收起，完全由工具的用户代码决定**。平台不因某个快捷键而自动建窗。
- 由于工具进程无法直接调 Tauri 命令，采用**与现有 `.quick-close` 对称的标记协议**：工具想弹窗就写 `.quick-open` 标记，平台轮询到后调用 `open_tool_panel` 建/显窗；想收起写 `.quick-close`（沿用现状）。

这样既满足「仅通用事件」，又让面板新建权归用户代码，且任何工具都能复用。

---

## manifest.json 新增字段

**1) `shortcuts`（键盘快捷键，纯事件）**

```json
"shortcuts": [
  { "id": "toggle-quick", "name": "唤起/收起快速面板",
    "accel": "ctrl+shift+v", "action": "toggle-quick" }
]
```
字段：`id`（工具内唯一）、`name`（动作名，配置页显示）、`accel`（默认组合键）、`action`（任意描述串，按下时原样透传给工具的 event 端点）。

**2) `panels`（悬浮窗元数据，可选；与快捷键无关，纯窗口描述）**

```json
"panels": [
  { "id": "quick", "page": "quick.html", "title": "剪贴板",
    "width": 380, "height": 560 }
]
```
字段：`id`、`page`（工具内 HTML 页）、`title`、`width`/`height`。平台据其建窗，但**不绑定任何快捷键**——由用户代码随时请求展示。

---

## 事件与面板协议

**事件派发**：按下某快捷键 → 平台经 host 转发 `POST http://127.0.0.1:{toolPort}/__platform/shortcut`（body `{ shortcutId, action }`）→ 工具 app.js 的 `ToolServer` 路由自行响应。工具不响应也不报错。

**面板请求**（工具进程 → 平台，因无 Tauri API 用标记）：
- 写入该工具目录 `.quick-open`（内容 JSON，如 `{"panelId":"quick"}`）→ 平台轮询到则 `open_tool_panel(toolId, panelId)`（已开则前台聚焦）。
- 写入 `.quick-close` → 平台轮询隐藏（沿用现有 400ms 轮询，仅泛化为扫所有工具而非写死剪贴板）。
- 面板页自身若想关窗，维持 `fetch("/api/panel-close")` → 写 `.quick-close` 的现有习惯。

前端（平台 UI 或工具 iframe，有 Tauri API 处）可直接调 `open_tool_panel` / `hide_tool_panel` 命令。

---

## 改动清单

### 1. 宿主 host.js
- `loadManifest()`：把 `shortcuts`、`panels` 数组透传挂到返回的 manifest 对象上（`listTools` 随之带上）。
- 新增端点 `POST /tools/:id/shortcut`（body `{ shortcutId, action }`）：工具有运行端口则转发 `POST http://127.0.0.1:{port}/__platform/shortcut` 并返回；未运行返回 `ok:false`。

### 2. 平台 Rust（src-tauri）
核心：单快捷键 → 快捷键注册表 + 通用面板原语。

**内部模型（lib.rs）**：
- `ShortcutEntry { tool_id, shortcut_id, name, action, accel, conflict }`
- `PanelSpec { tool_id, panel_id, page, title, width, height }`
- 扩展 `SettingsState`：`registry: Mutex<Vec<ShortcutEntry>>` + `registered: Mutex<HashMap<String, Shortcut>>`（accel → 已注册 tauri Shortcut）。
- 持久化：`settings.json` 增 `shortcutOverrides: { "toolId:shortcutId": "ctrl+shift+v" }`（在 `write_settings` 同文件新增读写 helper）。

**新逻辑**：
- `sync_shortcuts(app)`：读 host `GET /tools` → 重建 registry（默认 accel + override）→ 冲突检测（同 accel 多条占用 → conflict）→ 用 `app.global_shortcut().on_shortcut(...)` 注册无冲突项、注销已移除/冲突项；按下回调 → event 转发到 host `/tools/:id/shortcut`。
- `ensure_tool_panel(app, tool_id, panel_id)`：泛化自 `ensure_quick_panel`（读 manifest panels 取 page/title/size；保证工具运行取端口；`WebviewWindowBuilder` 建无边框置顶窗，可复用）。
- `.quick-open` 轮询：读各面板工具目录标记 → 调 `ensure_tool_panel`；`.quick-close` 轮询泛化到所有工具。

**新命令**：
- `list_shortcuts()` → 合并所有工具声明 + 解析 accel + 冲突/注册/工具运行状态，供前端。
- `set_shortcut_accel(tool_id, shortcut_id, accel)` → 校验可解析且未与其它项冲突 → 写 override → 重注册。
- `reset_shortcut_accel(tool_id, shortcut_id)` → 恢复默认。
- `open_tool_panel(tool_id, panel_id)` / `hide_tool_panel(tool_id)`（泛化自 open/hide_quick_panel）。
- 兼容保留 `get_clipboard_hotkey` / `set_clipboard_hotkey`，改为作用到剪贴板第一个快捷键，避免剪贴板 `front.js` 现有设置 UI 失效。

**setup()**：在 3s 刷盘循环宿主就绪时追加 `sync_shortcuts`；`.quick-open`/`.quick-close` 轮询按 registry 泛化。

### 3. 剪贴板工具（example/clipboard-history）
- `manifest.json`：增 `shortcuts[ toggle-quick / ctrl+shift+v ]` 与 `panels[ quick → quick.html ]`。
- `app.js`：新增 `/__platform/shortcut` 路由——收到 `toggle-quick` 时若 `.quick-open` 已存在则写 `.quick-close`，否则写 `.quick-open`（即「唤起/收起」由工具代码决定，平台只执行请求）。
- `quick.js`/`index.html`/`front.js`：基本不动（关窗仍走 `/api/panel-close`；快捷键设置 UI 走旧兼容命令）。

### 4. 前端
- `src/types.ts`：`ToolInfo` 增 `shortcuts?`/`panels?`；新增 `ShortcutInfo`。
- `src/api/tauri.ts`：`listShortcuts` / `setShortcutAccel` / `resetShortcutAccel` / `openToolPanel` / `hideToolPanel`；保留旧方法。
- `src/router.ts`：增 `/shortcuts` → `ShortcutsView.vue`。
- 新视图 `src/views/ShortcutsView.vue`：按工具分组列出快捷键（工具、动作名、当前组合键、冲突标红、注册状态、工具是否运行）；每一项可点击录制新组合键 → `setShortcutAccel`，冲突红字；可「恢复默认」。
- `LauncherView.vue` 顶栏：增「⌨️ 快捷键」按钮 → `router.push('shortcuts')`。
- `SettingsView.vue`：增「快捷键」入口跳转。

---

## 冲突检测规则
- 同一 accel ≥2 条声明占用 → 相关项标记 conflict、不注册、界面标红。
- `app.global_shortcut().register` 报错（系统/其它程序占用）→ 该项不注册、提示「已被占用」。
- 修改时先校验可解析且未被其它项占用，通过才落库重注册。

## 验证方式
1. `npm run dev` + `npm run tauri:dev` 起应用。
2. 「快捷键」页看到剪贴板历史 + `Ctrl+Shift+V`（注册成功）。
3. 按 `Ctrl+Shift+V` → 剪贴板 app.js 收到事件 → 写 `.quick-open` → 平台弹窗（旧交互恢复）。
4. 配置页改快捷键 → 旧键失效新键生效；设为另一工具已占用键 → 即时标红并拦截。
5. 新建临别测试工具：两把快捷键 + 一个 panel；验证事件转发日志、面板可弹起。
6. `npm run build:release` 打包重启全链路。