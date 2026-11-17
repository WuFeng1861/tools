# 时间检测与校准

零第三方 npm 依赖的 Node.js 小工具，符合本仓库工具平台规范。支持 Windows 与 Linux 多源时间检测、管理员校准和校后复测。优先自动识别系统；不能识别时由用户选择。确认系统后，检测或校准失败会展示对应系统的原因与可复制操作步骤。

## 使用

### 在工具平台中运行

把整个 `time-sync` 文件夹复制到平台工具目录，回到平台刷新，即可打开「时间检测与校准」。
Windows 目录为 `%APPDATA%\com.tools.platform\toolbox\`；Linux 默认为
`~/.local/share/com.tools.platform/toolbox/`（或 `$XDG_DATA_HOME/com.tools.platform/toolbox/`）。
也可从平台「新建 → 打开工具目录」定位。不需要安装 npm 依赖。平台会注入 `TOOL_PORT`，工具只监听本机回环地址。

### 独立运行

需要 Node.js 18 或以上版本。在仓库根目录执行：

```powershell
node .\example\time-sync\app.js
```

浏览器打开 <http://127.0.0.1:3930>。如果独立运行时端口被占用，可以修改 `TOOL_PORT`：

```powershell
$env:TOOL_PORT = '3931'
node .\example\time-sync\app.js
```

1. 点击「开始检测」，查看本机偏快或偏慢、偏差、不确定度，以及各个源的连通性。
2. 页面自动识别运行后端的电脑系统。识别失败时，先选择 Windows 或 Linux 并点击「确认系统」。界面显示识别结果、校准条件，以及「重新识别」「查看处理方法」入口。
3. 多个独立来源形成多数共识，且系统具备校准条件时，可点击「校准 Windows 时间」或「校准 Linux 时间」。校准前会再次检测，随后按需请求管理员授权，请在 90 秒内完成授权。
4. 校准后自动重新检测，分别报告“系统已执行校准”和“复测是否通过”。取消授权、时间源失去共识、测量过期等情况会明确显示，并自动展开对应处理方法。
5. 如果只有 HTTPS 可用，显示秒级估计。必须勾选「允许 HTTPS 秒级粗略校准」后才能执行粗略校准。它不能保证 NTP 精度。

关闭独立运行的终端或按 Ctrl+C 可停止工具。打开页面不会自动修改时间，也不会自动发起检测。

## 时间源与算法

默认并行检测 6 个 NTP 地址：

| 服务商 | 地址 | 说明 |
| --- | --- | --- |
| 阿里云 | `ntp.aliyun.com`、`ntp1.aliyun.com` | 两个备用地址合计只算一个独立来源 |
| Cloudflare | `time.cloudflare.com` | 全球节点 |
| Microsoft | `time.windows.com` | Windows 公共时间源 |
| Apple | `time.apple.com` | 公共时间源 |
| NTP Pool | `pool.ntp.org` | 动态分配池节点，整体计一个来源 |

NTP 无法形成共识时，可回退到 `www.aliyun.com`、`www.qq.com`、`www.microsoft.com`、`www.cloudflare.com` 的 HTTPS 响应 `Date`。请求带随机查询和禁止缓存头；有非零 `Age` 的响应会被排除。HTTPS 始终验证证书，不跟随重定向、不下载网页正文。网页时间可能来自 CDN，并非专门授时接口，因此仅用于秒级估计。

- 使用 NTP 四时间戳公式：`offset = ((T2 - T1) + (T3 - T4)) / 2`，`delay = (T4 - T1) - (T3 - T2)`。**正偏差表示本机慢；负偏差表示本机快。**
- 默认每个 NTP 地址采样两次、单次超时 2.5 秒，可在界面调整。选择不确定度较低的样本，并把采样间差异纳入不确定度；不会直接使用请求完成时的服务器时间覆盖本机。
- 校验响应模式、版本、同步状态、层级、原始请求标识、非零时间戳和往返时序。NTP 2036 年的 era 回绕已处理；本机日期需处于正确 NTP era 附近（距真实日期少于约 68 年），校准最大允许偏差为 10 年。
- 每个服务商只取一个代表结果；对延迟和离散程度合格的测量区间求最大交集，至少两个独立来源且超过可用来源一半才允许校准。最后取参与共识来源的偏差中位数，并显示保守的不确定度。非共识来源仍保留在表格中。
- NTP 与 HTTPS 分开求共识，不混合平均；默认未使用 Google Public NTP，避免把 Google 的 leap smear 与普通 UTC 闰秒处理混配。
- 用单调时钟检查检测期间的本机时间跳变。结果有效期为两分钟；每次校准使用服务端新测量的偏差，忽略客户端传入的偏差。

多源与两种协议可提高跨地区可用性，但离线、DNS 故障、防火墙、证书问题或网络策略仍可能使所有来源失败。纯 UDP NTP 不具备身份认证；多源共识用于排除异常与降低单源影响，不能替代 NTS。界面显示的不确定度是估计值，不是准确度保证。HTTPS 时间也无法用于承诺毫秒级准确度。

## Windows 校准方式

后端执行随工具提供的 `windows-clock.ps1`。普通权限进程通过 `Start-Process -Verb RunAs` 按需请求管理员权限；已提升的进程直接执行。脚本使用 Windows `SetSystemTime` 设置 UTC 时间，不更改时区，不改 Windows Time 服务配置，也不创建定时任务。

校准在实际调用系统 API 前，使用**当前 UTC 时间 + 新测得的偏差**生成目标时间，以补偿启动脚本与等待 UAC 的耗时；不会把点击按钮时的旧时间直接写入系统。授权等待超过 90 秒，或授权期间本机时间已跳变，会停止校准。Windows Time、域策略或虚拟机宿主后续仍可能调整系统时间；如需长期保持准确，应维护系统自身的授时配置。

只读检查 PowerShell 和 Win32 接口是否可加载：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\example\time-sync\windows-clock.ps1 -CheckOnly
```

