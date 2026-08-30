# 小工具平台 — 设计方案

> 基于 **Tauri 2 + Sidecar + Node.js** 的桌面小工具平台。
> 用户可用 **Node.js + HTML** 自写小工具，从主页面图标点入运行；工具之间进程/端口/界面相互隔离；可在应用内为工具安装任意 npm 库。

---

## 1. 目标与定位

- **壳**：Tauri 桌面应用（Windows 上基于 WebView2），提供窗口、进程管理、文件读写。
- **工具运行时**：每个工具 = 一个**独立 Node 进程** + **一个独立本机端口** + **一份 HTML 界面**。
- **主页面（启动器）**：工具图标网格，点击进入对应工具的独立界面（iframe 内嵌）。
- **依赖管理**：专门的页面，为某个工具搜索 / 安装 / 卸载 / 列出 npm 包。
- **工具创作**：既支持平台内置编辑器，也支持外部编辑器写好代码放入目录后自动扫描发现。

### 非目标（v1 不做）
- 工具不直接调用 Tauri 原生能力（对话框/剪贴板/托盘）。Node 的 `fs` / `http` / `net` / npm 生态已覆盖绝大多数小工具需求。原生能力桥接列为 v2 扩展点。
- 不做工具市场/云端分发，全部本地。

---

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Tauri 前端 (Vue 3 + Vite + TS)   src/                           │
│    LauncherView   工具图标网格（启动器 / 主页面）                  │
│    ToolRunnerView 工具运行容器（iframe 内嵌工具 UI）              │
│    ToolEditorView 内置编辑器（文件树 + 代码编辑 + 新建向导）        │
│    DependenciesView 依赖管理（安装 / 卸载 / 列表 npm 包）          │
└───────────────┬─────────────────────────────────────────────────┘
                │ ① 前端 → Rust：Tauri invoke 命令
                │    (list_tools / start_tool / install_package / ...)
┌───────────────▼─────────────────────────────────────────────────┐
│  Tauri 核心 (Rust)  src-tauri/                                   │
│    · 命令层：工具管理、依赖管理、工具文件读写、日志查询            │
│    · sidecar：spawn node.exe（打包的 Node 运行时）                │
│    · 资源目录注入：把 host/host.js、runtime/ 暴露给 Node           │
└───────────────┬─────────────────────────────────────────────────┘
                │ ② Rust → 宿主：HTTP 管理接口 (127.0.0.1:<随机口>)
┌───────────────▼─────────────────────────────────────────────────┐
│  工具宿主 host.js (Node, sidecar 解释器)                          │
│    · 扫描 / 注册 / 启动 / 停止工具进程                            │
│    · 分配端口、注入环境变量、捕获日志（环形缓冲 + 落盘）           │
│    · npm 包安装 / 卸载 / 列表（spawn npm-cli）                    │
└───────────────┬─────────────────────────────────────────────────┘
                │ ③ 宿主 spawn：每工具一个 node.exe 子进程
        ┌───────▼────────┐  ┌────────▼────────┐   ...
        │ 工具 A (node)   │  │ 工具 B (node)   │
        │ app.js 开 HTTP  │  │ app.js 开 HTTP  │
        │ 127.0.0.1:PA    │  │ 127.0.0.1:PB    │
        │ serve index.html│  │ serve index.html│
        └───────┬────────┘  └────────┬────────┘
                │ ④ 工具 UI fetch 自己的 API（同源，无 CORS 问题）
                ▼
   ToolRunnerView 里的 iframe src="http://127.0.0.1:<port>"
```

**数据流要点**
- 前端 **管理功能**（启动器/依赖/编辑）走 `invoke → Rust → 宿主 → 工具/文件系统`。
- 前端 **工具运行 UI** 不走 IPC：iframe 直接加载 `http://127.0.0.1:<port>`，工具页面的 JS 与自家 Node 进程同源通信。
- 工具进程间靠「独立进程 + 独立端口 + iframe」三重隔离，一个工具崩溃不影响平台和其它工具。

---

## 3. 技术选型

