use serde::{Deserialize, Serialize};

/// 工具条目（对应宿主 /tools 返回，camelCase 与前端 types.ts 对齐）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub icon: Option<String>,
    pub main: String,
    pub html: String,
    /// running | stopped | error
    pub status: String,
    /// 运行中的实际端口
    pub port: Option<u16>,
    pub pid: Option<i32>,
    pub error: Option<String>,
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
