import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo, PackageInfo, ShortcutInfo } from "../types";

/**
 * Tauri 命令的统一入口封装。
 * 所有与 Rust 宿主层交互的地方都走这里，前端页面不直接调用 invoke。
 */
export const api = {
  // ---- 工具 ----
  listTools: (): Promise<ToolInfo[]> => invoke("list_tools"),
  createTool: (opts: { name: string; template: string }): Promise<string> =>
    invoke("create_tool", opts),
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
  startTool: (id: string): Promise<ToolInfo> => invoke("start_tool", { id }),
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
