# [功能改进] 补齐 Linux 平台及示例工具兼容，保留 Windows 现有行为

本文可作为 GitHub issue 正文，附件为 `linux-support-changes-2026-11-11.zip`。

## 背景与问题

希望在 Linux 桌面中使用小工具平台，并保留 Windows 现有的安装、运行和工具使用方式。

对原实现的源码检查发现以下问题。这些是代码层面的发现，并非 Linux 实机运行记录：

1. 宿主固定加载打包资源中的 `node.exe`，不会直接使用 Linux 已安装的 Node.js。
2. 宿主和部分工具通过 Windows 的 `taskkill` 清理进程，缺少 Linux 分支。
3. 运行时资源准备和发布命令面向 Windows，缺少 Linux 专属打包配置。
4. 剪贴板历史依赖 PowerShell、Windows Forms 和 Windows 剪贴板 API。
5. 关闭占用进程工具依赖 `netstat -ano`、`tasklist`、`taskkill`。
6. 额度池的本地登录态、设备信息和意识流的旧数据查找使用 Windows 用户目录。

## 预期行为

- Windows 继续使用原有内置 Node/npm、进程管理和 NSIS 发布流程。
- Linux 使用系统 Node.js；安装或卸载工具依赖时使用系统 npm。
- Linux 可以正常定位工具文件、启动和停止工具，并提供 Linux 发布配置。
- 涉及系统功能的小工具具备对应 Linux 实现；依赖或桌面能力不足时明确提示。

## 附件中的实现

### 平台宿主与发布

- 增加 Linux 系统 Node 路径解析；支持 `TOOL_PLATFORM_NODE` 指定 Node 可执行文件。
- Linux 使用同目录或 PATH 中的系统 npm，Windows 保留内置 `npm-cli.js`。
- Linux 工具和 npm 子进程使用独立进程组；停止工具和关闭宿主时清理子进程。
- Rust 增加 Linux `/proc` 进程树兜底清理；Windows 保留 `taskkill /T /F`。
- 增加 `tauri.linux.conf.json`，Linux 打包排除 Windows Node/npm，生成 `.deb` 和 `.AppImage`。
- `.deb` 声明 Node.js、npm、xdg-utils 依赖；AppImage 仍需要系统提供 Node/npm。
- `npm run build:release` 按当前系统选择发布格式；Windows 仍生成 NSIS。
- 更新平台教程和文件目录说明。

工具文件位置：

| 环境 | 目录 |
| --- | --- |
| Windows | `%APPDATA%\com.tools.platform\toolbox\` |
| Linux 默认 | `~/.local/share/com.tools.platform/toolbox/` |
| Linux 设置 XDG_DATA_HOME | `$XDG_DATA_HOME/com.tools.platform/toolbox/` |

### 示例工具

| 工具 | 修改内容 |
| --- | --- |
| 剪贴板历史 | 增加 X11 xclip、Wayland wl-clipboard 分支，支持文字、PNG 图片和本地文件 URI 列表的记录及再复制；回读确认复制结果；显示缺少命令、桌面权限等错误。 |
| 关闭占用进程 | Linux 通过 `/proc/net` 和 socket inode 查找端口对应进程，按 PID 树终止并复核；保护 PID 1、工具自身和宿主，检查 PID 启动时间以降低误杀复用 PID 的风险。 |
| 额度池 | 增加 Linux XDG 配置/数据目录候选查找、文件路径环境变量覆盖，以及页面选择登录态文件、Trae 设备信息文件的方式。 |
| 意识流 | 增加 Linux XDG 配置目录下的原版旧数据查找，支持指定旧数据文件的绝对路径。 |
| 时间检测与校准 | 保留已有 Windows/Linux 实现；本次仅更新其 README 中的安装目录说明，并运行现有回归测试。 |

额度池的第三方客户端目录属于候选位置，不保证不同客户端版本或 Wine 安装均使用相同目录。
自动查找失败时可以手动选择文件，也支持以下环境变量：

```text
QUOTA_POOL_WORKBUDDY_AUTH_FILE=/实际位置/workbuddy-desktop.info
QUOTA_POOL_TRAE_ENV_FILE=/实际位置/local_env.json
CONSCIOUSNESS_STREAM_LEGACY_FILE=/实际位置/consciousness-stream.json
```

## 已完成的验证

测试在当前 Windows 工作环境中执行。以下是本次对话中实际完成的检查结果；打包时仅核对文件及 ZIP 完整性，没有重新执行全部测试。

| 检查 | 结果 |
| --- | --- |
| `npm run build` | 类型检查和前端生产构建通过。 |
| `npm run test:host` | 66 项通过。 |
| `npm run test:platform` | 2 项通过，验证资源配置、实际子进程清理及本地 npm 包安装/卸载。 |
| `npm run test:tools` | 18 项通过，1 项 Linux 实机测试跳过。包含 Windows 上经工具 HTTP 接口查询端口、终止测试专用父子进程的实际测试。 |
| `npm run test:time` | 32 项通过，未修改实际系统时间。 |
| `cargo test --locked`（在 src-tauri 中执行） | Windows 编译和 6 项 Rust 单元测试通过。 |
| 修改后 JavaScript 语法检查 | 通过。 |

Linux 分支的命令、剪贴板字节读写、路径和路由行为进行了模拟及隔离数据测试，不能替代 Linux 实机验证。
测试未读取或修改真实用户账号、登录态和系统剪贴板；进程终止实测仅操作测试专用进程。

## 仍需验证及运行限制

- 当前环境没有可用 Linux/WSL，尚未完成 Linux 桌面启动、安装包构建和安装验证。
- Linux 实机进程测试会在 Linux 执行 `npm run test:tools` 时启用；Windows 下跳过该项。
- X11 剪贴板需要 `xclip`；Wayland 需要 `wl-clipboard`，后台监听还依赖桌面的 data-control 协议支持。
- Wayland 使用事件监听，不以持续弹出透明窗口的方式轮询不支持后台访问的桌面。
- Linux 不提供来源窗口名称，因此剪贴板的“显示来源应用”选项禁用。
- Linux 图片处理当前支持 PNG；文件列表按“复制”语义写回，不执行剪切移动。
- Linux 剪贴板写回由工具持有，停止整个工具后是否保留取决于桌面剪贴板管理器。
- 全局快捷键、窗口行为等桌面能力仍需在目标 X11/Wayland 桌面验证。
- Linux 端口查询只处理当前网络命名空间中的可见进程；权限受限会返回提示。
- 本地文件读取适配不代表第三方客户端一定提供 Linux 版本。
- SSH、Clash、P2P 等工具没有因本次适配改写业务代码，也未据此声明它们已经通过 Linux 实机验证。

## 附件结构与使用方法

```text
linux-support-changes-2026-11-11.zip
├── README_ISSUE.md       # 本文，供 issue 描述与审阅
├── FILES.sha256          # README 和附件内源码文件的 SHA-256 清单
└── files/               # 按项目原始相对路径保存的修改/新增文件
    ├── README.md
    ├── package.json
    ├── scripts/
    ├── src/
    ├── src-tauri/
    └── example/
