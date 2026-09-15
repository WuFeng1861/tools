mod commands;
mod models;
mod sidecar;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::net::TcpStream;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::WebviewWindowBuilder;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

const TRAY_ID: &str = "main-tray";
/// 剪贴板工具 id（平台内置后台常驻工具）
const CLIPBOARD_TOOL_ID: &str = "clipboard-history";
/// 面板窗口 label 前缀：tool-panel-<tool_id>-<panel_id>
const PANEL_LABEL_PREFIX: &str = "tool-panel-";

/// 一条全局快捷键声明（来自工具 manifest，合并 override 后的解析态）
#[derive(Debug, Clone)]
struct ShortcutEntry {
    tool_id: String,
    tool_name: String,
    shortcut_id: String,
    name: String,
    /// 当前生效组合键（override 优先，否则 manifest 默认）
    accel: String,
    /// manifest 默认组合键
    default_accel: String,
    /// 动作描述串，按下时原样透传给工具的 event 端点
    action: String,
    /// 与本注册表内其它项撞同一组合键
    conflict: bool,
}

/// 快捷键前端视图（camelCase 对齐前端）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShortcutView {
    tool_id: String,
    tool_name: String,
    tool_running: bool,
    shortcut_id: String,
    name: String,
    accel: String,
    default_accel: String,
    conflict: bool,
    registered: bool,
    action: String,
}

/// 平台级快捷键状态：注册表 + 当前已成功绑定的组合键集
#[derive(Default)]
struct SettingsState {
    registry: Mutex<Vec<ShortcutEntry>>,
    registered: Mutex<HashSet<String>>,
}

/// 屏蔽 Windows 因进程创建失败而弹出的错误框（如关机时 taskkill 失败）
#[cfg(windows)]
mod errguard {
    #[link(name = "kernel32")]
    extern "system" {
        fn SetErrorMode(uMode: u32) -> u32;
    }
    const SEM_FAILCRITICALERRORS: u32 = 0x0001;
    const SEM_NOGPFAULTERRORBOX: u32 = 0x0002;
    const SEM_NOOPENFILEERRORBOX: u32 = 0x8000;
    pub fn suppress() {
        unsafe {
            SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
        }
    }
}

#[cfg(not(windows))]
mod errguard {
    pub fn suppress() {}
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    errguard::suppress(); // 屏蔽进程创建失败时的错误弹框（关机/退出时 taskkill 等）
    tauri::Builder::default()
        .manage(sidecar::Sidecar::default())
        .manage(SettingsState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(
            tauri_plugin_autostart::Builder::new()
                // 自启命令带 --autostart，启动时据此不弹主界面、直接进托盘
                .arg("--autostart")
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            commands::tools::list_tools,
            commands::tools::tool_status,
            commands::tools::start_tool,
            commands::tools::stop_tool,
            commands::tools::tool_logs,
            commands::tools::create_tool,
            commands::tools::list_tool_files,
            commands::tools::read_tool_file,
            commands::tools::write_tool_file,
            commands::tools::create_tool_file,
            commands::tools::delete_tool_file,
            commands::tools::open_tool_dir,
            commands::tools::delete_tool,
            commands::tools::reorder_tools,
            commands::packages::install_package,
            commands::packages::uninstall_package,
            commands::packages::list_packages,
            hide_to_tray,
            quit_app,
            open_tool_panel,
            hide_tool_panel,
            list_shortcuts,
            set_shortcut_accel,
            reset_shortcut_accel,
            get_clipboard_hotkey,
            set_clipboard_hotkey,
            get_autostart,
            set_autostart,
        ])
        .setup(|app| {
            // 手动启动才显示主界面；开机自启（带 --autostart）保持隐藏、默认进托盘后台
            if !std::env::args().any(|a| a == "--autostart") {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                }
            }
            setup_tray(app.handle())?;
            // 托盘后台工具列表 + 快捷键注册表：先确保宿主起来同步一次，之后周期性保持最新
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                sync_shortcuts(&handle).await;
                refresh_tray_menu(&handle).await;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    let up = handle
                        .state::<sidecar::Sidecar>()
                        .host_port
                        .lock()
                        .unwrap()
                        .is_some();
                    if up {
                        sync_shortcuts(&handle).await;
                        refresh_tray_menu(&handle).await;
                    }
                }
            });
            // 监控各工具目录的面板“开/关”标记：
            // 工具的用户代码想弹面板就写 .quick-open，想收起就写 .quick-close，平台看到即执行。
            let app2 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                    poll_panel_flags(&app2).await;
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // 拦截右上角关闭：交给前端弹窗选择“后台运行 / 退出程序”
                api.prevent_close();
                let _ = window.emit("app://close-requested", ());
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_host(app);
            }
        });
}