| 部分 | 选型 | 理由 |
|---|---|---|
| 桌面壳 | Tauri 2.x | 体积小（数 MB）、Rust 可靠、sidecar 原生支持 |
| 平台前端 | Vue 3 + Vite + TypeScript | 管理界面组件化；工具页面不受影响 |
| 工具运行时 | **官方 Node.js 作为 sidecar**（`node.exe`） | 用户代码就是 Node，npm 生态直接可用，无需转译 |
| 工具宿主 | Node 脚本 `host.js`（随 sidecar 运行） | 统一管理工具生命周期与依赖安装，Rust 只跟一个宿主通信 |
| 工具间通信 | 每个工具独立 `127.0.0.1` 随机端口 + HTTP | 与 iframe 组合天然隔离，符合"独立小应用"心智 |
| Rust↔宿主 | HTTP JSON（宿主开随机端口） | 简单可靠，便于调试；宿主端口写入运行时文件供 Rust 读取 |
| 内置编辑器 | v1 轻量方案（textarea + 行号 + 轻高亮） | 控制打包体积；v2 可换 Monaco |

### Sidecar 打包说明
- 将本机 `node.exe` 复制为 `binaries/node-x86_64-pc-windows-msvc.exe`，配置进 `bundle.externalBin`。Tauri 要求 externalBin 文件名带 target triple 后缀。
- `host/host.js` 与 `runtime/` 通过 `bundle.resources` 打包，运行时经 `app.path().resource_dir()` 读取。
- `tauri-plugin-shell` 的 `Command::new_sidecar("node")` 启动宿主：
  `node.exe <resource>/host/host.js`
- 体积：node.exe 压缩后约 40–60 MB，可接受；后续可用更精简的 Node 发行版或压缩层进一步优化。

---

## 4. 目录结构

```
tools/                          # 项目根（当前目录）
├── DESIGN.md                   # 本方案
├── package.json                # 前端依赖 + 脚本（dev/build/tauri 命令）
├── vite.config.ts
├── index.html
│
├── src-tauri/                  # Rust 端
│   ├── Cargo.toml
│   ├── tauri.conf.json         # externalBin / resources / CSP / 主窗口
│   ├── capabilities/default.json
│   ├── icons/
│   └── src/
│       ├── main.rs
│       ├── lib.rs
│       ├── sidecar.rs          # 宿主进程生命周期管理（启动/检测/重启）
│       ├── commands/
│       │   ├── mod.rs
│       │   ├── tools.rs        # list/create/read/write/start/stop/logs
│       │   └── packages.rs     # install/uninstall/list
│       └── models.rs           # ToolInfo/PackageInfo 等结构
│
├── src/                        # Vue 3 平台前端
│   ├── main.ts
│   ├── App.vue
│   ├── router.ts
│   ├── api/tauri.ts            # invoke 封装（全部命令入口）
│   ├── types.ts                # ToolInfo / PackageInfo 等
│   └── views/
│       ├── LauncherView.vue    # 主页面：工具网格、新建、依赖管理入口
│       ├── ToolRunnerView.vue  # iframe 工具容器 + 状态栏（停止/日志）
│       ├── ToolEditorView.vue  # 文件树 + 编辑器 + 新建工具向导
│       └── DependenciesView.vue# 选工具 → 搜索 npm → 安装/卸载/列表
│
├── host/                       # 工具宿主（打包为 resource，随 node.exe 运行）
│   ├── host.js                 # HTTP 管理服务 + 工具进程管理 + npm 封装
│   ├── npm.js                  # npm install/uninstall/list（spawn npm-cli.js）
│   └── portpool.js             # 随机端口分配/回收
│
├── runtime/                    # 工具运行时帮助库（打包为 resource）
│   └── runtime.js              # 注入给工具进程，提供静态服务+路由+JSON
│
├── toolbox/                    # 用户工具目录（启动时自动扫描）
│   ├── _templates/             # 内置工具模板（供新建向导与用户复制）
│   │   ├── blank/              # 空工具骨架
│   │   ├── json-formatter/     # 示例：JSON 格式化
│   │   ├── qrcode/             # 示例：二维码生成
│   │   └── regex-test/         # 示例：正则测试
│   └── _logs/                  # 工具运行日志（环形缓冲 + 落盘）
│
├── binaries/                   # sidecar 二进制（node.exe 副本，gitignore）
├── scripts/
│   └── fetch-node.mjs          # 从本机/网络准备 node.exe 到 binaries/
└── .gitignore
```

---

## 5. 核心模块设计

