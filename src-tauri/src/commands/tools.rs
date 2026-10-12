//! 工具管理命令：列表 / 状态 / 启停 / 日志 / 新建 / 文件读写

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::models::{ResidualInfo, StartOutcome, ToolInfo};
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

/// 启动工具。
///
/// `reassign_port` 只在用户已确认「重新分配端口」时才传 true：
/// 这会换掉该工具的端口，进而换掉它 localStorage / IndexedDB 的存放位置，
/// 所以必须由界面弹窗征得同意后才可以调用。
#[tauri::command]
pub async fn start_tool(
    app: AppHandle,
    id: String,
    reassign_port: Option<bool>,
) -> Result<StartOutcome, String> {
    let body = json!({ "reassignPort": reassign_port.unwrap_or(false) });
    let v = call(&app, "POST", &format!("/tools/{id}/start"), Some(body)).await?;

    // 宿主遇到记忆端口被占用时会回一个 pending 中间态，交给界面弹窗处理
    if v.get("pending").and_then(|x| x.as_str()) == Some("portBusy") {
        return Ok(StartOutcome::PortBusy {
            tool_id: id,
            port: v.get("port").and_then(|x| x.as_u64()).unwrap_or(0) as u16,
            occupied_by: v
                .get("occupiedBy")
                .and_then(|x| x.as_str())
                .unwrap_or("other")
                .to_string(),
        });
    }

    let tool = parse_tool(v)?;
    refresh_tray(&app);
    Ok(StartOutcome::Started { tool })
}

#[tauri::command]
pub async fn stop_tool(app: AppHandle, id: String) -> Result<(), String> {
    call(&app, "POST", &format!("/tools/{id}/stop"), None).await?;
    refresh_tray(&app);
    Ok(())
}

/// 启动/停止工具后刷新托盘“后台工具”子菜单（fire-and-forget）
fn refresh_tray(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        crate::refresh_tray_menu(&app).await;
    });
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

/// 校验「待创建文件」的相对路径是否合法（不穿越、非隐藏/保留名），
/// 父目录不存在时自动创建，最后做越界校验，返回完整路径。
fn validate_new_file_path(data_dir: &Path, id: &str, rel: &str) -> Result<PathBuf, String> {
    if !regex_id(id) {
        return Err("非法的工具 id".into());
    }
    let rel = rel.trim();
    if rel.is_empty() {
        return Err("文件名不能为空".into());
    }
    if rel.ends_with('/') {
        return Err("文件名不能以 / 结尾".into());
    }
    if rel.contains("..") || Path::new(rel).is_absolute() || rel.contains('\\') {
        return Err("非法的相对路径".into());
    }
    // 最后一段不允许是隐藏文件 / 平台保留目录
    let last = rel.rsplit('/').next().unwrap_or(rel);
    if last.starts_with('.') || last.starts_with('_') || last == "node_modules" {
        return Err(format!("不允许创建该文件名：{last}"));
    }
    // Windows 文件名非法字符
    if rel.chars().any(|c| matches!(c, ':' | '?' | '*' | '"' | '<' | '>' | '|')) {
        return Err("文件名包含非法字符（: ? * \" < > |）".into());
    }

    let tool_dir = data_dir.join("toolbox").join(id);
    if !tool_dir.exists() {
        return Err(format!("工具 {id} 不存在"));
    }
    let full = tool_dir.join(rel);
    if full.exists() {
        return Err(format!("文件 {rel} 已存在"));
    }
    // 父目录可能还不存在（如 src/foo.js），先创建再校验越界
    let parent = full.parent().ok_or("无效路径")?;
    fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {e}"))?;
    let canon_tool = tool_dir
        .canonicalize()
        .map_err(|_| "工具目录不存在".to_string())?;
    let canon_parent = parent
        .canonicalize()
        .map_err(|_| "无效路径".to_string())?;
    if !canon_parent.starts_with(&canon_tool) {
        return Err("路径越界".into());
    }
    Ok(full)
}

/// 在工具目录中新建文件：支持子目录路径（如 src/util.js，父目录自动创建）。
/// 创建后由前端刷新文件树并打开。
#[tauri::command]
pub async fn create_tool_file(
    app: AppHandle,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let data_dir = Sidecar::data_dir(&app)?;
    let full = validate_new_file_path(&data_dir, &id, &path)?;
    fs::write(&full, content).map_err(|e| format!("写入 {path} 失败: {e}"))
}

/// 删除工具内的一个文件（仅文件；目录会被 remove_file 拒绝）。
/// 复用 resolve_tool_path 的越界校验，删除后由前端刷新文件树。
#[tauri::command]
pub async fn delete_tool_file(
    app: AppHandle,
    id: String,
    path: String,
) -> Result<(), String> {
    let data_dir = Sidecar::data_dir(&app)?;
    let full = resolve_tool_path(&data_dir, &id, &path)?;
    fs::remove_file(&full).map_err(|e| format!("删除 {path} 失败: {e}"))
}

