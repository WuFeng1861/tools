"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { inspectSystem } = require("./system");
const run = promisify(execFile);
const executionOptions = { timeout: 150000, maxBuffer: 1024 * 1024, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } };

function validateOffset(offset) {
  if (!Number.isFinite(offset) || Math.abs(offset) > 315360000000) throw new Error("时间偏差超过可校准范围（10 年），请先手动检查日期。");
}

async function applyLinuxOffset({ offsetMs, baselineWall, baselineMono }, {
  platform = process.platform, now = Date.now, mono = process.hrtime.bigint,
  inspect = inspectSystem, execute = run,
} = {}) {
  if (platform !== "linux") throw new Error("Linux 校准助手只能在 Linux 运行。");
  validateOffset(offsetMs);
  if (!Number.isFinite(baselineWall) || !/^\d{1,30}$/.test(String(baselineMono))) throw new Error("校准基准无效，请重新检测。");
  const system = await inspect("linux");
  if (!system.canCalibrate || !system.capabilities.root) throw new Error(system.reason || "请通过 sudo 或桌面授权运行校准助手。");
  const elapsedMs = Number(mono() - BigInt(baselineMono)) / 1e6;
  if (elapsedMs < 0 || elapsedMs > 90000) throw new Error("管理员授权等待超过 90 秒，测量已过期，请重新检测。");
  if (Math.abs(now() - baselineWall - elapsedMs) > 200) throw new Error("授权期间系统时间已被其他程序调整，请重新检测。");
  // Calculate immediately before spawning GNU date, including the UAC/polkit wait.
  const targetSeconds = ((now() + offsetMs) / 1000).toFixed(6);
  try {
    await execute(system.capabilities.datePath, ["--utc", `--set=@${targetSeconds}`, "+%s.%N"], { ...executionOptions, timeout: 10000 });
  } catch (error) {
    if (/not permitted|permission denied/i.test(error.stderr || "")) throw new Error("Linux 拒绝修改时间：缺少 root / CAP_SYS_TIME，或受容器和系统策略限制。请在宿主机或终端按下方指引操作。");
    throw new Error("GNU date 执行失败，请检查 coreutils 和系统策略，然后按下方指引操作。");
  }
  return { applied: true };
}

async function syncLinux(offsetMs, system, { execute = run, now = Date.now, mono = process.hrtime.bigint } = {}) {
  validateOffset(offsetMs);
  if (system.platform !== "linux" || !system.supportedRuntime || !system.canCalibrate) throw new Error(system.reason || "Linux 自动校准不可用，请使用终端指引。");
  const args = [path.join(__dirname, "linux-clock.js"), "--apply", String(offsetMs), String(now()), String(mono())];
  async function invoke(file, arguments_) {
    const { stdout } = await execute(file, arguments_, executionOptions);
    let result;
    try { result = JSON.parse(stdout.trim()); } catch { throw new Error("Linux 校准未返回有效结果，请重新检测当前时间。"); }
    if (!result.ok) {
      const error = new Error(result.error || "Linux 校准失败，请使用终端指引。");
      error.helperFailure = true;
      throw error;
    }
    return { applied: true };
  }
  const facts = system.capabilities;
  if (facts.root) return invoke(process.execPath, args);
  if (facts.sudoPath) {
    try { return await invoke(facts.sudoPath, ["-n", "--", process.execPath, ...args]); }
    catch (error) {
      if (error.helperFailure) throw error;
      // Never request or send a password over HTTP; sudo -n cannot prompt.
      if (!facts.pkexecPath) throw new Error("sudo 没有可用的非交互授权。请在终端执行下方校准助手命令；网页不会收集密码。");
    }
  }
  if (facts.pkexecPath) {
    try { return await invoke(facts.pkexecPath, ["--disable-internal-agent", process.execPath, ...args]); }
    catch (error) {
      if (error.helperFailure) throw error;
      if (error.killed) throw new Error("等待 Linux 管理员授权超时，请重新检测后重试。");
      throw new Error(error.code === 126 ? "已取消 Linux 管理员授权，未执行校准。可在终端按下方指引操作。" : "桌面管理员授权不可用或被拒绝。请在终端执行下方校准助手命令，或联系管理员。");
    }
  }
  throw new Error("没有可用的 Linux 提权方式，请在终端按下方指引操作。");
}

async function main(args) {
  if (args[0] === "--check") {
    const system = await inspectSystem();
    return { ok: true, checkOnly: true, platform: system.platform, canCalibrate: system.canCalibrate, reason: system.reason };
  }
  if (args[0] === "--sync") {
    if (process.platform !== "linux") throw new Error("请在 Linux 终端中执行该命令。");
    const system = await inspectSystem();
    if (!system.canCalibrate || !system.capabilities.root) throw new Error(system.reason + " 请使用 sudo 执行本助手。");
    const report = await require("./clock").detect();
    if (!report.consensus.canSync || report.consensus.kind !== "ntp") throw new Error("NTP 时间源未形成共识，未修改系统时间。请检查 DNS、防火墙 UDP 123 和网络。");
    await applyLinuxOffset({ offsetMs: report.consensus.offsetMs, baselineWall: Date.now(), baselineMono: String(process.hrtime.bigint()) });
    try {
      const after = await require("./clock").detect();
      const verified = after.consensus.canSync && after.consensus.kind === "ntp" && Math.abs(after.consensus.offsetMs) <= Math.max(100, after.consensus.uncertaintyMs);
      return { ok: true, applied: true, verified, report: after, message: verified ? "校准已执行，复测通过。" : "校准已执行，但复测未通过，请再次检查。" };
    } catch { return { ok: true, applied: true, verified: false, message: "校准已执行，但复测失败，请再次检测。" }; }
  }
  if (args[0] !== "--apply" || args.length !== 4) throw new Error("使用 --check 只读检查，或在 Linux 终端执行 sudo node linux-clock.js --sync。");
  return { ok: true, ...await applyLinuxOffset({ offsetMs: Number(args[1]), baselineWall: Number(args[2]), baselineMono: args[3] }) };
}

if (require.main === module) main(process.argv.slice(2)).then(result => console.log(JSON.stringify(result)), error => {
  console.log(JSON.stringify({ ok: false, error: error.message }));
  // The elevated IPC mode returns structured errors; terminal use also gets an exit code.
  if (process.argv[2] !== "--apply") process.exitCode = 1;
});
module.exports = { applyLinuxOffset, syncLinux, main };
