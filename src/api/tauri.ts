import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo, PackageInfo, ShortcutInfo, StartOutcome, ResidualInfo } from "../types";

/**
 * Tauri 命令的统一入口封装。
 * 所有与 Rust 宿主层交互的地方都走这里，前端页面不直接调用 invoke。
 */
export const api = {
  // ---- 工具 ----
  listTools: (): Promise<ToolInfo[]> => invoke("list_tools"),
  createTool: (opts: { name: string; template: string }): Promise<string> =>
    invoke("create_tool", opts),
  /** 添加 URL 工具（外部地址，不跑本地进程）。返回生成的工具 id */
  addUrlTool: (opts: { url: string; name: string; icon?: string }): Promise<string> =>
    invoke("add_url_tool", opts),
  /**
   * 添加本地网页工具：把 HTML 文件（或含 index.html 的目录）复制进 toolbox，
   * 由宿主静态服务在固定端口上托管。返回生成的工具 id。
   */
  addStaticTool: (opts: { path: string; name: string; icon?: string }): Promise<string> =>
    invoke("add_static_tool", opts),
  /** 用系统默认浏览器打开地址（URL 工具被 X-Frame-Options 挡住时的兜底） */
  openExternalUrl: (url: string): Promise<void> =>
    invoke("open_external_url", { url }),

  /**
   * 触发一次「残留数据清理」，返回宿主已占下的端口列表。
   * 调用方必须为每个端口渲染一次隐藏 iframe —— 只有同源页面能删掉自己的存储。
   * `force` 用于用户手动点「立即清理」时忽略冷却时间。
   */
  sweepResiduals: (force = false): Promise<number[]> =>
    invoke("sweep_residuals", { force }),
  /** 残留数据清单（含当前状态），用于「有哪些残留、属于哪个工具、何时会清理」 */
  listResiduals: (): Promise<ResidualInfo[]> => invoke("list_residuals"),
  /** 放弃清理某个端口的残留数据（数据继续留在磁盘上，平台不再尝试） */
  ignoreResidual: (port: number): Promise<void> => invoke("ignore_residual", { port }),
  listToolFiles: (id: string): Promise<string[]> =>
    invoke("list_tool_files", { id }),
  readToolFile: (id: string, path: string): Promise<string> =>
    invoke("read_tool_file", { id, path }),
  writeToolFile: (
    id: string,
    path: string,
    content: string,
  ): Promise<void> => invoke("write_tool_file", { id, path, content }),
  createToolFile: (
    id: string,
    path: string,
    content: string,
  ): Promise<void> => invoke("create_tool_file", { id, path, content }),
  deleteToolFile: (id: string, path: string): Promise<void> =>
    invoke("delete_tool_file", { id, path }),
  /** 打开目录：id 为空打开整个工具箱目录（toolbox/），否则打开该工具目录 */
  openToolDir: (id?: string): Promise<void> =>
    invoke("open_tool_dir", { id: id ?? "" }),
  /**
   * 启动工具。
   * 返回 portBusy 表示「记忆端口被占用」，需要用户确认后才可传 reassignPort=true 重试
   *（重新分配端口会换掉该工具的存储位置）。
   */
  startTool: (id: string, reassignPort = false): Promise<StartOutcome> =>
    invoke("start_tool", { id, reassignPort }),
  stopTool: (id: string): Promise<void> => invoke("stop_tool", { id }),
  toolStatus: (id: string): Promise<ToolInfo> => invoke("tool_status", { id }),
  toolLogs: (id: string, tail?: number): Promise<string[]> =>
    invoke("tool_logs", { id, tail }),
  deleteTool: (id: string): Promise<void> => invoke("delete_tool", { id }),
  reorderTools: (ids: string[]): Promise<void> => invoke("reorder_tools", { ids }),

  // ---- 依赖管理 ----
  installPackage: (
    id: string,
    pkg: string,
    version?: string,
  ): Promise<PackageInfo[]> => invoke("install_package", { id, pkg, version }),
  uninstallPackage: (id: string, pkg: string): Promise<PackageInfo[]> =>
    invoke("uninstall_package", { id, pkg }),
  listPackages: (id: string): Promise<PackageInfo[]> =>
    invoke("list_packages", { id }),

  // ---- 平台窗口 / 托盘 ----
  /** 隐藏主窗口到托盘（后台继续运行） */
  hideToTray: (): Promise<void> => invoke("hide_to_tray"),
  /** 真正退出程序 */
  quitApp: (): Promise<void> => invoke("quit_app"),
  /** 把某工具的某个面板页显示为无边框置顶悬浮窗 */
  openToolPanel: (toolId: string, panelId: string): Promise<void> =>
    invoke("open_tool_panel", { toolId, panelId }),
  /** 隐藏某工具的所有悬浮面板窗 */
  hideToolPanel: (toolId: string): Promise<void> =>
    invoke("hide_tool_panel", { toolId }),
  /** 读取是否开机自启 */
  getAutostart: (): Promise<boolean> => invoke("get_autostart"),
  /** 设置开机自启 */
  setAutostart: (enabled: boolean): Promise<boolean> =>
    invoke("set_autostart", { enabled }),

  // ---- 全局快捷键 ----
  /** 列出所有工具声明的全局快捷键（含冲突 / 注册 / 运行状态） */
  listShortcuts: (): Promise<ShortcutInfo[]> => invoke("list_shortcuts"),
  /** 修改某动作的组合键，返回该条最新状态；冲突会抛错 */
  setShortcutAccel: (
    toolId: string,
    shortcutId: string,
    accel: string,
  ): Promise<ShortcutInfo> =>
    invoke("set_shortcut_accel", { toolId, shortcutId, accel }),
  /** 恢复某动作为 manifest 默认组合键 */
  resetShortcutAccel: (
    toolId: string,
    shortcutId: string,
  ): Promise<ShortcutInfo> =>
    invoke("reset_shortcut_accel", { toolId, shortcutId }),
  /** 读取当前全局快捷键，如 "ctrl+shift+v"（兼容旧工具设置 UI） */
  getClipboardHotkey: (): Promise<string> => invoke("get_clipboard_hotkey"),
  /** 设置全局快捷键（兼容旧工具设置 UI） */
  setClipboardHotkey: (accel: string): Promise<string> =>
    invoke("set_clipboard_hotkey", { accel }),
};
