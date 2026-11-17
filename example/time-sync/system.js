"use strict";

const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const run = promisify(execFile);

const shellQuote = value => `'${value.replace(/'/g, "'\\''")}'`;
async function executable(candidates) {
  for (const file of candidates) {
    try { await fs.access(file, constants.X_OK); return file; } catch { /* Try the next standard path. */ }
  }
  return null;
}
async function read(file) { try { return await fs.readFile(file, "utf8"); } catch { return ""; } }

async function inspectLinux() {
  const [version, cgroup, status, distribution, docker, podman, datePath, sudoPath, pkexecPath] = await Promise.all([
    read("/proc/version"), read("/proc/1/cgroup"), read("/proc/self/status"), read("/etc/os-release"),
    fs.access("/.dockerenv").then(() => true, () => false), fs.access("/run/.containerenv").then(() => true, () => false),
    executable(["/usr/bin/date", "/bin/date"]), executable(["/usr/bin/sudo", "/bin/sudo"]), executable(["/usr/bin/pkexec", "/bin/pkexec"]),
  ]);
  const root = process.getuid?.() === 0;
  const wsl = /microsoft|wsl/i.test(`${version} ${os.release()}`) || Boolean(process.env.WSL_INTEROP);
  const container = docker || podman || /docker|kubepods|containerd|lxc|podman/i.test(cgroup);
  const capMatch = status.match(/^CapEff:\s*([0-9a-f]+)$/im);
  const hasTimeCapability = capMatch ? Boolean(BigInt(`0x${capMatch[1]}`) & (1n << 25n)) : null;
  let gnuDate = false;
  if (datePath) {
    try { gnuDate = /GNU coreutils/.test((await run(datePath, ["--version"], { timeout: 3000, maxBuffer: 65536, env: { ...process.env, LC_ALL: "C" } })).stdout); } catch { /* Missing or incompatible utility. */ }
  }
  return { root, wsl, container, hasTimeCapability, datePath, gnuDate, sudoPath, pkexecPath, distribution: distribution.match(/^PRETTY_NAME="?([^"\n]+)"?$/m)?.[1] || "Linux" };
}

function guides(system, { reason = "", actualPlatform = process.platform } = {}) {
  const network = system === "win32" ? {
    title: "检测失败：检查 DNS 和时间源连通性",
    command: "Resolve-DnsName ntp.aliyun.com\nw32tm /stripchart /computer:ntp.aliyun.com /samples:3 /dataonly\n# 网络需允许访问时间源的 UDP 123；HTTPS 兜底使用 TCP 443。\n# 在“检测设置”中增加超时，保留多个来源并启用 HTTPS 兜底。",
  } : {
    title: "检测失败：检查 DNS、网络和系统时间服务",
    command: "getent hosts ntp.aliyun.com\ntimedatectl status\n# 已使用 chrony 时还可执行：\nchronyc sources -v\n# 网络需允许访问时间源的 UDP 123；HTTPS 兜底使用 TCP 443。\n# 在“检测设置”中增加超时，保留多个来源并启用 HTTPS 兜底。",
  };
  if (system === "win32") return {
    title: "Windows 处理方法", note: reason || "检测无需管理员权限。校准将按需请求 UAC；取消授权或受组策略限制时，可使用以下系统命令。",
    blocks: [network, { title: "无法校准：在管理员 PowerShell 中使用系统授时", command: "# 在开始菜单搜索 PowerShell，右键“以管理员身份运行”\nStart-Service W32Time\nw32tm /resync /rediscover\nw32tm /query /status\n# 如果提示权限不足，请联系管理员检查“更改系统时间”权限。\n# 域内电脑应遵循域授时策略。" }],
  };
  if (system === "linux") {
    const helper = actualPlatform === "linux"
      ? `sudo ${shellQuote(process.execPath)} ${shellQuote(path.join(__dirname, "linux-clock.js"))} --sync`
      : "# 将下方路径替换为工具实际安装路径\nsudo node /实际路径/time-sync/linux-clock.js --sync";
    return {
      title: "Linux 处理方法", note: reason || "自动校准需要 GNU date 以及 root、可用的 sudo 授权或桌面 polkit 授权。无图形授权窗口时，在终端执行以下命令；不要在网页输入密码。WSL 和容器请先校准宿主机。",
      blocks: [network,
        { title: "无桌面授权或权限不足：在终端执行本工具的校准助手", command: `${helper}\n# 助手会重新检测多个 NTP 源，形成共识后才校准；不会使用网页中的旧结果。\n# 若提示 Operation not permitted，请检查 CAP_SYS_TIME、容器限制或联系管理员。` },
        { title: "已使用 chrony：检查来源并应用已有校正", command: "chronyc sources -v\nchronyc tracking\n# 等待 sources 出现带 * 的已选中来源，再执行：\nsudo chronyc makestep\nchronyc tracking" },
        { title: "已安装 systemd-timesyncd：启用系统自动同步", command: "sudo timedatectl set-ntp true\ntimedatectl status\ntimedatectl timesync-status" },
        { title: "配置多个来源（systemd-timesyncd，可选）", command: "# 编辑 /etc/systemd/timesyncd.conf\n[Time]\nNTP=ntp.aliyun.com time.cloudflare.com time.windows.com\nFallbackNTP=pool.ntp.org\n\n# 保存后执行：\nsudo systemctl restart systemd-timesyncd\ntimedatectl timesync-status\n# chrony 与 systemd-timesyncd 选用一种；缺少服务时先用发行版包管理器安装。" }],
    };
  }
  return { title: "请选择电脑系统", note: "请确认运行工具后端的电脑使用 Windows 还是 Linux，再查看对应处理方法。浏览器所在设备可能与后端不同。", blocks: [] };
}

