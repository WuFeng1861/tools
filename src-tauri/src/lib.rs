mod commands;
mod models;
mod sidecar;

use std::io::Write;
use std::net::TcpStream;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(sidecar::Sidecar::default())
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
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                shutdown_host(app);
            }
        });
}

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
        let _ = std::process::Command::new("taskkill")
            .args(["/pid", &pid_str, "/T", "/F"])
            .output();
    }
}
