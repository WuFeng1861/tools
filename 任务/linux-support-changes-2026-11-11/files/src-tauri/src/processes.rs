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
        collect_linux_tree(pid, &mut tree);
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

#[cfg(target_os = "linux")]
fn collect_linux_tree(pid: u32, tree: &mut Vec<u32>) {
    if pid <= 1 || pid == std::process::id() || tree.contains(&pid) {
        return;
    }
    tree.push(pid);
    // children 按线程记录；扫描所有线程，兼容由非主线程创建的子进程。
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(children) = std::fs::read_to_string(task.path().join("children")) {
                for child in children.split_whitespace().filter_map(|s| s.parse().ok()) {
                    collect_linux_tree(child, tree);
                }
            }
        }
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