/// 用系统文件管理器打开目录：id 为空时打开整个工具箱目录（toolbox/），
/// 否则打开该工具的目录，方便用户查看/管理保存的文件。
#[tauri::command]
pub async fn open_tool_dir(app: AppHandle, id: String) -> Result<(), String> {
    let data_dir = Sidecar::data_dir(&app)?;
    let toolbox = data_dir.join("toolbox");
    let dir = if id.trim().is_empty() {
        toolbox
    } else {
        if !regex_id(&id) {
            return Err("非法的工具 id".into());
        }
        toolbox.join(&id)
    };
    if !dir.exists() {
        return Err(format!("目录不存在：{}", dir.display()));
    }

    #[cfg(target_os = "windows")]
    let mut cmd = std::process::Command::new("explorer");
    #[cfg(target_os = "macos")]
    let mut cmd = std::process::Command::new("open");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(&dir)
        .spawn()
        .map_err(|e| format!("无法打开目录: {e}"))?;
    Ok(())
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

    // 清掉端口记忆，并把该端口登记为「残留」：
    // 工具虽然删了，它那个 origin 上的 localStorage / IndexedDB 还留在磁盘上，
    // 交给宿主等端口空闲时占回来清理。同时这也避免将来同名工具复用旧端口、
    // 从而继承上一个工具的存储（同一个 origin 就是同一个存储桶）。
    let ports_file = data_dir.join("ports.json");
    if let Ok(raw) = fs::read_to_string(&ports_file) {
        if let Ok(mut obj) =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&raw)
        {
            if let Some(p) = obj.remove(&id).and_then(|v| v.as_u64()) {
                let _ = call(
                    &app,
                    "POST",
                    "/residuals",
                    Some(json!({ "toolId": id.clone(), "port": p })),
                )
                .await;
            }
            let _ = fs::write(&ports_file, serde_json::to_string_pretty(&obj).unwrap());
        }
    }
    Ok(())
}

/// 触发一次「残留数据清理」。
///
/// 工具换端口或被删除后，旧端口上的 localStorage / IndexedDB 会变成残留 ——
/// 同源策略不允许从外部删除。宿主的办法是把那个端口重新占下来，
/// 取得该 origin 的同源身份后，用页面清掉自己的数据。
///
/// 返回的端口列表需要调用方**为每个端口渲染一次隐藏 iframe**：
/// 清理页必须真正在那个 origin 下执行才有效。
#[tauri::command]
pub async fn sweep_residuals(app: AppHandle, force: Option<bool>) -> Result<Vec<u16>, String> {
    let body = json!({ "force": force.unwrap_or(false) });
    let v = call(&app, "POST", "/residuals/sweep", Some(body)).await?;
    Ok(v.as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_u64())
                .map(|x| x as u16)
                .collect()
        })
        .unwrap_or_default())
}

/// 残留数据清单（含当前状态），供设置页展示「有哪些残留、属于哪个工具、何时会清理」。
#[tauri::command]
pub async fn list_residuals(app: AppHandle) -> Result<Vec<ResidualInfo>, String> {
    let v = call(&app, "GET", "/residuals", None).await?;
    serde_json::from_value(v).map_err(|e| format!("残留清单解析失败: {e}"))
}

/// 放弃清理某个端口的残留数据：数据继续留在磁盘上，平台不再尝试清理它。
#[tauri::command]
pub async fn ignore_residual(app: AppHandle, port: u16) -> Result<(), String> {
    call(
        &app,
        "POST",
        "/residuals/ignore",
        Some(json!({ "port": port })),
    )
    .await?;
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

/// 用系统默认浏览器打开外部地址。
/// URL 工具被目标站点的 X-Frame-Options / CSP frame-ancestors 挡住时作为兜底。
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("仅支持 http:// 或 https:// 地址".into());
    }

    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW，避免弹黑框
        c
    };
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(&url);
        c
    };
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(&url);
        c
    };

    cmd.spawn()
        .map_err(|e| format!("打开浏览器失败: {e}"))?;
    Ok(())
}

// ------------------------------------------------------------------ URL 工具

/// URL 工具地址白名单：https:// 任意主机；http:// 仅限本机回环地址。
fn validate_tool_url(url: &str) -> Result<(), String> {
    let lower = url.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        let authority = rest
            .split(['/', '?', '#'])
            .next()
            .unwrap_or("")
            .rsplit('@') // 去掉 userinfo
            .next()
            .unwrap_or("");
        let host = if let Some(end) = authority.find(']') {
            &authority[..=end] // IPv6 字面量，如 [::1]:8080
        } else {
            authority.split(':').next().unwrap_or("")
        };
        if matches!(host, "127.0.0.1" | "localhost" | "[::1]" | "::1") {
            return Ok(());
        }
        return Err("http:// 仅允许本机回环地址（127.0.0.1 / localhost）".into());
    }
    Err("地址需以 http:// 或 https:// 开头".into())
}

