import { invoke } from "@tauri-apps/api/core";
import type { ToolInfo, PackageInfo } from "../types";

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
};
