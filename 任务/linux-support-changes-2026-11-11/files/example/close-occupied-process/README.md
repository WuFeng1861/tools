# 关闭占用端口或进程

支持 Windows 和 Linux，零 npm 依赖。把整个目录复制到平台工具目录后刷新即可，
`linux-processes.js` 需要与 `app.js` 一起复制。

- Windows 保留 `netstat -ano` 查询、`tasklist` 名称查询和 `taskkill /F /T` 终止流程。
- Linux 读取 `/proc/net/tcp`、`tcp6`、`udp`、`udp6`，通过 socket inode 查找占用进程；
  不需要额外安装 net-tools、ss 或 lsof。
- 输入端口只结束 TCP 监听或 UDP 绑定进程；仅有 TIME_WAIT 等连接时会说明当前状态。
- Linux 按 PID 的父子关系终止目标进程树，复核启动时间以避免误杀被复用的 PID，
  并保护 PID 1、工具自身及其宿主。只能操作当前用户有权限的进程。
- 如果 `/proc` 访问受限，工具会说明无法识别占用进程，不会误报端口空闲。

Linux 默认工具目录为 `~/.local/share/com.tools.platform/toolbox/`；也可以直接在平台中点
「新建 → 打开工具目录」。此工具只处理当前网络命名空间中可见的端口。

运行 `npm run test:tools` 可检查跨平台适配；Linux 下还会执行专用测试进程的真实端口查询和进程树清理。
