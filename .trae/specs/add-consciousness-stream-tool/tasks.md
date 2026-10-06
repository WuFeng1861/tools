# Tasks

- [x] Task 1: 搭建工具骨架
  - [x] SubTask 1.1: 新建 `example/consciousness-stream/manifest.json`：`id: "consciousness-stream"`、`name: "即意"`、`main: "app.js"`、`html: "index.html"`、`port: 0`、`autoStart: true`
  - [x] SubTask 1.2: `shortcuts` 声明 `{ id: "toggle-panel", name: "唤起 / 收起 即意", accel: "alt+x", action: "toggle-panel" }`
  - [x] SubTask 1.3: `panels` 声明 `{ id: "main", page: "index.html", title: "即意", width: 360, height: 540 }`
  - [x] SubTask 1.4: 新建 `package.json`（零依赖）与 `app.js` 骨架（运行时三级回退：`TOOL_RUNTIME` → 仓库 `runtime.js` → 内置最小实现，`server.start(port)`）

- [x] Task 2: 实现后端数据层与业务 REST API
  - [x] SubTask 2.1: 数据模型与持久化：`data.json` 沿用即意 schema（`sessions` / `activeSessionId` / `themeColor` / `rainbowMode` / `flowMode` / `savedColors` / `themeMode` + `windowWidth/Height`）；缺失/损坏回退默认值；写入用临时文件 + 原子替换
  - [x] SubTask 2.2: 会话接口：`GET /api/state`、`GET /api/session`、`POST /api/session/new`、`POST /api/session/select`、`POST /api/session/rename`、`POST /api/session/delete`
  - [x] SubTask 2.3: 条目接口：`POST /api/items`、`POST /api/items/delete`、`POST /api/items/reorder`、`POST /api/items/complete`、`POST /api/completed/delete`（平台 `ToolServer` 仅支持精确路径匹配、不支持 `:param`，故 id 走请求体）
  - [x] SubTask 2.4: 主题接口：`GET/POST /api/theme`、`GET /api/saved-colors`、`POST /api/saved-colors`、`POST /api/saved-colors/delete`
  - [x] SubTask 2.5: `SSE /api/events` 推送 `ready` 与 `state-changed`（20s 心跳），所有变更路由 `save()` + `broadcast()`

- [x] Task 3: 实现平台集成接口
  - [x] SubTask 3.1: `POST /__platform/shortcut`：识别 `action === "toggle-panel"` 时写 `.quick-toggle`（`{"panelId":"main"}`）
  - [x] SubTask 3.2: `POST /api/panel-close`：写 `.quick-close`（`{"panelId":"main"}`），供面板 `×` / `Esc` 收起

- [x] Task 4: 实现前端界面（index.html + styles.css + app-ui.js）
  - [x] SubTask 4.1: 复刻即意视觉体系：`:root` 主题 CSS 变量（hsl 色相/饱和度/明度 + 各级 alpha）、`data-theme` 明暗模式、毛玻璃透明背景
  - [x] SubTask 4.2: 标题栏（`data-tauri-drag-region` 拖拽区 + ☰ + ─/× 隐藏）、输入区（回车提交、保持聚焦）、进度条
  - [x] SubTask 4.3: 流清单：悬停显示 复制/完成/删除、拖拽排序（虚线幽灵预览）、进入/离开动画
  - [x] SubTask 4.4: 已完成折叠区 + 全部清单覆盖层（新建/切换/重命名/删除，使用界面内自绘确认框，无 `window.confirm`）
  - [x] SubTask 4.5: 主题面板：9 预设 / 自选 color input / 保存 / 随机 / 炫彩 / 流光 / 明暗切换，逻辑与即意 `App.vue` 一致
  - [x] SubTask 4.6: 面板内 `Esc` 与 `×`（含 `─`）调 `/api/panel-close` + Tauri `hide_quick_panel` 兜底；监听 SSE 保持多实例一致；`focus`/`visibilitychange` 时重新聚焦输入框

- [x] Task 5: 实现旧数据迁移能力（后端接口 + 前端入口）
  - [x] SubTask 5.1: `POST /api/legacy/export`：读 `%APPDATA%\即意\consciousness-stream.json`（回退 `%APPDATA%\consciousness-stream\consciousness-stream.json`），保存原始快照到 `legacy/legacy-export-<时间戳>.json`；源缺失时报错且不落空文件
  - [x] SubTask 5.2: `POST /api/legacy/import`：读取 `legacy/` 最新（或指定）快照，转换并合并写入 `data.json`，返回导入摘要；重复会话 id 去重、非法条目跳过
  - [x] SubTask 5.3: 界面加"旧数据迁移"入口（检查 → 导出 → 导入 → 显示摘要，自绘弹窗）

- [x] Task 6: 执行实际迁移（一次性）
  - [x] SubTask 6.1: 对当前机器的即意数据跑导出，生成 `example/consciousness-stream/legacy/legacy-export-20261006-205835.json`（源 `%APPDATA%\即意\consciousness-stream.json`，6 清单 / 17 条目 / 11 已完成）
  - [x] SubTask 6.2: 跑导入逻辑，生成 `example/consciousness-stream/data.json`，与源一致：6 个清单（我想要 / 我的量化 / 新量化相关 / 预测项目 / 股票 / bug）；当前清单 = 我的量化；主题 = `#6b47e1`、`themeMode: light`、`flowMode: true`、`savedColors: ["#6b47e1"]`

- [x] Task 7: 文档与自测
  - [x] SubTask 7.1: 编写 `example/consciousness-stream/README.md`：功能、热键 `alt+x`、安装到 toolbox 步骤、迁移说明、平台能力限制（边缘隐藏/托盘/`Alt+=`/窗口缩放）
  - [x] SubTask 7.2: 自测：`node app.js` 起服务（未注入 `TOOL_PORT` 时默认 3900，已修复原 `server.start()` 忽略端口的问题），逐一验证全部接口与页面；用写 `.quick-toggle` / `.quick-close` 标记文件模拟热键与收起逻辑（均在临时副本上验证，不污染交付数据）

# Task Dependencies

- Task 2 是 Task 4、Task 5 的前置
- Task 5 是 Task 6 的前置
- Task 6 依赖 Task 5 完成
- Task 3 与 Task 4、Task 5 无依赖，可并行
- Task 4 与 Task 5 在 Task 2 完成后可并行
- Task 7 依赖 Task 4、Task 5、Task 6 完成