/// 名称留空时从地址里猜一个：优先取最后一段路径，退化为主机名。
fn derive_name_from_url(url: &str) -> String {
    let after_scheme = url.split("://").nth(1).unwrap_or(url);
    let no_query = after_scheme.split(['?', '#']).next().unwrap_or(after_scheme);
    let segs: Vec<&str> = no_query.trim_end_matches('/').split('/').collect();
    match segs.last() {
        Some(last) if segs.len() > 1 && !last.is_empty() => (*last).to_string(),
        _ => segs.first().copied().unwrap_or("外部工具").to_string(),
    }
}

/// 添加 URL 工具：在 toolbox/ 下建一个只含 manifest.json 的目录，指向外部地址。
/// 宿主会把 type=="url" 的工具直接视为可用，不启动任何 Node 进程。
/// 返回生成的工具 id。
#[tauri::command]
pub async fn add_url_tool(
    app: AppHandle,
    url: String,
    name: String,
    icon: Option<String>,
) -> Result<String, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("地址不能为空".into());
    }
    validate_tool_url(&url)?;

    let name = {
        let n = name.trim().to_string();
        if n.is_empty() {
            derive_name_from_url(&url)
        } else {
            n
        }
    };

    let data_dir = Sidecar::data_dir(&app)?;
    let toolbox = data_dir.join("toolbox");
    fs::create_dir_all(&toolbox).map_err(|e| format!("创建工具箱目录失败: {e}"))?;

    let base = {
        let s = slugify(&name);
        if s.is_empty() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() % 1_000_000)
                .unwrap_or(0);
            format!("web-{ts}")
        } else {
            s
        }
    };

    // 生成不冲突的 id
    let mut id = base.clone();
    let mut n = 2u32;
    while toolbox.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
        if n > 999 {
            return Err("无法生成唯一的工具 id".into());
        }
    }

    let dir = toolbox.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建工具目录失败: {e}"))?;

    let icon = icon
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "🔗".to_string());
    let manifest = json!({
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": format!("外部地址工具 · {url}"),
        "icon": icon,
        "type": "url",
        "url": url,
    });
    fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    )
    .map_err(|e| format!("写入 manifest 失败: {e}"))?;

    Ok(id)
}

// ------------------------------------------------------------ 本地网页工具

/// 原样递归复制目录，跳过 node_modules / .git / 隐藏项。
/// 与 copy_template 的区别：不做 `__ID__` 占位符替换。
fn copy_dir_raw(src: &Path, dst: &Path) -> Result<(), String> {
    fs::create_dir_all(dst).map_err(|e| format!("创建目录失败: {e}"))?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == "node_modules" || name == ".git" || name.starts_with('.') {
            continue;
        }
        let target = dst.join(&name);
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        if ft.is_dir() {
            copy_dir_raw(&entry.path(), &target)?;
        } else if ft.is_file() {
            fs::copy(entry.path(), &target).map_err(|e| format!("复制 {name} 失败: {e}"))?;
        }
    }
    Ok(())
}