`-CheckOnly` 不申请管理员权限、不调用设置时间接口。

## 系统识别与失败处理

系统识别使用后端的 `process.platform`，不用浏览器 User-Agent 猜测。Linux 还检查 GNU date、root、sudo、pkexec、CAP_SYS_TIME、WSL 和常见容器标识。安装缺失工具或更换运行环境后，点击「重新识别」，再重新检测时间。

- Windows / Linux 被可靠识别时，自动选择对应校准器。手动选择不能覆盖与实际运行系统矛盾的结果。
- 自动识别失败或运行于其他平台时，显示 Windows / Linux 选择框。手动确认后可做通用网络时间检测，但如果后端仍未验证该系统，就只提供该系统的操作方法，不执行不匹配的系统命令。
- 工具后端不可用时，也可先手动选择系统，查看如何启动工具及使用系统授时命令；自动检测和校准保持不可用。
- 检测失败时显示 DNS、时间源 UDP 123、HTTPS TCP 443、超时和系统授时排查步骤。
- 校准失败时显示授权、依赖、系统策略及终端替代操作；Windows 提供管理员 PowerShell / `w32tm` 指引，Linux 提供本工具助手、chrony 和 systemd-timesyncd 指引。

## Linux 自动校准与替代操作

Linux 需要 GNU coreutils 的 `date`。不需要 Python、编译器或新增 npm 包。点击校准后，按以下顺序执行：

1. root 进程直接运行校准助手。
2. 普通用户尝试 `sudo -n` 的现有非交互授权，不弹终端、不读取密码。
3. sudo 不可用或未授权时，尝试 `pkexec --disable-internal-agent` 请求已有桌面 polkit 授权代理。
4. 缺少依赖、无桌面授权代理、取消授权或缺少权限时，显示明确原因和终端操作步骤。网页不接收密码，也不修改 sudo / polkit 策略。