// ------------------------------------------------------------------ 托盘

/// 创建托盘（图标 + 菜单；菜单后续由 refresh_tray_menu 动态刷新）
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };
    let menu = build_tray_menu(app, &[])?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("小工具平台")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // 左键单击抬起 / 左键双击 → 显示主界面
            let app = tray.app_handle();
            match event {
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
                | TrayIconEvent::DoubleClick {
                    button: MouseButton::Left,
                    ..
                } => show_main_window(app),
                _ => {}
            }
        })
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            match id {
                "tray-show" => show_main_window(app),
                "tray-quit" => app.exit(0),
                _ if id.starts_with("tray-tool:") => {
                    let tool_id = id.trim_start_matches("tray-tool:");
                    if tool_id != "none" {
                        open_tool_from_tray(app, tool_id);
                    }
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(())
}

/// 构建托盘菜单：显示主界面 / 后台工具子菜单 / 分隔线 / 退出程序
fn build_tray_menu(app: &AppHandle, tools: &[(String, String)]) -> tauri::Result<Menu<tauri::Wry>> {
    let show = MenuItem::with_id(app, "tray-show", "显示主界面", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "tray-quit", "退出程序", true, None::<&str>)?;
    let bg = Submenu::new(app, "后台工具 ▸", true)?;
    for (id, name) in tools {
        bg.append(&MenuItem::with_id(
            app,
            format!("tray-tool:{id}"),
            name,
            true,
            None::<&str>,
        )?)?;
    }
    if tools.is_empty() {
        bg.append(&MenuItem::with_id(
            app,
            "tray-tool:none",
            "（无后台常驻工具）",
            false,
            None::<&str>,
        )?)?;
    }
    let menu = Menu::new(app)?;
    menu.append(&show)?;
    menu.append(&bg)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&quit)?;
    Ok(menu)
}