/// 添加本地网页工具：把指定的 HTML 文件（或包含 index.html 的整个目录）
/// 复制进 `toolbox/<id>/`，由宿主用内置静态服务在分配到的端口上托管。
///
/// 相比直接双击打开 .html，这样做的意义在于：
/// - 页面运行在 `http://127.0.0.1:<port>`，属于**安全上下文**，
///   WebRTC、剪贴板、Service Worker 等只有在 https / localhost 下才可用的能力都能用；
/// - 端口由平台分配并记忆，**origin 稳定**，localStorage / IndexedDB 可跨重启持久。
#[tauri::command]
pub async fn add_static_tool(
    app: AppHandle,
    path: String,
    name: String,
    icon: Option<String>,
) -> Result<String, String> {
    let src = PathBuf::from(path.trim());
    if !src.exists() {
        return Err(format!("路径不存在：{}", src.display()));
    }

    // 默认名称取文件/目录名（去扩展名）
    let default_name = {
        let raw = if src.is_dir() {
            src.file_name()
        } else {
            src.file_stem().or_else(|| src.file_name())
        };
        raw.map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "本地网页".to_string())
    };

    if src.is_dir() {
        if !src.join("index.html").is_file() {
            return Err("该目录下没有 index.html，无法作为网页工具的入口".into());
        }
    } else if src.is_file() {
        let ext = src
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ext != "html" && ext != "htm" {
            return Err("只支持 .html / .htm 文件，或包含 index.html 的目录".into());
        }
    } else {
        return Err("该路径既不是文件也不是目录".into());
    }

    let name = {
        let n = name.trim().to_string();
        if n.is_empty() {
            default_name
        } else {
            n
        }
    };

    let data_dir = Sidecar::data_dir(&app)?;
    let toolbox = data_dir.join("toolbox");
    fs::create_dir_all(&toolbox).map_err(|e| format!("创建工具箱目录失败: {e}"))?;

    let base = {
        let s = slugify(&name);
        if s.is_empty() {
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() % 1_000_000)
                .unwrap_or(0);
            format!("page-{ts}")
        } else {
            s
        }
    };

    // 生成不冲突的 id
    let mut id = base.clone();
    let mut n = 2u32;
    while toolbox.join(&id).exists() {
        id = format!("{base}-{n}");
        n += 1;
        if n > 999 {
            return Err("无法生成唯一的工具 id".into());
        }
    }

    let dir = toolbox.join(&id);
    fs::create_dir_all(&dir).map_err(|e| format!("创建工具目录失败: {e}"))?;

    // 复制内容；失败则回滚，避免留下半成品目录
    let copied = if src.is_dir() {
        copy_dir_raw(&src, &dir)
    } else {
        fs::copy(&src, dir.join("index.html"))
            .map(|_| ())
            .map_err(|e| format!("复制文件失败: {e}"))
    };
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&dir);
        return Err(e);
    }
    if !dir.join("index.html").is_file() {
        let _ = fs::remove_dir_all(&dir);
        return Err("复制完成后未找到 index.html，已回滚".into());
    }

    let icon = icon
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "📄".to_string());
    let manifest = json!({
        "id": id,
        "name": name,
        "version": "1.0.0",
        "description": format!("本地网页工具 · {}", src.display()),
        "icon": icon,
        "type": "static",
        "html": "index.html",
        "port": 0
    });
    if let Err(e) = fs::write(
        dir.join("manifest.json"),
        serde_json::to_string_pretty(&manifest).unwrap(),
    ) {
        let _ = fs::remove_dir_all(&dir);
        return Err(format!("写入 manifest 失败: {e}"));
    }

    Ok(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_任意主机都允许() {
        assert!(validate_tool_url("https://example.com/a/b").is_ok());
        assert!(validate_tool_url("https://example.com:8443/x?y=1#z").is_ok());
        assert!(validate_tool_url("HTTPS://EXAMPLE.COM").is_ok());
    }

    #[test]
    fn http_回环地址允许() {
        assert!(validate_tool_url("http://127.0.0.1:8777").is_ok());
        assert!(validate_tool_url("http://127.0.0.1:8777/").is_ok());
        assert!(validate_tool_url("http://localhost:3000/a").is_ok());
        assert!(validate_tool_url("http://localhost").is_ok());
        assert!(validate_tool_url("http://[::1]:8080/").is_ok());
        assert!(validate_tool_url("http://user:pass@127.0.0.1:9000/").is_ok());
    }

    #[test]
    fn http_非回环一律拒绝() {
        assert!(validate_tool_url("http://example.com/").is_err());
        assert!(validate_tool_url("http://192.168.1.101:8080/").is_err());
        assert!(validate_tool_url("http://10.0.0.1/").is_err());
        // 后缀伪装不能绕过
        assert!(validate_tool_url("http://127.0.0.1.evil.com/").is_err());
        assert!(validate_tool_url("http://localhost.evil.com/").is_err());
    }

    #[test]
    fn 其它协议与畸形输入拒绝() {
        assert!(validate_tool_url("file:///etc/passwd").is_err());
        assert!(validate_tool_url("javascript:alert(1)").is_err());
        assert!(validate_tool_url("ftp://example.com").is_err());
        assert!(validate_tool_url("").is_err());
        assert!(validate_tool_url("example.com").is_err());
    }

    #[test]
    fn 从地址猜名称() {
        assert_eq!(
            derive_name_from_url("https://example.com/tools/p2p-chat/"),
            "p2p-chat"
        );
        assert_eq!(derive_name_from_url("http://127.0.0.1:8777/"), "127.0.0.1:8777");
        assert_eq!(derive_name_from_url("https://example.com"), "example.com");
    }

    #[test]
    fn 名称转_id_合法() {
        assert_eq!(slugify("P2P 聊天室"), "p2p");
        assert_eq!(slugify("My Tool.v2"), "my-tool-v2");
        assert!(regex_id(&slugify("Hello World")));
        assert!(slugify("中文名字").is_empty()); // 需要调用方兜底随机后缀
    }
}
