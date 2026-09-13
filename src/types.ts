/** 工具声明的全局快捷键（对应 manifest.shortcuts 一项） */
export interface ShortcutDecl {
  id: string;
  name: string;
  /** 默认组合键，如 "ctrl+shift+v" */
  accel: string;
  /** 动作描述串，按下时透传给工具的 /__platform/shortcut */
  action?: string;
}

/** 工具声明的悬浮面板元数据（对应 manifest.panels 一项，纯窗口描述，与快捷键解耦） */
export interface PanelDecl {
  id: string;
  /** 工具目录内的页面，如 quick.html */
  page: string;
  title?: string;
  width?: number;
  height?: number;
}

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
  /** 后台常驻：宿主启动时自动拉起，界面关闭不停止 */
  autoStart?: boolean;
  /** 静态声明的全局快捷键 */
  shortcuts?: ShortcutDecl[];
  /** 声明的悬浮面板元数据 */
  panels?: PanelDecl[];
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

/** 平台集中管理的全局快捷键条目（对应 Rust list_shortcuts 返回） */
export interface ShortcutInfo {
  toolId: string;
  toolName: string;
  toolRunning: boolean;
  shortcutId: string;
  name: string;
  /** 当前生效组合键（override 优先） */
  accel: string;
  /** manifest 默认组合键 */
  defaultAccel: string;
  /** 与其它动作撞同一组合键 */
  conflict: boolean;
  /** 是否已成功注册为系统全局快捷键 */
  registered: boolean;
  action: string;
}