/// 动态刷新托盘“后台工具”子菜单（依据宿主中的 autoStart 工具）
pub async fn refresh_tray_menu(app: &AppHandle) {
    let tools = sidecar::call(app, "GET", "/tools", None)
        .await
        .unwrap_or(serde_json::Value::Null);
    let entries: Vec<(String, String)> = tools
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|t| {
                    let auto = t
                        .get("autoStart")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !auto {
                        return None;
                    }
                    let id = t
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let name = t
                        .get("name")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&id)
                        .to_string();
                    let status = t.get("status").and_then(|v| v.as_str()).unwrap_or("");
                    let label = if status == "running" {
                        format!("● {name}")
                    } else {
                        format!("○ {name}")
                    };
                    Some((id, label))
                })
                .collect()
        })
        .unwrap_or_default();
    if let Ok(menu) = build_tray_menu(app, &entries) {
        if let Some(tray) = app.tray_by_id(TRAY_ID) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// 从托盘点击后台工具：确保启动 → 显示主窗口 → 通知前端导航
fn open_tool_from_tray(app: &AppHandle, id: &str) {
    let app = app.clone();
    let id = id.to_string();
    tauri::async_runtime::spawn(async move {
        let _ = sidecar::call(&app, "POST", &format!("/tools/{id}/start"), None).await;
        show_main_window(&app);
        let _ = app.emit("app://open-tool", serde_json::json!({ "id": id }));
    });
}

fn show_main_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------------ 命令

/// 隐藏主窗口到托盘（host 与工具进程照常运行）
#[tauri::command]
async fn hide_to_tray(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 真正退出程序（触发 RunEvent::Exit → shutdown_host 清理）
#[tauri::command]
async fn quit_app(app: AppHandle) -> Result<(), String> {
    show_main_window(&app);
    app.exit(0);
    Ok(())
}

/// 列出所有工具的全局快捷键（含冲突 / 注册 / 工具运行状态），供前端配置页渲染
#[tauri::command]
async fn list_shortcuts(app: AppHandle) -> Result<Vec<ShortcutView>, String> {
    let registry = app.state::<SettingsState>().registry.lock().unwrap().clone();
    let registered = app.state::<SettingsState>().registered.lock().unwrap().clone();
    // 工具元信息（名称 + 是否运行）
    let mut tool_meta: HashMap<String, (String, bool)> = HashMap::new();
    if let Ok(v) = sidecar::call(&app, "GET", "/tools", None).await {
        if let Some(arr) = v.as_array() {
            for t in arr {
                if let Some(id) = t.get("id").and_then(|x| x.as_str()) {
                    let name = t
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or(id)
                        .to_string();
                    let running = t.get("status").and_then(|x| x.as_str()) == Some("running");
                    tool_meta.insert(id.to_string(), (name, running));
                }
            }
        }
    }
    let mut out = Vec::with_capacity(registry.len());
    for e in &registry {
        let (tool_name, tool_running) =
            tool_meta.get(&e.tool_id).cloned().unwrap_or((e.tool_id.clone(), false));
        let is_registered =
            !e.accel.is_empty() && !e.conflict && registered.contains(&e.accel);
        out.push(ShortcutView {
            tool_id: e.tool_id.clone(),
            tool_name,
            tool_running,
            shortcut_id: e.shortcut_id.clone(),
            name: e.name.clone(),
            accel: e.accel.clone(),
            default_accel: e.default_accel.clone(),
            conflict: e.conflict,
            registered: is_registered,
            action: e.action.clone(),
        });
    }
    Ok(out)
}

/// 修改某工具某动作的组合键：校验可解析 + 未被其它项占用，落库并重注册
#[tauri::command]
async fn set_shortcut_accel(
    app: AppHandle,
    tool_id: String,
    shortcut_id: String,
    accel: String,
) -> Result<ShortcutView, String> {
    let accel = normalize_accel(&accel);
    if accel.is_empty() {
        return Err("组合键不能为空".into());
    }
    parse_shortcut(&accel)?; // 只校验，不注册
    let settings_state = app.state::<SettingsState>();
    // 冲突检测：本注册表内其它项（不同 tool:shortcut）不得占用同一组合键
    {
        let registry = settings_state.registry.lock().unwrap();
        for e in registry.iter() {
            if e.tool_id == tool_id && e.shortcut_id == shortcut_id {
                continue;
            }
            if !e.accel.is_empty() && e.accel == accel {
                return Err(format!("该组合键已被其它动作占用：{}({})", e.tool_name, e.name));
            }
        }
    }
    // 注销该项旧的组合键（若不同）
    let old_accel = {
        let registry = settings_state.registry.lock().unwrap();
        registry
            .iter()
            .find(|e| e.tool_id == tool_id && e.shortcut_id == shortcut_id)
            .map(|e| e.accel.clone())
    };
    if let Some(old) = old_accel {
        if old != accel {
            if let Ok(old_sc) = parse_shortcut(&old) {
                let _ = app.global_shortcut().unregister(old_sc);
            }
        }
    }
    // 持久化 override
    let mut overrides = read_shortcut_overrides(&app);
    overrides.insert(format!("{tool_id}:{shortcut_id}"), accel.clone());
    persist_shortcut_overrides(&app, &overrides);
    // 重同步（注册新组合键）
    sync_shortcuts(&app).await;
    // 返回该项的最新视图
    let registry_after = settings_state.registry.lock().unwrap().clone();
    let registered_after = settings_state.registered.lock().unwrap().clone();
    let tool_running = {
        match sidecar::call(&app, "GET", &format!("/tools/{tool_id}"), None).await {
            Ok(v) => v.get("status").and_then(|x| x.as_str()) == Some("running"),
            Err(_) => false,
        }
    };
    let e = registry_after
        .iter()
        .find(|e| e.tool_id == tool_id && e.shortcut_id == shortcut_id)
        .ok_or_else(|| "未找到该快捷键".to_string())?;
    Ok(ShortcutView {
        tool_id: e.tool_id.clone(),
        tool_name: e.tool_name.clone(),
        tool_running,
        shortcut_id: e.shortcut_id.clone(),
        name: e.name.clone(),
        accel: e.accel.clone(),
        default_accel: e.default_accel.clone(),
        conflict: e.conflict,
        registered: !e.accel.is_empty() && !e.conflict && registered_after.contains(&e.accel),
        action: e.action.clone(),
    })
}

/// 恢复某动作的组合键为 manifest 默认
#[tauri::command]
async fn reset_shortcut_accel(
    app: AppHandle,
    tool_id: String,
    shortcut_id: String,
) -> Result<ShortcutView, String> {
    let mut overrides = read_shortcut_overrides(&app);
    overrides.remove(&format!("{tool_id}:{shortcut_id}"));
    persist_shortcut_overrides(&app, &overrides);
    sync_shortcuts(&app).await;
    let registry = app.state::<SettingsState>().registry.lock().unwrap().clone();
    let e = registry
        .iter()
        .find(|e| e.tool_id == tool_id && e.shortcut_id == shortcut_id)
        .ok_or_else(|| "未找到该快捷键".to_string())?;
    Ok(ShortcutView {
        tool_id: e.tool_id.clone(),
        tool_name: e.tool_name.clone(),
        tool_running: false,
        shortcut_id: e.shortcut_id.clone(),
        name: e.name.clone(),
        accel: e.accel.clone(),
        default_accel: e.default_accel.clone(),
        conflict: e.conflict,
        registered: !e.accel.is_empty() && !e.conflict,
        action: e.action.clone(),
    })
}

/// 通用建窗能力：把某工具 manifest 里声明的面板页显示为无边框置顶悬浮窗（由用户代码触发）
#[tauri::command]
async fn open_tool_panel(app: AppHandle, tool_id: String, panel_id: String) -> Result<(), String> {
    ensure_tool_panel(&app, &tool_id, &panel_id).await?;
    show_tool_panel(&app, &tool_id, &panel_id);
    Ok(())
}

/// 隐藏某工具的所有悬浮面板窗
#[tauri::command]
fn hide_tool_panel(app: AppHandle, tool_id: String) -> Result<(), String> {
    hide_tool_panel_all(&app, &tool_id);
    Ok(())
}

/// 读取开机自启状态
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// 设置开机自启
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let m = app.autolaunch();
    if enabled {
        m.enable().map_err(|e| e.to_string())?;
    } else {
        m.disable().map_err(|e| e.to_string())?;
    }
    Ok(enabled)
}

/// 兼容旧工具设置 UI：读取剪贴板历史第一个快捷键的组合键
#[tauri::command]
async fn get_clipboard_hotkey(app: AppHandle) -> Result<String, String> {
    let registry = app.state::<SettingsState>().registry.lock().unwrap().clone();
    let accel = registry
        .iter()
        .find(|e| e.tool_id == CLIPBOARD_TOOL_ID)
        .map(|e| e.accel.clone())
        .unwrap_or_else(|| {
            read_legacy_clipboard_hotkey(&app).unwrap_or_else(|| "ctrl+shift+v".to_string())
        });
    Ok(accel)
}

/// 兼容旧工具设置 UI：设置剪贴板历史第一个快捷键（忽略单个占用则报错）
#[tauri::command]
async fn set_clipboard_hotkey(app: AppHandle, accel: String) -> Result<String, String> {
    let sid = {
        let registry = app.state::<SettingsState>().registry.lock().unwrap().clone();
        registry
            .iter()
            .find(|e| e.tool_id == CLIPBOARD_TOOL_ID)
            .map(|e| e.shortcut_id.clone())
            .unwrap_or_else(|| "toggle-quick".to_string())
    };
    let view = set_shortcut_accel(
        app,
        CLIPBOARD_TOOL_ID.to_string(),
        sid,
        accel,
    )
    .await?;
    Ok(view.accel)
}

/// 把某工具 manifest 声明的面板页显示为无边框置顶悬浮窗；
/// 窗口按 <tool_id>-<panel_id> 唯一，已存在则复用（前端聚焦由调用方负责）。
async fn ensure_tool_panel(
    app: &AppHandle,
    tool_id: &str,
    panel_id: &str,
) -> Result<(), String> {
    // 1. 读取工具 manifest 里的 panels 元数据
    let v = sidecar::call(app, "GET", &format!("/tools/{tool_id}"), None).await?;
    let panels = v.get("panels").and_then(|x| x.as_array()).cloned().unwrap_or_default();
    let spec = panels.iter().find(|p| p.get("id").and_then(|x| x.as_str()) == Some(panel_id));
    let (page, title, width, height) = match spec {
        Some(p) => (
            p.get("page").and_then(|x| x.as_str()).unwrap_or("panel.html").to_string(),
            p.get("title").and_then(|x| x.as_str()).unwrap_or(tool_id).to_string(),
            p.get("width").and_then(|x| x.as_u64()).unwrap_or(380) as u32,
            p.get("height").and_then(|x| x.as_u64()).unwrap_or(560) as u32,
        ),
        None => (format!("{panel_id}.html"), tool_id.to_string(), 380, 560),
    };

    // 2. 确保工具运行并获得端口
    let port = if v.get("status").and_then(|x| x.as_str()) == Some("running") {
        v.get("port")
            .and_then(|x| x.as_u64())
            .map(|x| x as u16)
            .ok_or("工具运行状态缺少端口")?
    } else {
        let v2 = sidecar::call(app, "POST", &format!("/tools/{tool_id}/start"), None).await?;
        v2.get("port")
            .and_then(|x| x.as_u64())
            .map(|x| x as u16)
            .ok_or("工具启动失败")?
    };
    let url = format!("http://127.0.0.1:{port}/{page}");
    let label = format!("{PANEL_LABEL_PREFIX}{tool_id}-{panel_id}");

    // 3. 在主线程创建/复用面板窗口（不存在才创建）
    let app2 = app.clone();
    let label2 = label.clone();
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    let _ = app.run_on_main_thread(move || {
        let res = (|| -> Result<(), String> {
            if app2.get_webview_window(&label2).is_some() {
                return Ok(());
            }
            let u: tauri::Url = url.parse().map_err(|e| format!("URL 无效: {e}"))?;
            WebviewWindowBuilder::new(&app2, label2, WebviewUrl::External(u))
                .title(&title)
                .inner_size(width as f64, height as f64)
                .resizable(false)
                .always_on_top(true)
                .visible(false) // 先隐藏创建，避免闪窗
                .decorations(false)
                .shadow(true)
                .build()
                .map_err(|e| format!("创建面板窗口失败: {e}"))?;
            Ok(())
        })();
        let _ = tx.send(res);
    });
    rx.await.map_err(|_| "创建面板窗口失败（主线程未响应）".to_string())?
}

/// 显示并聚焦某个工具的面板窗
fn show_tool_panel(app: &AppHandle, tool_id: &str, panel_id: &str) {
    let label = format!("{PANEL_LABEL_PREFIX}{tool_id}-{panel_id}");
    if let Some(win) = app.get_webview_window(&label) {
        let _ = win.show();
        let _ = win.set_always_on_top(true);
        let _ = win.set_focus();
    }
}

/// 隐藏某工具的全部面板窗
fn hide_tool_panel_all(app: &AppHandle, tool_id: &str) {
    let prefix = format!("{PANEL_LABEL_PREFIX}{tool_id}-");
    for (_label, win) in app.webview_windows() {
        if win.label().starts_with(&prefix) {
            let _ = win.hide();
        }
    }
}

/// 轮询各工具目录的面板标记：.quick-open 请求弹面板，.quick-close 请求收起，
/// .quick-toggle 按窗口当前可见性开/关（最可靠，按一次开、再按一次必关）。
async fn poll_panel_flags(app: &AppHandle) {
    let Ok(dir) = sidecar::Sidecar::data_dir(app) else { return };
    let toolbox = dir.join("toolbox");
    let Ok(entries) = fs::read_dir(&toolbox) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
            continue;
        }
        let tool_id = entry.file_name().to_string_lossy().into_owned();

        // .quick-toggle：依据窗口当前可见性反转
        let toggle = entry.path().join(".quick-toggle");
        if fs::metadata(&toggle).is_ok() {
            let panel_id = read_panel_id_flag(&toggle);
            let _ = fs::remove_file(&toggle);
            let label = format!("{PANEL_LABEL_PREFIX}{tool_id}-{panel_id}");
            if let Some(win) = app.get_webview_window(&label) {
                if win.is_visible().unwrap_or(false) {
                    let _ = win.hide();
                } else {
                    let _ = win.show();
                    let _ = win.set_always_on_top(true);
                    let _ = win.set_focus();
                }
            } else if ensure_tool_panel(app, &tool_id, &panel_id).await.is_ok() {
                show_tool_panel(app, &tool_id, &panel_id);
            }
        }

        // .quick-open：显式请求弹面板
        let open = entry.path().join(".quick-open");
        if fs::metadata(&open).is_ok() {
            let panel_id = read_panel_id_flag(&open);
            let _ = fs::remove_file(&open);
            if ensure_tool_panel(app, &tool_id, &panel_id).await.is_ok() {
                show_tool_panel(app, &tool_id, &panel_id);
            }
        }

        // .quick-close：显式请求收起
        let close = entry.path().join(".quick-close");
        if fs::metadata(&close).is_ok() {
            let _ = fs::remove_file(&close);
            hide_tool_panel_all(app, &tool_id);
        }
    }
}

