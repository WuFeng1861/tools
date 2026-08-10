//! 工具管理命令：列表 / 状态 / 启停 / 日志 / 新建 / 文件读写

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::models::ToolInfo;
use crate::sidecar::{call, Sidecar};

/// 校验并解析工具目录内的相对路径，防止目录穿越。
/// 返回工具目录下规范化后的完整路径。
fn resolve_tool_path(data_dir: &Path, id: &str, rel: &str) -> Result<PathBuf, String> {
    if !regex_id(id) {
        return Err("非法的工具 id".into());
    }
    if rel.contains("..") || Path::new(rel).is_absolute() {
        return Err("非法的相对路径".into());
    }
    let tool_dir = data_dir.join("toolbox").join(id);
    let canon_tool = tool_dir
        .canonicalize()
        .map_err(|_| "工具目录不存在".to_string())?;
    let full = tool_dir.join(rel);
    // 文件存在则校验其自身；不存在则校验父目录（写入场景）
    let (parent, name) = (
        full.parent().ok_or("无效路径")?,
        full.file_name().ok_or("无效路径")?,
    );
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| "父目录不存在".to_string())?;
    if !canon_parent.starts_with(&canon_tool) {
        return Err("路径越界".into());
    }
    Ok(parent.join(name))
}

fn regex_id(id: &str) -> bool {
    // 手写校验，避免引入 regex 依赖
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn parse_tool(v: serde_json::Value) -> Result<ToolInfo, String> {
    serde_json::from_value(v).map_err(|e| format!("工具数据解析失败: {e}"))
}

fn slugify(s: &str) -> String {
    let mut out = String::new();
    for c in s.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
        } else if c == ' ' || c == '_' || c == '.' || c == '-' || c == '\t' {
            out.push('-');
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').to_string()
}

#[tauri::command]
pub async fn list_tools(app: AppHandle) -> Result<Vec<ToolInfo>, String> {
    let v = call(&app, "GET", "/tools", None).await?;
    serde_json::from_value(v).map_err(|e| format!("工具列表解析失败: {e}"))
}

#[tauri::command]
pub async fn tool_status(app: AppHandle, id: String) -> Result<ToolInfo, String> {
    let v = call(&app, "GET", &format!("/tools/{id}"), None).await?;
    parse_tool(v)
}

#[tauri::command]
pub async fn start_tool(app: AppHandle, id: String) -> Result<ToolInfo, String> {
    let v = call(&app, "POST", &format!("/tools/{id}/start"), None).await?;
    parse_tool(v)
}

#[tauri::command]
pub async fn stop_tool(app: AppHandle, id: String) -> Result<(), String> {
    call(&app, "POST", &format!("/tools/{id}/stop"), None).await?;
    Ok(())
}

#[tauri::command]
pub async fn tool_logs(
    app: AppHandle,
    id: String,
    tail: Option<usize>,
) -> Result<Vec<String>, String> {
    let v = call(&app, "GET", &format!("/tools/{id}/logs"), None).await?;
    let arr: Vec<String> = serde_json::from_value(v).unwrap_or_default();
    Ok(match tail {
        Some(n) => arr.into_iter().rev().take(n).collect::<Vec<_>>().into_iter().rev().collect(),
        None => arr,
    })
}

/// 新建工具：在 toolbox 下生成骨架目录（manifest.json / index.html / app.js / package.json）
/// 返回生成的工具 id。
/// `template` 预留（M6 模板系统），当前总是生成基础骨架。
#[tauri::command]
pub async fn create_tool(
    app: AppHandle,
    name: String,
    _template: String,
) -> Result<String, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("工具名称不能为空".into());
    }

    let mut id = slugify(&name);
    if id.is_empty() {
        // 中文等无法转 ASCII 的场景，追加随机后缀保证合法
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.subsec_nanos() % 10000)
            .unwrap_or(0);
        id = format!("tool-{ts}");
    }

    let data_dir = Sidecar::data_dir(&app)?;
    let toolbox = data_dir.join("toolbox");
    let dir = toolbox.join(&id);
    if dir.exists() {
        return Err(format!("工具 {id} 已存在"));
    }
    fs::create_dir_all(&dir).map_err(|e| format!("创建工具目录失败: {e}"))?;

    // 优先从内置模板复制（__ID__ / __NAME__ 占位符替换）
    let mut used_template = false;
    if let Ok(resource_dir) = app.path().resource_dir() {
        let tmpl_dir = resource_dir
            .join("resources")
            .join("templates")
            .join(&_template);
        if tmpl_dir.is_dir() {
            copy_template(&tmpl_dir, &dir, &id, &name)?;
            used_template = true;
        }
    }

    if !used_template {
    let manifest_file = json!({
        "id": id,
        "name": name,
        "version": "0.1.0",
        "description": "新建的工具",
        "main": "app.js",
        "html": "index.html",
        "port": 0
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest_file).unwrap(),
    )
    .map_err(|e| format!("写入 manifest 失败: {e}"))?;

    let pkg_file = json!({
        "name": id,
        "version": "0.1.0",
        "private": true,
        "main": "app.js"
    });
    fs::write(
        dir.join("package.json"),
        serde_json::to_string_pretty(&pkg_file).unwrap(),
    )
    .map_err(|e| format!("写入 package.json 失败: {e}"))?;

    fs::write(
        dir.join("app.js"),
        r#"// 工具后端入口（Node.js）
// 约定：监听 process.env.TOOL_PORT，GET / 返回 index.html。
// 推荐用运行时帮助库，开箱即用：
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,
  routes: {
    "/api/ping": (req, res, body) => res.json({ ok: true, msg: "pong", time: Date.now() }),
  },
});

