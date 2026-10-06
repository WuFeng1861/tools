# 即意（意识流清单）工具接入 Spec

## Why

本地独立运行的 Electron 应用「即意 / consciousness-stream」提供了随手记录想法的悬浮窗体验，但它自成一套进程、托盘与热键，无法纳入 tools 小工具平台统一管理。需要把它的核心能力以平台工具（Node 后端 + 原生 HTML/JS 界面）的形式重做，接入平台全局热键唤出悬浮面板，并把它已经保存的历史数据迁移进来。

## What Changes

- 新增平台工具 `example/consciousness-stream/`，忠实复刻即意的核心能力：
  - 输入条目（回车连续录入）、进度指示（`x / 20`，满 20 提示"你并不空洞 ✨"）
  - 清单列表：条目复制 / 完成 / 删除、拖拽排序
  - 已完成折叠区（删除线、可单条删除）
  - 全部清单覆盖层：新建 / 切换 / 重命名 / 删除
  - 主题色系统：9 个预设色、自选取色、保存当前色、随机、炫彩（彩虹循环）、流光（正弦色相流动）、明暗模式
  - 本地持久化（工具目录 `data.json`）
- `manifest.json` 声明全局快捷键与悬浮面板：默认 `alt+x`，**按一次唤出、再按一次收起**（平台按面板可见性反转）；面板内 `Esc` / 右上角 `×` 收起。
- 后端新增旧数据迁移：读取 `%APPDATA%\即意\consciousness-stream.json`，导出并保存快照到工具目录 `legacy/`，再转换为本工具数据结构写入工具目录 `data.json`。
- **明确不迁移 / 平台不支持**（原应用能力，但平台未向工具开放，需在 README 说明）：
  - 边缘隐藏（拖到屏幕边缘自动隐藏、鼠标靠近滑出）——平台不允许工具移动自身窗口
  - 独立系统托盘 —— 由平台托盘"后台工具"统一承载
  - `Alt + =` 默认热键 —— 平台按键解析器不支持 `=` 主键，改为 `alt+x`
  - 面板尺寸可拖拽缩放 —— 平台面板尺寸由 manifest 固定、`resizable(false)`

## Impact

- Affected specs（平台既有约定，本次只消费不修改）：
  - 工具 manifest 的 `shortcuts` / `panels` / `autoStart` 字段
  - 面板标记文件协议 `.quick-toggle`（按可见性反转开/关）、`.quick-close`（收起）
  - 工具后端 `ToolServer` 运行时（`process.env.TOOL_RUNTIME`、`process.env.TOOL_PORT`）
- Affected code：新增 `example/consciousness-stream/*`；**不改动**平台 Rust（`src-tauri/`）与平台前端（`src/`）任何代码。

## ADDED Requirements

### Requirement: 即意核心记录功能

系统 SHALL 在 `example/consciousness-stream/` 下提供一个平台工具，实现即意的条目记录与清单管理能力。

#### Scenario: 新增条目
- **WHEN** 用户在输入框输入内容并按回车
- **THEN** 后端在"当前清单"追加一条 item，前端列表实时出现该条，输入框清空并保持聚焦

#### Scenario: 进度显示
- **WHEN** 当前清单条目数为 n
- **THEN** 进度条显示 `n / 20`（进度 = min(n/20, 1)）；n ≥ 20 时显示"你并不空洞 ✨"

#### Scenario: 条目操作
- **WHEN** 鼠标悬停某条
- **THEN** 显示 复制 / 完成 / 删除 三个按钮
- **AND** 复制把内容写入系统剪贴板并短暂显示 ✓；完成把该条移入"已完成"；删除移除该条

#### Scenario: 拖拽排序
- **WHEN** 用户按住某条上下拖动并松开到新位置
- **THEN** 顺序更新并持久化

#### Scenario: 已完成区
- **WHEN** 当前清单存在已完成条目
- **THEN** 列表底部显示可折叠的"已完成"区（带数量徽标），条目带删除线，可单条删除

#### Scenario: 全部清单
- **WHEN** 用户点标题栏 ☰
- **THEN** 展开覆盖层，按创建时间倒序展示全部清单，支持切换 / 新建 / 重命名 / 删除
- **AND** 删除当前清单后自动切换到剩余清单中最近创建的一个

#### Scenario: 主题色
- **WHEN** 用户点击底部色点
- **THEN** 弹出主题面板：9 个预设色、自选取色器、保存当前色、随机色、炫彩、流光、明暗模式切换
- **AND** 主题变化实时作用于整个界面（CSS 变量）并持久化；已保存色可复用与删除

### Requirement: 全局热键唤出悬浮面板

系统 SHALL 通过平台全局快捷键唤出/收起即意的悬浮面板，且单次按键即可完成切换。

#### Scenario: 唤出与收起
- **WHEN** 用户按下 `alt+x`
- **THEN** 平台把事件转发给工具后端 `POST /__platform/shortcut`，后端写 `.quick-toggle` 标记；平台按面板当前可见性反转（按一次开、再按一次关）

#### Scenario: 面板内关闭
- **WHEN** 用户在面板内按 `Esc` 或点右上角 `×`
- **THEN** 前端请求 `POST /api/panel-close`，后端写 `.quick-close` 标记，平台收起面板

#### Scenario: 输入聚焦
- **WHEN** 面板被唤出
- **THEN** 输入框自动聚焦，用户可直接输入

#### Scenario: 后台常驻
- **WHEN** 平台启动
- **THEN** 因 `manifest.autoStart = true`，工具自动在后台运行，保证热键随时可用

### Requirement: 旧数据迁移

系统 SHALL 提供"先导出保存、再导入"的迁移能力，把即意已有数据搬迁到本工具。

#### Scenario: 导出
- **WHEN** 触发 `POST /api/legacy/export`
- **THEN** 读取 `%APPDATA%\即意\consciousness-stream.json`（缺失时回退 `%APPDATA%\consciousness-stream\consciousness-stream.json`），把原始快照保存到工具目录 `legacy/legacy-export-<时间戳>.json`
- **AND** 返回摘要 `{ source, path, sessions, items, completed }`；源文件缺失时返回明确错误

#### Scenario: 导入
- **WHEN** 触发 `POST /api/legacy/import`
- **THEN** 读取 `legacy/` 下最新（或指定 `path`）快照，转换为本工具数据（`sessions` / `activeSessionId` / `themeColor` / `rainbowMode` / `flowMode` / `savedColors` / `themeMode`），合并写入工具目录 `data.json`
- **AND** 返回摘要；对重复 id 的会话做去重，非法条目跳过而不影响其余数据

#### Scenario: 首次运行即带数据
- **WHEN** 工具目录已存在迁移生成的 `data.json`
- **THEN** 启动即加载该数据，用户看到原有清单（当前为 6 个清单）

### Requirement: 本地持久化

系统 SHALL 把清单与主题设置持久化到工具目录文件，重启不丢失。

#### Scenario: 重启保留
- **WHEN** 工具或平台重启
- **THEN** 从 `data.json` 恢复全部清单、当前清单与主题设置

## MODIFIED Requirements

无（不修改平台既有需求）。

## REMOVED Requirements

无（不删除平台既有需求）。即意的边缘隐藏、独立托盘属"不迁移"范围，见 What Changes。