/// 读取面板标记 JSON 中的 panelId（缺省 "quick"）
fn read_panel_id_flag(path: &PathBuf) -> String {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<serde_json::Value>(&raw)
            .ok()
            .and_then(|v| v.get("panelId").and_then(|x| x.as_str()).map(|s| s.to_string()))
            .unwrap_or_else(|| "quick".to_string()),
        Err(_) => "quick".to_string(),
    }
}

// ------------------------------------------------------------------ 快捷键注册表

fn normalize_accel(s: &str) -> String {
    s.split('+')
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("+")
}

fn parse_shortcut(accel: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut key = String::new();
    for part in accel.split('+') {
        match part.trim().to_ascii_lowercase().as_str() {
            "ctrl" | "control" => mods |= Modifiers::CONTROL,
            "shift" => mods |= Modifiers::SHIFT,
            "alt" | "option" => mods |= Modifiers::ALT,
            "cmd" | "command" | "super" | "win" => mods |= Modifiers::SUPER,
            "" => {}
            other => key = other.to_string(),
        }
    }
    if key.is_empty() {
        return Err(format!("快捷键缺少主键：{accel}"));
    }
    let code = key_to_code(&key).ok_or_else(|| format!("暂不支持该主键 {key}"))?;
    Ok(Shortcut::new(Some(mods), code))
}

