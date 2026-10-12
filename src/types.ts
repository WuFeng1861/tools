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

/**
 * 工具类型：
 * - local  = 本地 Node 工具（自带 app.js 后端，跑独立进程）
 * - url    = 外部地址工具（iframe 直接加载远程页面，不跑进程）
 * - static = 本地网页工具（HTML 文件/目录被复制进 toolbox，由宿主静态服务托管）
 */
export type ToolType = "local" | "url" | "static";

/** 工具元信息（对应 toolbox/<id>/manifest.json） */
export interface ToolManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  /** 相对工具目录的图标路径 */
  icon?: string;
  /** 工具类型；缺省视为 local（兼容旧工具） */
  type?: ToolType;
  /** type = "url" 时指向的外部地址 */
  url?: string | null;
  /** 后端入口 JS（用户写的 Node 脚本）；url / static 工具为空 */
  main: string;
  /** 入口页面：local / static 工具为工具目录内的相对路径；url 工具为空 */
  html: string;
  /**
   * 固定端口（0 = 由运行时分配并把结果记住，保证下次启动复用同一端口）。
   * 端口决定页面 origin，进而决定该工具 localStorage / IndexedDB 的归属，
   * 所以不要手动频繁改动这里。
   */
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

/**
 * 启动工具的结果。
 * 「记忆端口被占用」不是错误，而是需要用户决策的中间态 —— 该端口决定工具页面的
 * origin，也就是它 localStorage / IndexedDB 的存放位置，换端口等于换存储位置。
 */
export type StartOutcome =
  | { kind: "started"; tool: ToolInfo }
  | {
      kind: "portBusy";
      toolId: string;
      /** 被占用的那个端口号，用于在弹窗里明确告诉用户 */
      port: number;
      /** other = 平台外的程序占用；tool = 另一个正在运行的工具占用 */
      occupiedBy: "other" | "tool";
    };

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
}/**
 * 一条「残留数据」记录。
 *
 * 工具换端口（用户确认「重新分配」）或被删除后，它那个 origin 上的
 * localStorage / IndexedDB 就访问不到了，成为磁盘上的残留 —— 同源策略
 * 不允许从外部删除。平台会在该端口空闲时占回来、用同源页面清理掉。
 */
export interface ResidualInfo {
  /** 放弃该端口的工具 id（工具可能已被删除） */
  toolId: string;
  port: number;
  /** 登记时间（毫秒时间戳） */
  at: number;
  /**
   * ready = 端口空闲、下次扫描即可清理
   * cleaning = 正在清理
   * busy-tool = 被运行中的工具占用
   * busy-external = 被平台外的程序占用
   * cooldown = 上次未完成，稍后重试
   */
  state: "ready" | "cleaning" | "busy-tool" | "busy-external" | "cooldown";
  /** 冷却结束时间（毫秒时间戳），仅 cooldown 时有值 */
  retryAfter: number;
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
