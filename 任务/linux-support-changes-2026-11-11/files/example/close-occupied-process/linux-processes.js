"use strict";

const fs = require("fs/promises");
const path = require("path");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// /proc 不依赖发行版是否安装了 net-tools、ss 或 lsof。
function createLinuxProcesses({ procRoot = "/proc", io = fs, signal = process.kill.bind(process), selfPid = process.pid } = {}) {
  async function record(pid) {
    try {
      const stat = await io.readFile(path.join(procRoot, String(pid), "stat"), "utf8");
      const end = stat.lastIndexOf(")");
      const fields = stat.slice(end + 2).trim().split(/\s+/);
      return { pid, name: stat.slice(stat.indexOf("(") + 1, end), state: fields[0], ppid: Number(fields[1]), start: fields[19] };
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ESRCH") return null;
      throw new Error(`无法读取 PID ${pid} 的信息：${e.code === "EACCES" ? "权限不足" : e.message}`);
    }
  }
  async function ids() {
    return (await io.readdir(procRoot)).filter((s) => /^\d+$/.test(s)).map(Number);
  }
  async function getProcessName(pid) {
    const item = await record(pid);
    return item && !/[ZX]/.test(item.state) ? item.name : null;
  }
  async function getProcessNameMap() {
    const names = new Map();
    for (const pid of await ids()) {
      try { const name = await getProcessName(pid); if (name) names.set(pid, name); } catch { /* 其他用户的进程可能不可读 */ }
    }
    return names;
  }
  async function findPidsByPort(port) {
    const sockets = [];
    for (const type of ["tcp", "tcp6", "udp", "udp6"]) {
      let table;
      try { table = await io.readFile(path.join(procRoot, "net", type), "utf8"); }
      catch (e) {
        if (e.code === "ENOENT" && type.endsWith("6")) continue;
        throw new Error(`无法读取 Linux 端口表 ${type}：${e.message}`);
      }
      for (const line of table.trim().split(/\n/).slice(1)) {
        const cols = line.trim().split(/\s+/);
        if (parseInt((cols[1] || "").split(":").pop(), 16) !== port) continue;
        const proto = type.startsWith("tcp") ? "TCP" : "UDP";
        const state = proto === "UDP" ? "UDP" : cols[3] === "0A" ? "LISTENING" : `TCP_${cols[3]}`;
        sockets.push({ inode: cols[9], proto, state });
      }
    }
    const found = [];
    const owned = new Set();
    for (const pid of sockets.length ? await ids() : []) {
      let fds;
      try { fds = await io.readdir(path.join(procRoot, String(pid), "fd")); } catch { continue; }
      for (const fd of fds) {
        let link;
        try { link = await io.readlink(path.join(procRoot, String(pid), "fd", fd)); } catch { continue; }
        const match = /^socket:\[(\d+)\]$/.exec(link);
        if (!match) continue;
        for (const socket of sockets.filter((s) => s.inode === match[1])) {
          owned.add(socket.inode);
          found.push({ pid, proto: socket.proto, state: socket.state });
        }
      }
    }
    if (sockets.some((s) => (s.proto === "UDP" || s.state === "LISTENING") && !owned.has(s.inode))) {
      throw new Error(`端口 ${port} 已被占用，但无法读取占用进程。请检查 /proc 的访问权限或用有权限的系统终端处理。`);
    }
    // TIME_WAIT 等状态没有存活进程，仍返回状态以免被误报为端口空闲。
    for (const socket of sockets.filter((s) => !owned.has(s.inode))) found.push({ pid: 0, proto: socket.proto, state: socket.state });
    return found;
  }
  async function killProcess(pid, name) {
    const protectedPids = new Set([0, 1]);
    let ancestor = selfPid;
    while (ancestor && !protectedPids.has(ancestor)) {
      protectedPids.add(ancestor);
      ancestor = (await record(ancestor))?.ppid;
    }
    if (protectedPids.has(pid)) throw new Error("不能终止 PID 1、工具自身或其宿主进程，请在系统终端中处理。");
    const root = await record(pid);
    if (!root || /[ZX]/.test(root.state)) throw new Error(`进程 PID ${pid} 不存在或已退出`);
    // 对 PID 和启动时间同时复核，避免扫描期间 PID 被其他进程复用。
    const records = [root];
    for (const candidate of await ids()) {
      if (candidate === pid) continue;
      try { const item = await record(candidate); if (item) records.push(item); } catch { /* 不可读的进程不能推断为目标 */ }
    }
    const tree = [];
    const visit = (item) => {
      if (tree.some((p) => p.pid === item.pid)) return;
      tree.push(item);
      for (const child of records.filter((p) => p.ppid === item.pid)) visit(child);
    };
    visit(root);
    if (tree.some((item) => protectedPids.has(item.pid))) throw new Error("目标进程树包含工具或宿主，已停止操作。");
    try {
      // 在终止子进程前先确认对主进程有权限。
      signal(pid, 0);
      for (const item of tree.reverse()) {
        const current = await record(item.pid);
        if (!current || current.start !== item.start || /[ZX]/.test(current.state)) continue;
        if (protectedPids.has(item.pid)) throw new Error("目标进程树包含工具或宿主，已停止操作。");
        try { signal(item.pid, "SIGKILL"); } catch (e) { if (e.code !== "ESRCH") throw e; }
      }
    } catch (e) {
      if (e.code === "EPERM" || e.code === "EACCES") throw new Error(`无权限终止 ${name}（PID ${pid}），请用有权限的系统终端处理。`);
      if (e.code !== "ESRCH") throw e;
    }
    for (let attempt = 0; attempt < 40; attempt++) {
      const current = await record(pid);
      if (!current || current.start !== root.start || /[ZX]/.test(current.state)) return { pid, name };
      await wait(50);
    }
    throw new Error(`进程 ${name}（PID ${pid}）仍在退出中，请稍后重试。`);
  }
  return { findPidsByPort, getProcessName, getProcessNameMap, killProcess };
}

module.exports = { createLinuxProcesses };
