# Checklist

## 工具骨架与平台集成
- [x] `example/consciousness-stream/manifest.json` 存在且字段合法：`id=consciousness-stream`、`main=app.js`、`html=index.html`、`port=0`、`autoStart=true`
- [x] manifest 中 `shortcuts[0]` 为 `id=toggle-panel`、`accel=alt+x`、`action=toggle-panel`，且 `accel` 主键在平台支持列表内（`x` 在 `key_to_code` 中）
- [x] manifest 中 `panels[0]` 为 `id=main`、`page=index.html`，面板尺寸为 360×540
- [x] 后端 `POST /__platform/shortcut` 收到 `toggle-panel` 时写出 `.quick-toggle`（内容 `{"panelId":"main"}`，实测通过）
- [x] 后端 `POST /api/panel-close` 写出 `.quick-close`（内容 `{"panelId":"main"}`，实测通过）

## 核心功能
- [x] 输入框回车可新增条目，新增后输入框清空并保持聚焦（浏览器实测：1→2 / 20）
- [x] 进度条显示 `当前/20`，满 20 显示"你并不空洞 ✨"（`app-ui.js` 第 276 行）
- [x] 条目悬停出现 复制 / 完成 / 删除；复制写入系统剪贴板并短暂显示 ✓（含 `execCommand` 兜底）；完成移入已完成；删除移除该条（接口实测通过）
- [x] 条目可拖拽排序，顺序被持久化（`POST /api/items/reorder` 实测：倒序后首条与预期一致）
- [x] 存在已完成条目时，底部显示可折叠"已完成"区，条目带删除线且可单条删除
- [x] ☰ 打开全部清单覆盖层，支持切换 / 新建 / 重命名 / 删除；删除当前清单后自动切到最近一个（实测：删除后 active 变为 `mu6k53rpmdh49rv3dl`）
- [x] 主题面板含 9 预设、自选取色、保存、随机、炫彩、流光、明暗切换；效果实时作用并持久化（9 预设色与各按钮均在 `app-ui.js` 中；`POST /api/theme` 明暗切换实测通过）
- [x] 已保存色可复用与删除（`/api/saved-colors`、`/api/saved-colors/delete` 实测通过）

## 迁移
- [x] `POST /api/legacy/export` 能读取即意存储文件（含回退路径）并写出 `legacy/legacy-export-<ts>.json`（实测生成 `legacy-export-20261006-205835.json`）
- [x] 源文件缺失时导出返回明确错误（`404` + 中文提示），且不产生空快照文件（代码：先 `existsSync` 判定，缺失即 `return`，不写文件）
- [x] `POST /api/legacy/import` 能读取快照、转换并合并写入 `data.json`，重复会话去重、非法条目跳过
- [x] 迁移生成的 `example/consciousness-stream/data.json` 与源数据一致：6 个清单、当前清单 = 我的量化、`themeColor=#6b47e1`、`themeMode=light`、`flowMode=true`、`savedColors=["#6b47e1"]`
- [x] 工具启动即加载 `data.json`，界面展示原有清单数据（`loadData()` 在启动时调用；接口返回我的量化 4 条目 / 5 已完成）

## 持久化与文档
- [x] 重启工具/平台后清单与主题设置从 `data.json` 恢复（`loadData()` 从文件读取，运行期写入同一文件）
- [x] `example/consciousness-stream/README.md` 说明功能、`alt+x` 热键、安装到 toolbox 步骤、迁移用法与平台能力限制（边缘隐藏/托盘/`Alt+=`/窗口缩放）
- [x] `node app.js` 本地独立起服务自测通过（未注入 `TOOL_PORT` 时默认 3900；静态页与全部接口返回 200 / ok:true）
- [x] 未改动平台 Rust（`src-tauri/`）与平台前端（`src/`）任何代码（`git status -- src-tauri src` 无变更）