```

1. 将本文用作 issue 正文，并把 ZIP 上传为 issue 附件。
2. 维护者解压后，将 `files/` 内的文件与目标仓库逐项比较、合并，路径相对于项目根目录。
3. 这是修改文件的完整版本覆盖包，不是整个项目，也不是 `git apply` 格式的差异补丁。
   当前工作目录不含 `.git`，无法提供可靠的基准提交或自动生成与上游匹配的差异。
   合并时应保留目标仓库已有的独立修改，尤其是 package.json、Cargo.toml 和 Cargo.lock。
4. 在目标环境运行对应检查；Linux 开发构建的系统依赖说明在 `files/README.md` 中。
5. 已安装的 toolbox 工具是源码的独立副本，需要停止工具后更新代码，包含新增辅助 JS 文件。
   保留原有账号、历史、设置、图片、data.json 等数据。

Windows 开发环境检查：

```powershell
node scripts/fetch-node.mjs
npm ci
npm run build
npm run test:host
npm run test:platform
npm run test:tools
npm run test:time
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

Linux 在安装系统 Node/npm、Rust 以及 Tauri 所需桌面构建依赖后：

```bash
npm ci
npm run test:host
npm run test:platform
npm run test:tools
npm run test:time
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri dev
# 单独构建发布包：
npm run build:release
```

附件只包含本次修改后仍存在的 36 个项目文件。此前生成后已移除的可选 GitHub Actions 配置不在附件中，
ZIP 也不会对目标仓库执行删除操作。附件不包含 node_modules、target、dist、Node/npm 二进制资源、
用户工具数据、账号信息、旧 ZIP 或测试临时文件。未修改的基础项目文件需要使用目标仓库现有版本。

## 文件清单

| Type | Repository-relative path |
| --- | --- |
| Modified | `README.md` |
| Modified | `example/README.md` |
| Modified | `example/clipboard-history/README.md` |
| Modified | `example/clipboard-history/app.js` |
| Modified | `example/clipboard-history/front.js` |
| Added | `example/clipboard-history/linux-clipboard.js` |
| Modified | `example/clipboard-history/quick.html` |
| Modified | `example/clipboard-history/quick.js` |
| Added | `example/close-occupied-process/README.md` |
| Modified | `example/close-occupied-process/app.js` |
| Modified | `example/close-occupied-process/index.html` |
| Added | `example/close-occupied-process/linux-processes.js` |
| Modified | `example/close-occupied-process/manifest.json` |
| Modified | `example/consciousness-stream/README.md` |
| Modified | `example/consciousness-stream/app.js` |
| Added | `example/consciousness-stream/legacy-paths.js` |
| Modified | `example/quota-pool/README.md` |
| Modified | `example/quota-pool/app.js` |
| Modified | `example/quota-pool/front.js` |
| Modified | `example/quota-pool/index.html` |
| Added | `example/quota-pool/local-paths.js` |
| Modified | `example/time-sync/README.md` |
| Modified | `package.json` |
| Added | `scripts/build-release.mjs` |
| Modified | `scripts/fetch-node.mjs` |
| Added | `scripts/test-platform.mjs` |
| Added | `scripts/test-tools-linux.mjs` |
| Modified | `src-tauri/Cargo.lock` |
| Modified | `src-tauri/Cargo.toml` |
| Modified | `src-tauri/resources/host/host.js` |
| Modified | `src-tauri/src/lib.rs` |
| Added | `src-tauri/src/processes.rs` |
| Modified | `src-tauri/src/sidecar.rs` |
| Added | `src-tauri/tauri.linux.conf.json` |
| Modified | `src/views/LauncherView.vue` |
| Modified | `src/views/TutorialView.vue` |
