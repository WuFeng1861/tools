//! 依赖管理命令：安装 / 卸载 / 列出 npm 包

use serde_json::json;
use tauri::AppHandle;

use crate::models::PackageInfo;

#[tauri::command]
pub async fn install_package(
    app: AppHandle,
    id: String,
    pkg: String,
    version: Option<String>,
) -> Result<Vec<PackageInfo>, String> {
    let body = json!({ "pkg": pkg, "version": version });
    let v = crate::sidecar::call(
        &app,
        "POST",
        &format!("/packages/{id}/install"),
        Some(body),
    )
    .await?;
    serde_json::from_value(v).map_err(|e| format!("包列表解析失败: {e}"))
}

#[tauri::command]
pub async fn uninstall_package(
    app: AppHandle,
    id: String,
    pkg: String,
) -> Result<Vec<PackageInfo>, String> {
    let body = json!({ "pkg": pkg });
    let v = crate::sidecar::call(
        &app,
        "POST",
        &format!("/packages/{id}/uninstall"),
        Some(body),
    )
    .await?;
    serde_json::from_value(v).map_err(|e| format!("包列表解析失败: {e}"))
}

#[tauri::command]
pub async fn list_packages(app: AppHandle, id: String) -> Result<Vec<PackageInfo>, String> {
    let v = crate::sidecar::call(&app, "GET", &format!("/packages/{id}"), None).await?;
    serde_json::from_value(v).map_err(|e| format!("包列表解析失败: {e}"))
}
