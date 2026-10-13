//! 工具宿主（node.exe + host.js）的生命周期管理。
//!
//! node.exe 作为普通 resource 打包，用 std::process::Command 启动宿主进程，
//! 通过宿主 HTTP 端口通信；以 HTTP /health 探测存活，调用失败时自动重启自愈。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// 平台运行时状态（宿主进程相关）
#[derive(Default)]
pub struct Sidecar {
    pub host_port: Mutex<Option<u16>>,
    pub host_pid: Mutex<Option<u32>>,
    /// 单飞锁：保证并发调用只会有一个真正去启动宿主，其余等它起来后复用端口。
    /// 没有它时，启动瞬间并发的前端命令会各自 spawn 一个宿主进程。
    start_lock: tokio::sync::Mutex<()>,
}

impl Sidecar {
    /// 确保宿主进程在运行（用 HTTP /health 探测），返回其 HTTP 端口
    pub async fn ensure(&self, app: &AppHandle) -> Result<u16, String> {
        if let Some(port) = self.live_port().await {
            return Ok(port);
        }
        // 单飞：拿到锁后必须再查一次 —— 先到的调用可能已经把宿主起好了
        let _guard = self.start_lock.lock().await;
        if let Some(port) = self.live_port().await {
            return Ok(port);
        }
        self.start(app).await
    }

    /// 已登记端口若仍能响应 /health 就返回它，否则视为不可用
    async fn live_port(&self) -> Option<u16> {
        let port = { *self.host_port.lock().unwrap() }?;
        if host_alive(port).await {
            Some(port)
        } else {
            None
        }
    }

    /// 强制重启宿主（先清理旧进程，再启动新的）
    pub async fn restart(&self, app: &AppHandle) -> Result<u16, String> {
        // 同样走单飞：并发自愈时，只有一个真的去重启，其余复用结果。
        // 否则一次失联会被多个调用放大成连开好几个宿主。
        let _guard = self.start_lock.lock().await;
        if let Some(port) = self.live_port().await {
            return Ok(port); // 已被别的调用抢修好了，不要再杀一遍健康的宿主
        }
        let pid = { self.host_pid.lock().unwrap().map(|v| v) };
        if let Some(pid) = pid {
            kill_pid(pid);
        }
        self.start(app).await
    }

    pub fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
        app.path()
            .app_data_dir()
            .map_err(|e| format!("获取数据目录失败: {e}"))
    }

    fn state_file(app: &AppHandle) -> Result<PathBuf, String> {
        Ok(Self::data_dir(app)?.join("host-state.json"))
    }

    async fn start(&self, app: &AppHandle) -> Result<u16, String> {
        *self.host_port.lock().unwrap() = None;
        *self.host_pid.lock().unwrap() = None;

        let data_dir = Self::data_dir(app)?;
        fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

        // 关键：先删掉上一次运行留下的握手文件。
        // 否则 spawn 之后的第一次轮询就会读到陈旧的 hostPort/pid 并判定「启动成功」，
        // 而真正新起的宿主无人回收 —— 多宿主抢同一批工具端口、界面报「端口被占用」
        // 正是这么来的。
        let state_file = Self::state_file(app)?;
        let _ = fs::remove_file(&state_file);

        let resource_dir = app
            .path()
            .resource_dir()
            .map_err(|e| format!("获取资源目录失败: {e}"))?;
        let node = clean_path(&resource_dir.join("resources").join("bin").join("node.exe"));
        let host_js = clean_path(&resource_dir.join("resources").join("host").join("host.js"));
        let runtime_dir = clean_path(&resource_dir.join("resources").join("runtime"));
        let templates_dir = clean_path(&resource_dir.join("resources").join("templates"));
        let npm_cli = clean_path(
            &resource_dir
                .join("resources")
                .join("npm")
                .join("bin")
                .join("npm-cli.js"),
        );
        if !node.exists() || !host_js.exists() {
            return Err(format!(
                "运行时资源缺失（node.exe={} host.js={}）\n请先执行 node scripts/fetch-node.mjs 准备资源",
                node.exists(),
                host_js.exists(),
            ));
        }

        let instance_id = format!("{}-{}", std::process::id(), now_millis());
        let mut cmd = std::process::Command::new(&node);
        cmd.args([
            host_js.to_string_lossy().into_owned(),
            "--data-dir".into(),
            clean_path(&data_dir).to_string_lossy().into_owned(),
            "--runtime".into(),
            runtime_dir.to_string_lossy().into_owned(),
            "--templates".into(),
            templates_dir.to_string_lossy().into_owned(),
            "--npm-cli".into(),
            npm_cli.to_string_lossy().into_owned(),
            "--instance-id".into(),
            instance_id,
        ]);
        // Windows 下隐藏控制台窗口（CREATE_NO_WINDOW）
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let spawned = cmd.spawn().map_err(|e| format!("启动宿主失败: {e}"))?;
        let spawned_pid = spawned.id();
        *self.host_pid.lock().unwrap() = Some(spawned_pid);

        // 等待宿主写出 host-state.json（含随机端口与 pid）。
        // 注意宿主可能「让位」：发现已有宿主在跑时，它会把对方真实的 pid/port 写进
        // 这个文件再自行退出，因此读到的 pid 未必是本次 spawn 的进程。
        let deadline = Instant::now() + Duration::from_secs(15);
        while Instant::now() < deadline {
            if let Ok(raw) = fs::read_to_string(&state_file) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                    if let Some(p) = v["hostPort"].as_u64() {
                        let port = p as u16;
                        if host_alive(port).await {
                            *self.host_port.lock().unwrap() = Some(port);
                            let pid = v["pid"]
                                .as_u64()
                                .map(|x| x as u32)
                                .unwrap_or(spawned_pid);
                            *self.host_pid.lock().unwrap() = Some(pid);
                            return Ok(port);
                        }
                        // 文件已写出但端口尚不通（宿主正在让位或还在启动）→ 继续等
                    }
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
        // 超时：把本次 spawn 出来的进程收掉，免得留下无人回收的孤儿
        kill_pid(spawned_pid);
        Err("宿主启动超时（未读到有效的 host-state.json）".into())
    }
}

