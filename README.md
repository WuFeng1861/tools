# 小工具平台

一个基于 **Tauri 2 + Node.js sidecar** 的桌面小工具平台。你可以用熟悉的 **HTML + Node.js** 编写自己的小工具，从主页面点图标即可运行；每个工具是应用内部一个独立的"小应用"（独立进程 + 独立端口 + 独立界面），互不干扰；还能在应用里为工具安装任意 npm 库。

## 功能

- 🧰 **启动器主页面**：工具图标网格，点击即打开；支持搜索
- 🗂️ **顶栏按用途分组**：「新建 ▾」（写代码 / 添加网址或本地网页 / 打开目录）、
  「更多 ▾」（依赖管理 / 全局快捷键 / 设置 / 教程），避免一行堆满按钮
- 🔗 **URL 工具**：粘贴网址即可添加，iframe 直接加载外部页面，不占端口、不跑进程
- 📄 **本地网页工具**：本地 HTML 文件 / 目录复制进来即可用，跑在固定端口的 localhost 下（安全上下文）；
  手动把含 `index.html` 的目录丢进 `toolbox/` 也会被自动接管
- 🖥️ **工具独立运行**：每个工具 = 独立 Node 进程 + 固定本机端口 + iframe 界面
- 💾 **存储可持久**：端口跨重启复用，工具的 localStorage / IndexedDB 不会丢
- 🖱️ **工具页支持拖拽**：拖文件进工具界面可直接使用（Tauri 原生拖放已关，改由 HTML5 处理）
- 🧹 **残留自动清理**：换端口/删工具留下的旧存储，等端口空闲时自动占回来清掉，可在设置里查看
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

## 用 URL 添加工具

主页面 →「添加网址」→ 填地址即可。这类工具**不占端口、不跑 Node 进程**，界面直接以 iframe 加载该地址：

- 允许 `https://` 任意地址
- 允许 `http://127.0.0.1:<端口>` / `http://localhost:<端口>` 的本地服务（自己起的服务可直接加进来）

对应的 `manifest.json` 形态：

```json
{
  "id": "p2p-chat",
  "name": "P2P 聊天室",
  "version": "1.0.0",
  "description": "外部地址工具 · http://127.0.0.1:8777/",
  "icon": "💬",
  "type": "url",
  "url": "http://127.0.0.1:8777/"
}
```

> 部分站点会设置 `X-Frame-Options` / CSP `frame-ancestors` 禁止被嵌入，此时页面会空白。
> 工具页右上角提供「用浏览器打开」作为兜底。

## 用本地网页文件添加工具

主页面 →「添加工具」→「本地网页」→ 填入路径。支持两种：

- 单个 `.html` / `.htm` 文件
- 一个包含 `index.html` 的目录（整个目录会被复制，含同目录的 css / js / 图片等；跳过 `node_modules` 与 `.git`）

内容会被复制到 `toolbox/<id>/`，由宿主用**内置静态服务**在分配到的端口上托管。

**为什么比直接双击 .html 好？**

| | 直接打开 `file://` | 本平台托管 |
|---|---|---|
| WebRTC / 剪贴板 / Service Worker | ❌ 非安全上下文，多数浏览器直接禁用 | ✅ 跑在 `http://127.0.0.1:<port>`，是安全上下文 |
| localStorage / IndexedDB 持久化 | ⚠️ 各浏览器对 `file://` 处理不一致，随时可能被清 | ✅ 端口固定 → origin 稳定 → 可跨重启保存 |
| 与其它工具隔离 | — | ✅ 独占端口与存储 |

> 也就是说：**「需要 https / localhost 才能用」的能力，在这里天然满足**
> —— 比如 WebRTC 点对点连接、`navigator.clipboard`、Service Worker。

内容复制进来后是自包含的：改原文件不会影响已添加的工具，
要更新就重新「添加」一次，或直接编辑 `toolbox/<id>/` 下的副本（静态服务不缓存，刷新即生效）。

> **也可以直接手动放入**：把任意含 `index.html` 的目录丢进 `toolbox/`，平台会自动按
> 本地网页工具接管，并补生成一份 `manifest.json`（之后可在编辑器里改）。
> 只有既没有 `manifest.json` 又没有 `index.html` 的目录才会报错。

对应的 `manifest.json`：

```json
{
  "id": "p2p-chat",
  "name": "P2P 聊天室",
  "type": "static",
  "html": "index.html",
  "port": 0
}
```

## localStorage / IndexedDB 与端口的关系

工具页运行在 `http://127.0.0.1:<端口>`，而浏览器按 **origin（协议 + 主机 + 端口）**隔离存储 —— 端口即存储桶编号。

平台会把每个工具第一次分配到的端口记到 `ports.json`，之后每次启动都复用它，因此：

- 同一个工具重启后仍能读到上次写的数据（此前是随机端口，每次重启都换桶，数据看起来像丢了）
- 不同工具之间存储天然隔离、互不干扰
- URL 工具用的是对方域名自己的存储，由该站点自行持久化

`manifest.json` 的 `port` 填 `0` = 自动分配并记住；填固定值 = 强制使用该端口。
删除工具时平台会一并清掉端口记忆，避免将来同名工具继承旧数据。

### 端口被占用时会怎样

平台**不会**擅自换端口——换端口就是换存储位置。打开工具时如果发现它的记忆端口被占用，
会弹出确认框，明确告诉你：

- 被占用的是哪个端口
- 是被「另一个正在运行的工具」还是「系统上的其它程序」占用
- 重新分配端口会导致这个工具原有的 localStorage / IndexedDB 看不到

然后由你选择：