async function inspectSystem(platform = process.platform, { linuxFacts } = {}) {
  const supported = ["win32", "linux"].includes(platform);
  const base = { platform: supported ? platform : null, detectedPlatform: platform, source: "runtime", requiresSelection: !supported, supportedRuntime: supported, label: platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "系统未识别", capabilities: {}, canCalibrate: supported, reason: "" };
  if (!supported) base.reason = "未能确认受支持的电脑系统，请手动选择；确认后提供相应指引。";
  if (platform === "win32") base.reason = "已自动识别 Windows。检测无需管理员权限，校准时按需请求管理员授权。";
  if (platform === "linux") {
    const facts = linuxFacts || await inspectLinux();
    base.capabilities = facts;
    base.label = facts.distribution || "Linux";
    if (facts.wsl) base.reason = "检测到 WSL，时间通常由 Windows 宿主维护。请在 Windows 宿主运行本工具校准，然后在终端重启 WSL（wsl --shutdown）。";
    else if (facts.container) base.reason = "检测到容器环境，无法将容器时钟当作独立电脑校准。请在宿主机运行本工具或联系宿主机管理员。";
    else if (!facts.gnuDate) base.reason = "缺少受支持的 GNU date。请用发行版包管理器安装 coreutils，或使用下方 chrony / systemd 指引。";
    else if (facts.root && facts.hasTimeCapability === false) base.reason = "当前 root 进程没有 CAP_SYS_TIME，无法调整系统时钟。请联系宿主机管理员，或使用下方系统授时指引。";
    else if (!facts.root && !facts.sudoPath && !facts.pkexecPath) base.reason = "当前不是 root，且没有可用的 sudo / pkexec。请联系管理员或在终端按下方指引校准。";
    else base.reason = facts.root ? "已自动识别 Linux，可直接校准系统时间。" : "已自动识别 Linux。校准时尝试已有 sudo 授权或桌面 polkit 授权；无授权窗口时提供终端操作步骤。";
    base.canCalibrate = !facts.wsl && !facts.container && facts.gnuDate && !(facts.root && facts.hasTimeCapability === false) && Boolean(facts.root || facts.sudoPath || facts.pkexecPath);
  }
  base.guidance = guides(base.platform, { actualPlatform: platform });
  return base;
}

function manualSystem(detected, selected) {
  if (!["win32", "linux"].includes(selected)) throw new Error("请选择 Windows 或 Linux");
  if (detected.supportedRuntime && detected.platform !== selected) throw new Error("所选系统与后端自动识别结果不一致，请在目标电脑上运行工具。");
  if (detected.supportedRuntime) return detected;
  const reason = `已手动确认 ${selected === "win32" ? "Windows" : "Linux"}；后端仍未验证该运行环境，自动校准不可用，请使用下方对应系统的操作步骤。`;
  return { ...detected, platform: selected, label: selected === "win32" ? "Windows" : "Linux", source: "manual", requiresSelection: false, canCalibrate: false, reason, guidance: guides(selected, { reason, actualPlatform: detected.detectedPlatform }) };
}

module.exports = { inspectSystem, inspectLinux, executable, guides, manualSystem };
