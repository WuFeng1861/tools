//! 平台进程清理。Windows 保持 taskkill /T /F；Linux 清理进程组和子进程。

pub fn kill_tree(pid: u32) {
    if pid <= 1 || pid == std::process::id() {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"]);
        cmd.creation_flags(0x0800_0000);
        let _ = cmd.output();
    }
    #[cfg(target_os = "linux")]
    {
        // 工具各自有独立进程组，所以只杀宿主的进程组会漏掉它们。
        // 先从 /proc 快照整棵树，再从叶子开始清理，避免父进程退出后子进程被重新收养。
        let mut tree = Vec::new();
        if !collect_linux_tree(pid, &mut tree) {
            // children 不可用时前面的结果可能残缺，整棵树改用 ppid 全量扫描重建。
            tree = linux_tree_by_ppid(pid);
        }
        for child in tree.into_iter().rev() {
            if let Ok(child) = i32::try_from(child) {
                unsafe {
                    // 仅在该进程确实是组长时发送组信号，绝不影响平台自己的进程组。
                    if libc::getpgid(child) == child {
                        libc::kill(-child, libc::SIGKILL);
                    }
                    libc::kill(child, libc::SIGKILL);
                }
            }
        }
    }
}

/// 收集 pid 的子孙进程（父在前）。
///
/// 返回值表示 `/proc/<pid>/task/*/children` 是否可用：该文件依赖内核
/// `CONFIG_PROC_CHILDREN`，且受 hidepid 等限制；拿不到时返回 false，
/// 调用方会退回按 ppid 全量扫描 —— 否则独立进程组里的工具会变成孤儿继续占端口。
#[cfg(target_os = "linux")]
fn collect_linux_tree(pid: u32, tree: &mut Vec<u32>) -> bool {
    if pid <= 1 || pid == std::process::id() || tree.contains(&pid) {
        return true;
    }
    tree.push(pid);
    let mut children = Vec::new();
    let mut readable = false;
    // children 按线程记录；扫描所有线程，兼容由非主线程创建的子进程。
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(raw) = std::fs::read_to_string(task.path().join("children")) {
                readable = true;
                for child in raw.split_whitespace().filter_map(|s| s.parse().ok()) {
                    children.push(child);
                }
            }
        }
    }
    for child in children {
        readable &= collect_linux_tree(child, tree);
    }
    readable
}

/// 兜底：全量扫描一次 `/proc`，按 ppid 建树（父在前）。
#[cfg(target_os = "linux")]
fn linux_tree_by_ppid(pid: u32) -> Vec<u32> {
    let mut parents: Vec<(u32, u32)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str().map(str::to_owned) {
                Some(name) => name,
                None => continue,
            };
            let child = match name.parse::<u32>() {
                Ok(child) => child,
                Err(_) => continue,
            };
            if let Ok(stat) = std::fs::read_to_string(format!("/proc/{child}/stat")) {
                if let Some(parent) = parse_ppid(&stat) {
                    parents.push((parent, child));
                }
            }
        }
    }
    tree_from_parents(pid, &parents, std::process::id())
}

/// 从 `/proc/<pid>/stat` 的文本里取 ppid。
///
/// comm 字段可能含空格和括号（如 `(a) b)`），所以字段要从未尾那个 `)` 之后开始切：
/// 之后依次是 state、ppid。字段不全时返回 None 而不是 panic —— 这段代码跑在退出
/// 清理路径上，一旦 panic 就等于放弃清理。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_ppid(stat: &str) -> Option<u32> {
    let close = stat.rfind(')')?;
    let rest = stat.get(close + 1..)?;
    rest.split_whitespace().nth(1)?.parse().ok()
}

/// 按「父在前」的顺序展开以 `root` 为根的子树。
///
/// `parents` 是 (ppid, pid) 列表；`self_pid` 与 PID ≤ 1 一律排除，避免把平台自己
/// 或 init 算进清理目标。与平台无关，便于在任何系统上单测。
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn tree_from_parents(root: u32, parents: &[(u32, u32)], self_pid: u32) -> Vec<u32> {
    let mut tree = Vec::new();
    let mut queue = vec![root];
    while let Some(current) = queue.pop() {
        if current <= 1 || current == self_pid || tree.contains(&current) {
            continue;
        }
        tree.push(current);
        for (parent, child) in parents {
            if *parent == current {
                queue.push(*child);
            }
        }
    }
    tree
}

#[cfg(test)]
mod tree_rules {
    use super::*;

    #[test]
    fn 解析_stat_的_ppid_能跳过带括号和空格的进程名() {
        assert_eq!(parse_ppid("1234 (node) S 1 1234 1234 0 -1 4194560"), Some(1));
        assert_eq!(parse_ppid("7 (a) b) S 42 7 7 0 -1"), Some(42));
        // 字段不全 / 内容异常时返回 None，不能 panic
        assert_eq!(parse_ppid("8 (x)"), None);
        assert_eq!(parse_ppid("8 ("), None);
        assert_eq!(parse_ppid("garbage"), None);
        assert_eq!(parse_ppid(""), None);
    }

    #[test]
    fn 按_ppid_建树只包含目标子树且父在前() {
        let parents = [(1, 10), (10, 11), (11, 12), (1, 20), (20, 21)];
        assert_eq!(tree_from_parents(10, &parents, 999), vec![10, 11, 12]);
        // 兄弟分支不能混进来
        assert!(!tree_from_parents(10, &parents, 999).contains(&20));
        // 自身与 init 永不进清理名单
        assert_eq!(tree_from_parents(20, &parents, 20), Vec::<u32>::new());
        assert_eq!(tree_from_parents(1, &parents, 999), Vec::<u32>::new());
        // 异常数据形成环时不能死循环
        assert_eq!(tree_from_parents(30, &[(30, 31), (31, 30)], 1), vec![30, 31]);
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    #[test]
    fn kills_host_and_tool_in_separate_process_groups() {
        let mut host = Command::new("node")
            .args([
                "-e",
                r#"
                const child = require('child_process').spawn(process.execPath,
                  ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
                console.log(child.pid);
                setInterval(() => {}, 1000);
            "#,
            ])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .expect("Linux 测试需要系统 Node.js");
        let mut line = String::new();
        BufReader::new(host.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let child: u32 = line.trim().parse().unwrap();
        kill_tree(host.id());
        host.wait().unwrap();
        // 被 init 收养的子进程可能短暂处于 zombie 状态，已不能执行或占端口。
        for _ in 0..100 {
            match std::fs::read_to_string(format!("/proc/{child}/stat")) {
                Err(_) => return,
                Ok(stat)
                    if stat
                        .rsplit_once(')')
                        .unwrap()
                        .1
                        .trim_start()
                        .starts_with('Z') =>
                {
                    return
                }
                _ => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
        unsafe {
            libc::kill(child as i32, libc::SIGKILL);
        }
        panic!("独立进程组中的工具没有被清理");
    }
}