### 5.1 工具宿主 `host/host.js`

宿主是 Node 进程，由 Rust sidecar 拉起。职责：

1. **启动时**
   - 监听 `127.0.0.1:0`（随机端口），把 `{pid, hostPort, hostJsPath}` 写入运行时状态文件（如 `%LOCALAPPDATA%/<app>/host-state.json`），Rust 由此发现宿主。
   - 扫描 `toolbox/` 下所有含 `manifest.json` 的目录，建立工具索引。
2. **管理接口（HTTP JSON）**
   - `GET  /tools`                  → 工具列表（含状态/端口）
   - `POST /tools/:id/start`        → 启动工具进程（分配端口）
   - `POST /tools/:id/stop`         → 停止工具进程（回收端口）
   - `GET  /tools/:id/status`       → 运行状态 + 端口
   - `GET  /tools/:id/logs`         → 最近日志（环形缓冲）
   - `POST /packages/:id/install`   → 在工具目录执行 npm install
   - `POST /packages/:id/uninstall` → npm uninstall
   - `GET  /packages/:id`           → 已安装包列表
3. **进程管理**
   - `start` 时 `spawn(node.exe, [toolDir/app.js])`，注入环境变量：
     `TOOL_ID` `TOOL_PORT` `TOOL_DIR` `TOOL_RUNTIME`（指向 resources/runtime）
   - 捕获 stdout/stderr：写入内存环形缓冲（每工具 2000 行）+ 落盘 `toolbox/_logs/<id>.log`。
   - 维护子进程表；宿主退出时兜底 `kill` 全部子进程。
4. **npm 封装**（见 §7）

### 5.2 工具运行时约定（工具作者视角）

工具目录结构：

```
toolbox/<tool-id>/
├── manifest.json    # 元信息（必填）
├── index.html       # 工具界面（必填，用户写）
├── app.js           # 工具后端（必填，用户写 Node）
├── package.json     # 工具自身依赖（可选，由依赖页面维护）
└── node_modules/    # 由依赖页面安装
```

`manifest.json` 示例：

```json
{
  "id": "json-formatter",
  "name": "JSON 格式化",
  "version": "1.0.0",
  "description": "格式化与校验 JSON",
  "icon": "icon.svg",
  "main": "app.js",
  "html": "index.html",
  "port": 0
}
```

工具作者的最简 `app.js`：

```js
// app.js —— 工具的 Node 后端
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,        // 自动 serve 该目录下的 index.html 与静态资源
  routes: {              // 你的 HTTP API（挂在工具自己端口上）
    "/api/format": (req, res, body) => {
      res.json({ ok: true, result: JSON.stringify(JSON.parse(body.json), null, 2) });
    }
  }
});
server.start();          // 自动监听 process.env.TOOL_PORT，也可自定义端口
```

- `runtime/runtime.js` 提供：静态文件服务、路由注册、`res.json()` 便捷响应、可选的日志。
- 用户也可以完全不依赖 runtime：直接 `http.createServer(...).listen(process.env.TOOL_PORT)` 并自己 serve 静态文件——约定只要求"监听 `TOOL_PORT`，`/` 返回 `index.html`"。
- 工具界面的 JS 通过 `fetch('/api/...')` 与自己的 Node 进程通信（同源）。

### 5.3 Tauri 命令层（Rust invoke）

| 命令 | 说明 |
|---|---|
| `list_tools()` | 工具列表（从宿主读取，含状态/端口） |
| `create_tool({ name, template })` | 从模板新建工具目录 |
| `read_tool_file(id, path)` / `write_tool_file(id, path, content)` | 编辑器读写文件（做路径白名单校验） |
| `create_tool_file(id, path, content)` | 编辑器新建文件（支持子目录，父目录自动创建，同样做白名单校验） |
| `delete_tool_file(id, path)` | 编辑器删除文件（复用白名单校验，仅文件） |
| `open_tool_dir(id?)` | 打开工具箱目录（id 为空）或指定工具目录（系统文件管理器） |
| `start_tool(id)` / `stop_tool(id)` / `tool_status(id)` | 启动/停止/状态 |
| `tool_logs(id, tail)` | 最近日志 |
| `install_package(id, pkg, version?)` / `uninstall_package(id, pkg)` / `list_packages(id)` | 依赖管理 |
| 事件 `tool-exited` | 工具进程意外退出 → 前端刷新状态并提示 |