fn key_to_code(k: &str) -> Option<Code> {
    use Code::*;
    Some(match k {
        "a" => KeyA, "b" => KeyB, "c" => KeyC, "d" => KeyD, "e" => KeyE, "f" => KeyF,
        "g" => KeyG, "h" => KeyH, "i" => KeyI, "j" => KeyJ, "k" => KeyK, "l" => KeyL,
        "m" => KeyM, "n" => KeyN, "o" => KeyO, "p" => KeyP, "q" => KeyQ, "r" => KeyR,
        "s" => KeyS, "t" => KeyT, "u" => KeyU, "v" => KeyV, "w" => KeyW, "x" => KeyX,
        "y" => KeyY, "z" => KeyZ,
        "0" => Digit0, "1" => Digit1, "2" => Digit2, "3" => Digit3, "4" => Digit4,
        "5" => Digit5, "6" => Digit6, "7" => Digit7, "8" => Digit8, "9" => Digit9,
        "f1" => F1, "f2" => F2, "f3" => F3, "f4" => F4, "f5" => F5, "f6" => F6,
        "f7" => F7, "f8" => F8, "f9" => F9, "f10" => F10, "f11" => F11, "f12" => F12,
        "space" => Space, "enter" => Enter, "tab" => Tab,
        "esc" | "escape" => Escape, "backspace" => Backspace, "delete" => Delete,
        "home" => Home, "end" => End,
        "up" | "arrowup" => ArrowUp, "down" | "arrowdown" => ArrowDown,
        "left" | "arrowleft" => ArrowLeft, "right" | "arrowright" => ArrowRight,
        _ => return None,
    })
}