| 选项 | 行为 |
|---|---|
| **先不启动** | 什么都不做，工具保持停止，返回启动器。下次打开会重新检查端口 |
| **重试启动** | 你去关掉占用端口的程序后点它，端口没变、数据不丢 |
| **重新分配端口并启动** | 换用新端口启动，`ports.json` 随之更新 |

### 关于「重新分配端口」后的旧数据

旧端口下的 localStorage / IndexedDB **不会被立即删除** —— 浏览器同源策略不允许
从外部删除另一个来源的数据。它会先留在磁盘上占空间，且在界面上无法再访问。

平台会自动收拾这些残留：

1. **登记** —— 工具被「重新分配端口」或被删除时，旧端口记入 `<data>/residuals.json`
2. **等待空闲** —— 定期（约每 3 分钟）检查这些端口；被占用就跳过，绝不去抢别人的端口
3. **占下并清理** —— 一旦空闲，宿主**自己监听**那个端口，从而取得该 origin 的同源身份，
   用一个不可见的 iframe 加载清理页，清掉 localStorage / IndexedDB / Cache Storage /
   Service Worker 注册，随后关闭端口

> 核心思路是「用同源身份删自己」：从外部删不掉，但只要重新成为那个 origin 的
> 提供者，就有权限删。

**在「设置 → 残留数据」里可以看到当前有哪些残留**：属于哪个工具（工具已删除会标注）、
端口号、登记时间，以及**当前状态**——即它大概什么时候会被清理：

| 状态 | 含义 |
|---|---|
| 端口已空闲 · 下次扫描就会清理 | 下一个扫描周期（约 3 分钟）就会清掉 |
| 正在清理… | 清理页正在执行 |
| 端口被运行中的工具占用 · 等该工具停止后自动清理 | — |
| 端口被其它程序占用 · 等它释放后自动清理 | 平台不会去抢别人的端口 |
| 上次未完成 · 约 N 分钟后重试 | 失败后进入冷却 |

每条还提供两个操作：**立即清理**（强制重试，可跳过冷却倒计时；端口正被占用时会置灰）
和 **放弃**（数据继续留在磁盘上，平台不再尝试）。

**不过仍然建议优先选「重试启动」** —— 清理属于事后补救，重试则数据完好无损。

另外两类情况：`manifest.json` 里显式指定的 `port` 被占用时会直接报错；
后台常驻（`autoStart`）工具遇到端口冲突只记日志跳过，等你进界面再决定。

## 开发自测

```bash
npm run test:host     # 宿主回归测试（真实进程跑完整流程，无需 Tauri）
npm run test:p2p      # p2p-chat 浏览器回归测试（真实 Chromium + Trystero 桩模块）
cd src-tauri && cargo test   # URL 白名单等单元测试
```

`test:host` 覆盖「端口 ↔ 存储」不变量、URL 工具识别、本地网页工具、
端口冲突决策流程、残留数据清理等 —— 这几条断言都实际抓出过 bug，
改 `host.js` 后请务必跑一遍。

`test:p2p` 覆盖 p2p-chat 的文件名/metadata、下载保存提示与进度、另存为回退、拖拽发送。
它存在的理由是：**Trystero 会把 `metadata` 再包一层**再交给 `onMessage`
（接收端拿到的是 `{ peerId, metadata: {...} }`），读错层级会让文件名静默退化成
`file`、图片被当成普通文件 —— 语法检查和类型检查**都发现不了**，
只能靠真实浏览器跑一遍。改 `example/p2p-chat/index.html` 后请跑这个。

## 依赖管理

主页面 →「依赖管理」→ 选工具 → 输入包名（可加版本）→ 安装。装好后在工具代码里直接 `require('包名')` 使用。依赖安装在工具的 `package.json` / `node_modules` 中，工具之间不共享。

## 架构

```
Vue3 前端 ──invoke──▶ Rust(Tauri) ──HTTP(127.0.0.1)──▶ Node 宿主(host.js)
                                                          │  spawn 每工具一个 node.exe
                                     iframe 直接加载 ◀────┘ 监听固定端口（记在 ports.json）
```

- 平台管理界面（启动器 / 编辑器 / 依赖管理）走 Tauri IPC
- 工具界面由主窗口的 **iframe** 直接加载 `http://127.0.0.1:<端口>`，与自己的 Node 进程同源通信
- 独立进程 + 独立端口 + iframe 三重隔离，一个工具崩溃不影响平台与其他工具

详细设计见 [DESIGN.md](./DESIGN.md)。

### 为什么关掉了 Tauri 的原生拖放

`src-tauri/tauri.conf.json` 里窗口设了 `"dragDropEnabled": false`，**不要改回去**。

Tauri 默认开启原生拖放：它会在窗口 HWND 上注册一个 COM `IDropTarget`
（wry 的 `with_drag_drop_handler` → `RegisterDragDrop`），于是「把文件拖进窗口」
在系统层就被截走了，网页里的 `dragenter / dragover / drop` **永远不会触发**。
Tauri 源码里的原话是：

> Whether the drag and drop is enabled or not on the webview. By default it is enabled.
> **Disabling it is required to use HTML5 drag and drop on the frontend on Windows.**

平台自己并没有监听 `tauri://drag-drop`，所以关掉它没有副作用，
反而让所有工具页（包括 iframe 里的）都能用标准 HTML5 拖拽。

注意配套的一点：关掉之后改由 WebView 处理拖放，**如果页面上没人 `preventDefault`，
把文件丢到窗口上会让 WebView「导航到那个文件」**。所以 `index.html` 里加了
window 级的 `dragover` / `drop` 兜底（只 `preventDefault`，不 `stopPropagation`，
不影响卡片排序等文档内拖拽）。工具页在自己的 iframe 里各自处理拖拽。

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