### 5.4 前端页面

**LauncherView（主页面）**
- 顶部工具条：应用名、搜索框、「新建工具」「依赖管理」按钮、「刷新」。
- 工具卡片网格：图标 + 名称 + 描述 + 运行状态徽标；点击 → 路由到 ToolRunnerView 并 `start_tool`。
- 支持键盘：回车默认打开第一个匹配项。

**ToolRunnerView（工具容器）**
- 全屏 `<iframe :src="http://127.0.0.1:<port>"`。
- 顶栏：工具名、停止/重新加载按钮、日志抽屉。
- 离开页面时 `stop_tool`；监听 `tool-exited` 事件给出提示。

**ToolEditorView（内置编辑器）**
- 左侧文件树（manifest.json / index.html / app.js / package.json / node_modules 折叠）。
- 右侧代码编辑：v1 轻量方案（textarea + 行号 + 轻量语法高亮），v2 换 Monaco。
- 「新建工具向导」：填名称/描述 → 选模板（blank / json-formatter / …）→ 生成目录并扫描。
- 保存按钮 → `write_tool_file`；工具处于运行状态时提示需重启生效。

**DependenciesView（依赖管理）**
- 顶部：下拉选择目标工具，展示其 `package.json`。
- 搜索/输入 npm 包名 + 可选版本 → 安装（显示进度，见 §7）。
- 已安装列表：版本、`devDependency` 标记、卸载按钮。

---

## 6. 通信协议

### 6.1 宿主管理协议（Rust → 宿主）
- 传输：HTTP `127.0.0.1`，JSON body。
- Rust 发现宿主端口：读运行时状态文件；若宿主未存活，Rust 重新 spawn 并重试读取。
- 统一响应：`{ ok: true, data }` 或 `{ ok: false, error }`。

### 6.2 工具运行协议（iframe → 工具进程）
- 工具 UI origin 为 `http://127.0.0.1:<port>`，与自家 API 同源，直接 `fetch`。
- 静态资源、API 均由工具进程自己 serve，宿主不干预。

### 6.3 CSP 注意
- `tauri.conf.json` 的 `app.security.csp` 需放行：
  - `frame-src http://127.0.0.1:*`（允许 iframe 加载工具界面）
  - `connect-src http://127.0.0.1:*`（平台页面向宿主/工具进程发请求）

---

## 7. 依赖管理流程

1. 前端 `DependenciesView` 选择工具 → `list_packages(id)` 展示已装（读工具目录 `package.json` 的 `dependencies`）。
2. 输入包名/版本 → `install_package(id, pkg, version)` → Rust → 宿主：
   - 宿主内定位 npm-cli：`require.resolve('npm/bin/npm-cli.js')`（宿主自身依赖 npm，或打包时内置），
   - `spawn(process.execPath, [npmCliJs, 'install', '<pkg>@<ver>', '--no-audit'], { cwd: <toolDir> })`，
   - 捕获输出流，写入安装任务状态；前端**轮询**安装进度（简化模型，避免 SSE/WebSocket 复杂度）。
3. 完成后刷新已装列表。
4. 卸载同理：`npm uninstall <pkg>`。
- 工具启动时，其 Node 进程按 Node 模块解析规则自然使用自身目录的 `node_modules`，无需额外配置。

> 说明：依赖安装在用户主动操作的上下文里执行，面向本地开发场景；工具之间不共享依赖，避免版本污染。

---

## 8. 工具开发规范

- **id**：只允许小写字母 / 数字 / `-` / `_`，用作目录名与路由键（防路径穿越）。
- **约定接口**：`main` 指向的 JS 监听 `process.env.TOOL_PORT`；`/` 返回 `html` 指定文件。
- **模板**：`toolbox/_templates/` 内置 4 个模板，既供新建向导也用作用户手写的起点。
- **自动扫描**：启动与手动刷新时扫描 `toolbox/*/manifest.json`，新目录即刻出现在启动器。
- **错误处理**：manifest 缺失/非法 → 启动器上标记"配置错误"并可查看日志；进程启动失败 → 状态徽标 + 日志抽屉。
- **日志**：每工具内存环形缓冲（2000 行）+ 落盘 `_logs/<id>.log`，编辑器与启动器均可查看。