server.start();
"#,
    )
    .map_err(|e| format!("写入 app.js 失败: {e}"))?;

    fs::write(
        dir.join("index.html"),
        r#"<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <title>{{name}}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 40px; }
    button { padding: 8px 16px; }
  </style>
</head>
<body>
  <h1>{{name}}</h1>
  <p>这是工具界面。你可以修改 index.html（界面）与 app.js（后端）。</p>
  <button onclick="call()">调用后端 API</button>
  <pre id="out"></pre>
  <script>
    async function call() {
      const r = await fetch('/api/ping');
      document.getElementById('out').textContent = JSON.stringify(await r.json(), null, 2);
    }
  </script>
</body>
</html>
"#
    .replace("{{name}}", &name),
    )
    .map_err(|e| format!("写入 index.html 失败: {e}"))?;
    } // !used_template

    Ok(id)
}

/// 递归复制模板目录，并把文本中的 `__ID__` / `__NAME__` 占位符替换为实际值。
fn copy_template(src: &Path, dst: &Path, id: &str, name: &str) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_template(&entry.path(), &target, id, name)?;
        } else {
            let raw = fs::read(entry.path()).map_err(|e| e.to_string())?;
            let content = String::from_utf8_lossy(&raw)
                .replace("__ID__", id)
                .replace("__NAME__", name);
            fs::write(&target, content.as_bytes()).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 列出工具目录内的文件（相对路径），跳过 node_modules / 隐藏文件
#[tauri::command]
pub async fn list_tool_files(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let data_dir = Sidecar::data_dir(&app)?;
    if !regex_id(&id) {
        return Err("非法的工具 id".into());
    }
    let tool_dir = data_dir.join("toolbox").join(&id);
    if !tool_dir.exists() {
        return Err(format!("工具 {id} 不存在"));
    }
    let mut out = Vec::new();
    collect_files(&tool_dir, Path::new(""), &mut out);
    out.sort();
    Ok(out)
}

fn collect_files(dir: &Path, rel: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "node_modules" || name.starts_with('.') || name.starts_with('_') {
            continue;
        }
        let rel_path = rel.join(&name);
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_dir() {
            collect_files(&entry.path(), &rel_path, out);
        } else {
            out.push(rel_path.to_string_lossy().into_owned());
        }
    }
}

#[tauri::command]
pub async fn read_tool_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<String, String> {
    let data_dir = Sidecar::data_dir(&app)?;
    let full = resolve_tool_path(&data_dir, &id, &path)?;
    fs::read_to_string(&full).map_err(|e| format!("读取 {path} 失败: {e}"))
}

#[tauri::command]
pub async fn write_tool_file(
    app: AppHandle,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let data_dir = Sidecar::data_dir(&app)?;
    let full = resolve_tool_path(&data_dir, &id, &path)?;
    fs::write(&full, content).map_err(|e| format!("写入 {path} 失败: {e}"))
}

/// 删除工具：先停止进程，再删除工具目录，并从排序文件移除
#[tauri::command]
pub async fn delete_tool(app: AppHandle, id: String) -> Result<(), String> {
    if !regex_id(&id) {
        return Err("非法的工具 id".into());
    }
    // 先停止工具进程（宿主可能未运行，忽略错误）
    let _ = call(&app, "POST", &format!("/tools/{id}/stop"), None).await;

    let data_dir = Sidecar::data_dir(&app)?;
    let dir = data_dir.join("toolbox").join(&id);
    if dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("删除工具目录失败: {e}"))?;
    }

    // 从排序文件移除该 id
    let order_file = data_dir.join("toolbox").join("_order.json");
    if let Ok(raw) = fs::read_to_string(&order_file) {
        if let Ok(mut arr) = serde_json::from_str::<Vec<String>>(&raw) {
            arr.retain(|x| x != &id);
            let _ = fs::write(&order_file, serde_json::to_string(&arr).unwrap());
        }
    }
    Ok(())
}

/// 保存启动器的工具排序（写入 toolbox/_order.json，宿主按此排序返回）
#[tauri::command]
pub async fn reorder_tools(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    for id in &ids {
        if !regex_id(id) {
            return Err(format!("非法的工具 id: {id}"));
        }
    }
    let data_dir = Sidecar::data_dir(&app)?;
    let toolbox = data_dir.join("toolbox");
    fs::create_dir_all(&toolbox).map_err(|e| e.to_string())?;
    let order_file = toolbox.join("_order.json");
    fs::write(&order_file, serde_json::to_string(&ids).unwrap())
        .map_err(|e| format!("保存排序失败: {e}"))
}
