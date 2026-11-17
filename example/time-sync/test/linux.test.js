"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { inspectSystem, manualSystem } = require("../system");
const { applyLinuxOffset, syncLinux } = require("../linux-clock");

const facts = { root: true, gnuDate: true, datePath: "/usr/bin/date", hasTimeCapability: true, distribution: "Test Linux" };
const profile = linuxFacts => inspectSystem("linux", { linuxFacts: { ...facts, ...linuxFacts } });

test("Linux 根据缺失依赖、权限、WSL 与容器返回具体的不可校准原因", async () => {
  for (const [changes, reason] of [
    [{ wsl: true }, /WSL/], [{ container: true }, /容器/], [{ gnuDate: false }, /GNU date/],
    [{ hasTimeCapability: false }, /CAP_SYS_TIME/], [{ root: false }, /sudo/],
  ]) {
    const system = await profile(changes);
    assert.equal(system.canCalibrate, false); assert.match(system.reason, reason);
  }
  assert.equal((await profile({ root: false, sudoPath: "/usr/bin/sudo" })).canCalibrate, true);
  assert.equal((await profile({ root: false, pkexecPath: "/usr/bin/pkexec" })).canCalibrate, true);
});

test("未知系统手动确认只启用检测和指引，不能伪造已验证的运行环境", async () => {
  const unknown = await inspectSystem("unknown");
  assert.equal(unknown.requiresSelection, true);
  const selected = manualSystem(unknown, "linux");
  assert.equal(selected.requiresSelection, false); assert.equal(selected.canCalibrate, false);
  assert.match(selected.guidance.title, /Linux/);
  assert.throws(() => manualSystem(selected, "mac"), /Windows 或 Linux/);
  assert.throws(() => manualSystem({ ...selected, supportedRuntime: true }, "win32"), /不一致/);
});

test("Linux 助手在实际执行前补偿授权耗时，并通过参数调用 GNU date", async () => {
  let invocation;
  const system = await profile();
  const now = 1794360000000;
  await applyLinuxOffset({ offsetMs: -125.5, baselineWall: now - 30000, baselineMono: "1000000000" }, {
    platform: "linux", now: () => now, mono: () => 31000000000n, inspect: async () => system,
    execute: async (file, args) => { invocation = { file, args }; },
  });
  assert.equal(invocation.file, "/usr/bin/date");
  assert.deepEqual(invocation.args, ["--utc", "--set=@1794359999.874500", "+%s.%N"]);
});

test("过期、系统跳时、错误平台、缺少权限或非法偏差不能调用设置命令", async () => {
  const baseline = { offsetMs: 100, baselineWall: 1000000, baselineMono: "1000000" };
  const deps = { platform: "linux", now: () => 1001000, mono: () => 1001000000n, inspect: () => profile(), execute: async () => assert.fail("不能调用 date") };
  await assert.rejects(applyLinuxOffset(baseline, { ...deps, mono: () => 100000000000n }), /过期/);
  await assert.rejects(applyLinuxOffset(baseline, { ...deps, now: () => 2000000 }), /调整/);
  await assert.rejects(applyLinuxOffset(baseline, { ...deps, platform: "win32" }), /只能在 Linux/);
  await assert.rejects(applyLinuxOffset(baseline, { ...deps, inspect: () => profile({ root: false }) }), /root|sudo/);
  await assert.rejects(applyLinuxOffset({ ...baseline, offsetMs: Infinity }, deps), /范围/);
  await assert.rejects(applyLinuxOffset({ ...baseline, baselineMono: "malicious" }, deps), /基准/);
});

test("Linux 内核拒绝修改时间时提示 CAP_SYS_TIME 和宿主机处理方法", async () => {
  await assert.rejects(applyLinuxOffset({ offsetMs: 0, baselineWall: 1000, baselineMono: "1000" }, {
    platform: "linux", now: () => 1000, mono: () => 1000n, inspect: () => profile(),
    execute: async () => { throw { stderr: "date: cannot set date: Operation not permitted" }; },
  }), /CAP_SYS_TIME/);
});

test("Linux 普通用户先使用 sudo -n，失败后转桌面授权；不接收密码", async () => {
  const invocations = [];
  const system = await profile({ root: false, sudoPath: "/usr/bin/sudo", pkexecPath: "/usr/bin/pkexec" });
  await syncLinux(10, system, { execute: async (file, args) => {
    invocations.push([file, args]);
    if (file.endsWith("sudo")) throw new Error("a password is required");
    return { stdout: '{"ok":true,"applied":true}' };
  } });
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0][1].slice(0, 2), ["-n", "--"]);
  assert.equal(invocations[1][1][0], "--disable-internal-agent");
  assert.ok(invocations.every(([, args]) => !args.includes("-S")));
});

test("授权被取消、缺少桌面代理及 sudo 需要密码时提供可理解错误", async () => {
  const pkexec = await profile({ root: false, pkexecPath: "/usr/bin/pkexec" });
  await assert.rejects(syncLinux(1, pkexec, { execute: async () => { throw { code: 126 }; } }), /取消/);
  await assert.rejects(syncLinux(1, pkexec, { execute: async () => { throw { code: 127 }; } }), /终端/);
  const sudo = await profile({ root: false, sudoPath: "/usr/bin/sudo" });
  await assert.rejects(syncLinux(1, sudo, { execute: async () => { throw new Error("password required"); } }), /终端/);
});

test("已启动助手返回失败时不可再通过其他提权方式重复修改", async () => {
  let calls = 0;
  const system = await profile({ root: false, sudoPath: "/usr/bin/sudo", pkexecPath: "/usr/bin/pkexec" });
  await assert.rejects(syncLinux(1, system, { execute: async () => { calls++; return { stdout: '{"ok":false,"error":"系统时间已调整"}' }; } }), /已调整/);
  assert.equal(calls, 1);
});
