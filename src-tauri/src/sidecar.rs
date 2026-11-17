//! 工具宿主（Node.js + host.js）的生命周期管理。
//!
//! Windows 使用内置 node.exe，Linux 使用系统 Node；用 std::process::Command 启动宿主进程，
//! 通过宿主 HTTP 端口通信；以 HTTP /health 探测存活，调用失败时自动重启自愈。

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::processes::kill_tree as kill_pid;
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
        let node = node_executable(&resource_dir)?;
        let host_js = clean_path(&resource_dir.join("resources").join("host").join("host.js"));
        let runtime_dir = clean_path(&resource_dir.join("resources").join("runtime"));
        let templates_dir = clean_path(&resource_dir.join("resources").join("templates"));
        #[cfg(not(target_os = "linux"))]
        let npm_cli = clean_path(
            &resource_dir
                .join("resources")
                .join("npm")
                .join("bin")
                .join("npm-cli.js"),
        );
        if !node.exists() || !host_js.exists() {
            return Err(format!(
                "运行时资源缺失（Node.js={} host.js={}）\n请检查安装资源；Windows 可先执行 node scripts/fetch-node.mjs 准备资源",
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
            "--instance-id".into(),
            instance_id,
        ]);
        // Linux 使用系统 npm；Windows 仍使用内置 npm-cli.js，无需用户安装 Node/npm。
        #[cfg(not(target_os = "linux"))]
        cmd.args(["--npm-cli".into(), npm_cli.to_string_lossy().into_owned()]);
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
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

/// Windows 保持内置 Node；Linux 解析系统 Node 的绝对路径。
///
/// Linux 从图形启动器拉起时 PATH 往往很短（多数桌面只有 /usr/local/bin:/usr/bin:/bin），
/// nvm 之类装在用户目录下的 Node 就找不到。所以依次尝试：
/// TOOL_PLATFORM_NODE → PATH 上的 node → 常见安装路径 → nvm 的版本目录（新版本优先）。
fn node_executable(resource_dir: &Path) -> Result<PathBuf, String> {
    #[cfg(not(target_os = "linux"))]
    {
        Ok(clean_path(&resource_dir.join("resources").join("bin").join("node.exe")))
    }
    #[cfg(target_os = "linux")]
    {
        let _ = resource_dir;
        let mut errors = Vec::new();
        for candidate in node_candidates() {
            match probe_node(&candidate) {
                Ok(path) => return Ok(path),
                Err(e) => errors.push(format!("{}：{e}", candidate.display())),
            }
        }
        Err(format!(
            "未找到可用的系统 Node.js（需要 18 或更新版本）。尝试过：\n{}\n\
             请安装 Node.js，或设置 TOOL_PLATFORM_NODE 为 node 的绝对路径后重启平台。",
            errors.join("\n")
        ))
    }
}

/// Linux 上按优先级列出 Node 候选。
#[cfg(target_os = "linux")]
fn node_candidates() -> Vec<PathBuf> {
    // 显式指定时只用它：用户既然指明了位置，静默回退到别的 Node 反而更难排查。
    if let Some(explicit) = std::env::var_os("TOOL_PLATFORM_NODE") {
        return vec![PathBuf::from(explicit)];
    }
    let mut list = vec![PathBuf::from("node")];
    for path in ["/usr/local/bin/node", "/usr/bin/node", "/opt/node/bin/node"] {
        list.push(PathBuf::from(path));
    }
    // nvm 把版本装在 $HOME/.nvm/versions/node/<版本>/bin/node；按名字倒序让新版本先试，
    // 版本号不满足要求的会被 probe_node 跳过，所以顺序只影响「多个可用版本选谁」。
    if let Some(home) = std::env::var_os("HOME") {
        let versions = Path::new(&home).join(".nvm").join("versions").join("node");
        if let Ok(entries) = std::fs::read_dir(&versions) {
            let mut dirs: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
            dirs.sort();
            list.extend(dirs.into_iter().rev().map(|dir| dir.join("bin").join("node")));
        }
    }
    list
}

/// 让候选 Node 自报真实路径与版本，顺便验证它能跑且版本够新。
#[cfg(target_os = "linux")]
fn probe_node(candidate: &Path) -> Result<PathBuf, String> {
    let output = std::process::Command::new(candidate)
        .args(["-p", "process.execPath + '\\n' + process.versions.node"])
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err("执行失败".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let path = PathBuf::from(text.lines().next().unwrap_or("").trim());
    let version = text.lines().nth(1).unwrap_or("").trim().to_string();
    if !path.is_absolute() || !path.is_file() {
        return Err("返回的 Node 路径无效".into());
    }
    let major = version
        .split('.')
        .next()
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(0);
    if major < 18 {
        return Err(format!("版本过低（{version}，需要 18 及以上）"));
    }
    Ok(path)
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