/// 快捷键按下后的统一派发：把事件经 host 转发给对应工具进程的 /__platform/shortcut。
async fn dispatch_shortcut(app: &AppHandle, entry: &ShortcutEntry) {
    let body = serde_json::json!({
        "shortcutId": entry.shortcut_id,
        "action": entry.action,
        "accel": entry.accel,
    });
    let _ = sidecar::call(
        app,
        "POST",
        &format!("/tools/{}/shortcut", entry.tool_id),
        Some(body),
    )
    .await;
}

/// 从宿主扫描所有工具，重建快捷键注册表并同步全局注册（含冲突检测）。
async fn sync_shortcuts(app: &AppHandle) {
    let tools = sidecar::call(app, "GET", "/tools", None).await.unwrap_or(serde_json::Value::Null);
    let tools_arr = tools.as_array().cloned().unwrap_or_default();

    let overrides = read_shortcut_overrides(app);
    let mut new_reg: Vec<ShortcutEntry> = Vec::new();
    for t in &tools_arr {
        let Some(tool_id) = t.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()) else {
            continue;
        };
        if t.get("error").is_some() {
            continue;
        }
        let tool_name = t
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or(&tool_id)
            .to_string();
        let Some(shortcuts) = t.get("shortcuts").and_then(|x| x.as_array()) else {
            continue;
        };
        for sc in shortcuts {
            let Some(sid) = sc.get("id").and_then(|x| x.as_str()).map(|s| s.to_string()) else {
                continue;
            };
            let name = sc.get("name").and_then(|x| x.as_str()).unwrap_or(&sid).to_string();
            let default_accel = sc.get("accel").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let action = sc.get("action").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let key = format!("{tool_id}:{sid}");
            let accel = overrides.get(&key).cloned().unwrap_or(default_accel.clone());
            new_reg.push(ShortcutEntry {
                tool_id: tool_id.clone(),
                tool_name: tool_name.clone(),
                shortcut_id: sid,
                name,
                accel,
                default_accel,
                action,
                conflict: false,
            });
        }
    }

    // 冲突检测：同一组合键被多条声明占用 → 全部标记冲突（不注册）
    let mut conflicted: Vec<usize> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    for (i, e) in new_reg.iter().enumerate() {
        if e.accel.is_empty() {
            continue;
        }
        match seen.get(&e.accel) {
            Some(&j) => {
                conflicted.push(i);
                if !conflicted.contains(&j) {
                    conflicted.push(j);
                }
            }
            None => {
                seen.insert(e.accel.clone(), i);
            }
        }
    }
    for idx in conflicted {
        new_reg[idx].conflict = true;
    }

    let valid_accels: HashSet<String> = new_reg
        .iter()
        .filter(|e| !e.accel.is_empty() && !e.conflict)
        .map(|e| e.accel.clone())
        .collect();

    let settings_state = app.state::<SettingsState>();
    {
        let mut registered = settings_state.registered.lock().unwrap();
        let prev: HashSet<String> = registered.clone();
        // 注销：之前已注册但不再有效（被移除 / 冲突 / 组合键变了）的项
        for accel in prev.iter() {
            if !valid_accels.contains(accel) {
                if let Ok(old_sc) = parse_shortcut(accel) {
                    let _ = app.global_shortcut().unregister(old_sc);
                }
            }
        }
        // 注册：新增 / 变化且无冲突的项（保持不变的不重注册，避免 3s 高频抖动）
        registered.clear();
        for accel in &valid_accels {
            if prev.contains(accel) {
                registered.insert(accel.clone());
                continue;
            }
            let Some(entry) = new_reg.iter().find(|e| e.accel == *accel && !e.conflict) else {
                continue;
            };
            let Ok(shortcut) = parse_shortcut(accel) else { continue };
            let entry = entry.clone();
            let ok = app
                .global_shortcut()
                .on_shortcut(shortcut, move |app, _sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        let app = app.clone();
                        let entry = entry.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = dispatch_shortcut(&app, &entry).await;
                        });
                    }
                })
                .is_ok();
            if ok {
                registered.insert(accel.clone());
            }
        }
    }

    *settings_state.registry.lock().unwrap() = new_reg;
}

