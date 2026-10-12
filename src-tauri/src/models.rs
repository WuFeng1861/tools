use serde::{Deserialize, Serialize};

fn default_tool_type() -> String {
    "local".to_string()
}

/// 工具条目（对应宿主 /tools 返回，camelCase 与前端 types.ts 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    /// 工具类型：local（本地 Node 工具，默认）| url（外部地址工具）
    #[serde(default = "default_tool_type", rename = "type")]
    pub kind: String,
    /// type = "url" 时指向的外部地址；本地工具为 null
    #[serde(default)]
    pub url: Option<String>,
    pub main: String,
    pub html: String,
    /// 后台常驻：宿主启动时自动拉起，界面关闭不停止
    #[serde(default)]
    pub auto_start: bool,
    /// running | stopped | error
    pub status: String,
    /// 运行中的实际端口
    pub port: Option<u16>,
    pub pid: Option<i32>,
    pub error: Option<String>,
}

/// 启动工具的结果。
///
/// 「记忆端口被占用」不是错误，而是需要用户决策的中间态：
/// 该端口决定工具页面的 origin，也就是它 localStorage / IndexedDB 的存放位置，
/// 换端口等于换存储位置。所以宿主不会擅自重新分配，而是把决定权交回界面。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum StartOutcome {
    /// 已启动（URL 工具不跑进程，同样算就绪）
    Started { tool: ToolInfo },
    /// 记忆端口被占用，等待用户选择「重新分配端口」或「先不启动」
    PortBusy {
        tool_id: String,
        port: u16,
        /// "other" = 平台外的程序占用；"tool" = 另一个正在运行的工具占用
        occupied_by: String,
    },
}

/// 一条「残留数据」记录。
///
/// 工具换端口（用户确认「重新分配」）或被删除后，它那个 origin 上的
/// localStorage / IndexedDB 就访问不到了，成为磁盘上的残留。
/// 平台会在该端口空闲时把它占回来、用同源页面清理掉。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResidualInfo {
    /// 放弃该端口的工具 id（工具可能已被删除）
    #[serde(default)]
    pub tool_id: String,
    pub port: u16,
    /// 登记时间（毫秒时间戳）
    #[serde(default)]
    pub at: u64,
    /// ready=空闲待清理 / cleaning=正在清理 / busy-tool=被运行中的工具占用 /
    /// busy-external=被平台外程序占用 / cooldown=上次未完成，稍后重试
    pub state: String,
    /// 冷却结束时间（毫秒时间戳）；仅 cooldown 时有值
    #[serde(default)]
    pub retry_after: u64,
}

/// 已安装到某工具的 npm 包
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub dev: bool,
}