---

## 9. 安全设计

- 宿主只监听 `127.0.0.1`，不对外暴露。
- 工具进程、端口、iframe 三重隔离：一个工具崩溃/越界不影响平台与其它工具。
- 工具文件读写走白名单校验：`read/write_tool_file` 限定在 `toolbox/<id>/` 内。
- 依赖安装是用户显式操作，本地信任模型；工具代码为用户自写，不做沙箱（v2 可评估 Windows Job Object 资源限制）。
- `id` 与路径规范化，防止目录穿越。

---

## 10. 错误处理与健壮性

- 宿主失联：Rust 检测到宿主进程退出 → 自动重启宿主 → 前端提示"运行时已重启，工具已全部停止"。
- 端口冲突：`portpool` 分配前先探测；工具退出后回收端口。
- 工具崩溃：捕获 exit 事件 → 事件 `tool-exited` → 前端状态更新 + 可查日志。
- npm 安装失败：把 npm 的 stderr 摘要回传前端展示。
- 应用退出：Rust 兜底关闭宿主 → 宿主 kill 全部工具子进程。

---

## 11. 实施里程碑

| 阶段 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| **M0 脚手架** | Tauri 2 + Vite + Vue3 + TS，脚本、icons、配置 | `npm run tauri dev` 出空窗口 | ✅ 完成 |
| **M1 Sidecar** | 打包 node.exe、host.js/runtime、Rust 拉起宿主并握手 | 宿主管理接口可从 Rust 调通 | ✅ 完成（node.exe 走 resource + std spawn，非 externalBin） |
| **M2 工具运行时** | 宿主 start/stop 工具、端口分配、日志捕获；runtime.js 静态服务+路由 | 手写一个工具可运行、API 可调 | ✅ 完成（demo-tool 端到端验证） |
| **M3 启动器 + 容器** | LauncherView 网格、ToolRunnerView iframe、自动扫描、状态轮询 | 点击图标打开工具、退出停止 | ✅ 完成 |
| **M4 依赖管理** | DependenciesView + npm 安装/卸载/列表 | 给工具装一个 npm 库并在工具里用起来 | ✅ 完成（nanoid 装进工具目录验证） |
| **M5 内置编辑器** | 文件树、代码编辑、新建向导、保存写盘（Rust read/write 命令待补） | 应用内新建/编辑/运行闭环 | ✅ 完成（list/read/write 命令 + 编辑器页面） |
| **M6 模板与文档** | 内置模板、README、工具开发教程 | 用户照文档 10 分钟跑通第一个工具 | ✅ 完成（blank/json-formatter/regex-test 模板 + README） |
| **M7 打包** | `tauri build`、体积优化、图标 | 产出 Windows 安装包，无需装 Node 可运行 | ✅ 完成（NSIS 安装包 26MB；release 运行 + 宿主链路已验证） |

> 实现备注：
> - **Sidecar 形态**：因 tauri-plugin-shell 的 CommandChild 非 Send 且 API 在 2.x 有变动，最终方案是**把 node.exe 作为普通 resource 打包，Rust 用 `std::process::Command` 直接 spawn**，规避插件兼容问题。资源由 `scripts/fetch-node.mjs` 生成到 `src-tauri/resources/`（bin/node.exe + npm/）。
> - **两个 `package.json` 坑**：① 项目根 `type: module` 会让 resources 下的 JS 被当 ESM——已用 `src-tauri/resources/package.json` 与宿主启动时写入 `data/package.json`（均 `type: commonjs`）解决；② npm 在无 package.json 目录会向上查找项目根导致装错位置——宿主安装前确保工具目录有自己的 package.json。
> - **Windows verbatim 路径**：`resource_dir()` 返回 `\\?\` 前缀，Node 不支持，Rust 端 `clean_path` 去前缀。

---

## 12. v2 扩展点（留作演进）

- 工具调用 Tauri 原生能力桥（文件对话框 / 剪贴板 / 托盘）——经宿主转发一个受控命令白名单。
- 编辑器升级 Monaco（体积换体验）。
- 工具市场 / 导入导出 zip / 一键发布到局域网分享。
- 资源限制（Windows Job Object）+ 可选的网络/文件权限开关。
- npm 安装的实时流式进度（SSE）替代轮询。