fn settings_file(app: &AppHandle) -> PathBuf {
    match sidecar::Sidecar::data_dir(app) {
        Ok(d) => d.join("settings.json"),
        Err(_) => PathBuf::new(),
    }
}

fn read_settings_json(app: &AppHandle) -> serde_json::Value {
    let p = settings_file(app);
    if p.as_os_str().is_empty() {
        return serde_json::Value::Null;
    }
    fs::read_to_string(p)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// 读取快捷键 override：{ "toolId:shortcutId": "ctrl+shift+v" }
fn read_shortcut_overrides(app: &AppHandle) -> HashMap<String, String> {
    let mut out = HashMap::new();
    if let Some(obj) = read_settings_json(app)
        .get("shortcutOverrides")
        .and_then(|x| x.as_object())
    {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                out.insert(k.clone(), s.to_string());
            }
        }
    }
    out
}

/// 写回快捷键 override，同时保留 settings.json 里其它字段（含旧 clipboardHotkey）
fn persist_shortcut_overrides(app: &AppHandle, map: &HashMap<String, String>) {
    let p = settings_file(app);
    if p.as_os_str().is_empty() {
        return;
    }
    if let Some(dir) = p.parent() {
        let _ = fs::create_dir_all(dir);
    }
    let mut v = read_settings_json(app);
    if !v.is_object() {
        v = serde_json::json!({});
    }
    let obj = v.as_object_mut().unwrap();
    obj.insert(
        "shortcutOverrides".into(),
        serde_json::to_value(map).unwrap_or(serde_json::json!({})),
    );
    let _ = fs::write(p, serde_json::to_string_pretty(&v).unwrap());
}