/// 当前毫秒时间戳（生成启动标识用，避免为此引入日期库依赖）
fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// 去除 Windows verbatim 路径前缀 `\\?\`（Node.js 不支持该前缀）
fn clean_path(p: &Path) -> PathBuf {
    let s = p.to_string_lossy();
    let s = s.strip_prefix(r"\\?\").unwrap_or(&s);
    PathBuf::from(s)
}

/// 用 HTTP /health 探测宿主是否真正可用（TCP 可达不代表能响应）
async fn host_alive(port: u16) -> bool {
    reqwest::Client::new()
        .get(format!("http://127.0.0.1:{port}/health"))
        .timeout(Duration::from_secs(2))
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Windows 下终止进程（含子进程树），忽略错误
fn kill_pid(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW，避免弹黑框
        let _ = cmd.output();
    }
    let _ = pid;
}

/// 对宿主端口发一次 HTTP 请求（不管理宿主生命周期）
async fn http_call(
    port: u16,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let url = format!("http://127.0.0.1:{port}{path}");
    let client = reqwest::Client::new();
    let resp = match method {
        "GET" => client.get(&url).send().await,
        "POST" => {
            let b = body.unwrap_or(serde_json::Value::Null);
            client.post(&url).json(&b).send().await
        }
        _ => return Err(format!("不支持的方法 {method}")),
    }
    .map_err(|e| format!("调用宿主失败: {e}"))?;

    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("宿主响应解析失败: {e}"))?;
    if v.get("ok").and_then(|o| o.as_bool()) == Some(false) {
        return Err(v
            .get("error")
            .and_then(|e| e.as_str())
            .unwrap_or("宿主返回错误")
            .to_string());
    }
    Ok(v.get("data").cloned().unwrap_or(serde_json::Value::Null))
}

/// 统一的宿主 HTTP 调用入口：连接失败时重启宿主并重试一次（自愈）
pub async fn call(
    app: &AppHandle,
    method: &str,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let state = app.state::<Sidecar>();
    let port = state.ensure(app).await?;
    match http_call(port, method, path, body.clone()).await {
        Ok(v) => Ok(v),
        Err(e) if e.starts_with("调用宿主失败") => {
            // 宿主可能失联或损坏 → 重启后重试一次（不中断其它工具运行）
            let port2 = state.restart(app).await?;
            http_call(port2, method, path, body).await
        }
        Err(e) => Err(e),
    }
}
