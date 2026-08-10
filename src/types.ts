/** 工具元信息（对应 toolbox/<id>/manifest.json） */
export interface ToolManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 相对工具目录的图标路径 */
  icon?: string;
  /** 后端入口 JS（用户写的 Node 脚本） */
  main: string;
  /** 工具界面 HTML */
  html: string;
  /** 固定端口（0 = 由运行时随机分配） */
  port?: number | null;
}

export type ToolStatus = "stopped" | "running" | "error";

/** 工具条目：manifest + 运行时状态 */
export interface ToolInfo extends ToolManifest {
  status: ToolStatus;
  /** 运行中的实际端口 */
  port: number | null;
  pid: number | null;
  /** 启动失败 / 配置错误的原因 */
  error?: string;
}

/** npm 包信息（已安装到某工具） */
export interface PackageInfo {
  name: string;
  version: string;
  /** 是否为 devDependency */
  dev?: boolean;
}

/** 宿主进程运行状态 */
export interface HostState {
  pid: number;
  hostPort: number;
}