/// 旧版单快捷设置兼容：读取 settings.json 里的 clipboardHotkey
fn read_legacy_clipboard_hotkey(app: &AppHandle) -> Option<String> {
    read_settings_json(app)
        .get("clipboardHotkey")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
}

// ------------------------------------------------------------------ 退出清理

/// 应用退出前，优雅关闭宿主：先通知宿主清理工具进程树，再兜底终止宿主进程。
fn shutdown_host(app: &tauri::AppHandle) {
    let state = app.state::<sidecar::Sidecar>();
    // 取值后释放锁，避免临时 MutexGuard 借用问题
    let port_opt = {
        let guard = state.host_port.lock().unwrap();
        *guard
    };
    if let Some(port) = port_opt {
        // 阻塞式发送一个简单的 HTTP POST /shutdown（宿主随即清理工具并退出）
        if let Ok(mut s) = TcpStream::connect(("127.0.0.1", port)) {
            let _ = s.write_all(
                b"POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            );
        }
    }
    // 兜底：若宿主仍未退出，按 pid 终止（含其子进程树）
    let pid_opt = {
        let guard = state.host_pid.lock().unwrap();
        *guard
    };
    if let Some(pid) = pid_opt {
        let pid_str = pid.to_string();
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid_str, "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW，避免弹黑框
        }
        let _ = cmd.output();
    }
}