提权后，助手用跨进程的单调时钟检查授权等待是否超过 90 秒、系统时间是否已跳变；随后用当前时间加测得偏差生成 GNU date 的 UTC epoch 参数。等待授权的耗时被补偿，仍存在启动 date 子进程的开销。实际准确度受网络、测量不确定度和系统调度影响，不承诺固定毫秒级精度。

WSL 和容器默认只检测并显示宿主机操作方法，不直接改共享时钟。root 缺少 CAP_SYS_TIME 时也会阻止自动校准。工具不更改时区、不写硬件时钟、不停用系统时间服务。

无桌面授权时，可在 Linux 终端直接执行（替换为实际工具路径）：

```bash
sudo node /实际路径/time-sync/linux-clock.js --sync
```

终端助手会重新进行多源 NTP 检测，形成共识后才校准，并在校准后复测；不使用网页中的旧结果，也不会自动降级到 HTTPS 粗略校准。页面中的终端命令会填入当前 Node 和工具的实际路径。若仍报权限错误，请在宿主机上操作或联系管理员。

只读检查环境，不修改时间、不提权：

```bash
node /实际路径/time-sync/linux-clock.js --check
```

如果系统使用已安装的 `systemd-timesyncd`：

```bash
sudo timedatectl set-ntp true
timedatectl status
timedatectl timesync-status
```

可以在 `/etc/systemd/timesyncd.conf` 的 `[Time]` 中配置多个来源：

```ini
[Time]
NTP=ntp.aliyun.com time.cloudflare.com time.windows.com
FallbackNTP=pool.ntp.org
```

保存后执行 `sudo systemctl restart systemd-timesyncd`，再次使用 `timedatectl timesync-status` 检查。

如果系统已经使用 chrony：

```bash
chronyc sources -v
chronyc tracking
# 等待 sources 显示带 * 的已选中来源后，立即应用当前校正
sudo chronyc makestep
chronyc tracking
```

两种服务选一种。缺少服务时先通过发行版包管理器安装；容器或 WSL 通常需要校准宿主机。

## 验证

```powershell
node --test .\example\time-sync\test\*.test.js
```

测试覆盖四时间戳方向和延迟、2036 回绕、无效 NTP 响应、本机真实 UDP 收发与超时、独立来源共识和分歧、HTTPS 降级、同源/令牌校验、自动及手动系统确认、Linux 校准器分派、提权回退、授权等待补偿、WSL/容器/权限限制、故障指引、校准前复测、校后验证、取消授权与并发操作。系统校准使用测试替身，测试不会修改电脑时间。

当前开发机器为 Windows；Linux 的改时与提权逻辑通过注入的系统信息和执行器验证，未在这台机器上完成真实 Linux 提权改时测试。

手工检查 Linux 正常识别、未知系统选择、来源失败和后端不可用等界面（端口 3931–3934，均使用模拟器，不修改系统时间）：

```bash
node example/time-sync/test/ui-server.js
```

API 仅监听 `127.0.0.1`，检查 Host 与 Origin，POST 还校验页面取得的随机令牌。只公开界面所需的静态文件，避免下载后端脚本。检测只访问固定的内置时间源，没有任意 URL 或命令执行接口。

## 参考

- [NTPv4 协议与四时间戳公式（RFC 5905）](https://www.rfc-editor.org/rfc/rfc5905)
- [Microsoft SetSystemTime：UTC 与所需权限](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-setsystemtime)
- [Cloudflare 公共 NTP](https://developers.cloudflare.com/time-services/ntp/)
- [Google Public NTP 与 leap smear 混配限制](https://developers.google.com/time/)
- [systemd timedatectl](https://www.freedesktop.org/software/systemd/man/latest/timedatectl.html)
- [chronyc](https://chrony-project.org/doc/latest/chronyc.html)
- [GNU date 设置时间](https://www.gnu.org/software/coreutils/manual/html_node/Options-for-date.html)
- [polkit pkexec 授权代理](https://www.freedesktop.org/software/polkit/docs/master/pkexec.1.html)
