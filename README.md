# 小工具平台

一个基于 **Tauri 2 + Node.js sidecar** 的桌面小工具平台。你可以用熟悉的 **HTML + Node.js** 编写自己的小工具，从主页面点图标即可运行；每个工具是应用内部一个独立的"小应用"（独立进程 + 独立端口 + 独立界面），互不干扰；还能在应用里为工具安装任意 npm 库。

## 功能

- 🧰 **启动器主页面**：工具图标网格，点击即打开；支持搜索
- 🖥️ **工具独立运行**：每个工具 = 独立 Node 进程 + 随机本机端口 + iframe 界面
- 📦 **依赖管理**：专门的页面为工具安装 / 卸载 / 列出 npm 包
- ✏️ **内置编辑器**：应用内新建、编辑工具的 `manifest.json` / `index.html` / `app.js`
- 🧩 **内置模板**：空工具、JSON 格式化、正则测试，照着写即可上手
- 🔍 **自动扫描**：外部写好工具目录放进 `toolbox/`，刷新即出现

## 快速开始（开发）

```bash
# 1. 准备 sidecar 运行时资源（复制 node.exe 与 npm 模块）
node scripts/fetch-node.mjs

# 2. 启动开发环境
npm install
npm run tauri dev
```

首次 `cargo` 编译较慢（需下载并编译 Rust 依赖）。

## 编写你的第一个工具

每个工具是一个目录，放在 **用户数据目录的 `toolbox/`** 下（Windows：`%APPDATA%\com.tools.platform\toolbox`）：

```
toolbox/my-tool/
├── manifest.json    # 元信息（必填）
├── index.html       # 工具界面（必填）
├── app.js           # 工具后端（必填，Node.js）
├── package.json     # 工具自身依赖（由依赖管理页维护）
└── node_modules/    # 由依赖管理页安装
```

`manifest.json` 示例：

```json
{
  "id": "my-tool",
  "name": "我的工具",
  "version": "0.1.0",
  "description": "一句话描述",
  "main": "app.js",
  "html": "index.html",
  "port": 0
}
```

约定：`id` 只允许小写字母 / 数字 / `-` / `_`；`port` 填 `0` 表示由运行时随机分配端口。

`app.js` 最简写法（推荐使用内置运行时，自动 serve 静态文件 + 提供路由）：

```js
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,      // 自动 serve 本目录的 index.html 与静态资源
  routes: {            // 你的 HTTP API（挂在工具自己的端口上，同源）
    "/api/ping": (req, res, body) => res.json({ ok: true, msg: "pong" }),
  },
});

server.start();        // 自动监听 process.env.TOOL_PORT
```

也可以不用运行时，自己 `http.createServer(...).listen(process.env.TOOL_PORT)` 并 serve 静态文件。界面里用 `fetch('/api/...')` 调用自己的后端即可。

> 更快的上手方式：主页面 →「新建工具」→ 选一个模板。

## 依赖管理

主页面 →「依赖管理」→ 选工具 → 输入包名（可加版本）→ 安装。装好后在工具代码里直接 `require('包名')` 使用。依赖安装在工具的 `package.json` / `node_modules` 中，工具之间不共享。

## 架构

```
Vue3 前端 ──invoke──▶ Rust(Tauri) ──HTTP(127.0.0.1)──▶ Node 宿主(host.js)
                                                          │  spawn 每工具一个 node.exe
                                     iframe 直接加载 ◀────┘ 监听随机端口
```

- 平台管理界面（启动器 / 编辑器 / 依赖管理）走 Tauri IPC
- 工具界面由主窗口的 **iframe** 直接加载 `http://127.0.0.1:<端口>`，与自己的 Node 进程同源通信
- 独立进程 + 独立端口 + iframe 三重隔离，一个工具崩溃不影响平台与其他工具

详细设计见 [DESIGN.md](./DESIGN.md)。

## 目录结构

```
tools/
├── src/                    # 平台前端（Vue 3 + Vite + TS）
│   └── views/              #   启动器 / 工具容器 / 编辑器 / 依赖管理
├── src-tauri/              # Rust 端
│   ├── src/                #   命令层（tools / packages）+ sidecar 管理
│   └── resources/          #   Node 运行时 + 宿主脚本 + 模板 + npm（打包资源）
├── scripts/fetch-node.mjs  # 准备 sidecar 运行时资源
├── binaries/               # node.exe 副本（gitignore）
├── DESIGN.md               # 架构设计方案
└── README.md
```

## 打包发布

```bash
# 出 NSIS 安装包（推荐；MSI 需额外下载 WiX，网络受限时用 NSIS）
npx tauri build --bundles nsis
```

安装包产出在 `src-tauri/target/release/bundle/nsis/`（约 26MB）。安装后用户无需自行安装 Node。若需 MSI 安装包（默认 `npm run tauri build`），需能访问 GitHub 以下载 WiX 工具。

## 已实现里程碑

M0 脚手架 → M1 Sidecar 打通 → M2 工具运行时 → M3 启动器 + iframe 容器 → M4 依赖管理 → M5 内置编辑器 → M6 模板 + 文档 → M7 打包（见 DESIGN.md 状态表）。
