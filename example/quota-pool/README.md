# 多号签到 quota-pool

> tools 小工具平台的一个完整工具：**WorkBuddy / Trae 多账户自动签到**。
> 查状态 + 幂等签到 + token 刷新，每天定时自动跑一次。只做签到，不做聊天中转。

零第三方依赖（只用 Node 内置 `http/https/fs/crypto`）。

## 1. 能做什么

- **多账户池**：`workbuddy` / `trae` 两种号混池，备注区分，启用/停用一键切。
- **签到保活**：查状态 + 幂等签到（已签跳过），每天指定 hour 自动跑一次，失败记日志。
- **token 续期**：WorkBuddy 用 `refreshToken` 一键刷新（access 约 60 天，refresh 约 90 天）。
- **额度展示**：剩余额度 + 签到累计 + WorkBuddy 分包明细（和客户端对账用）。
- **脱敏展示**：列表只显示 token 首尾，日志不打全 token。

## 2. 目录结构

```
example/quota-pool/
├── manifest.json  # id=quota-pool，平台扫描依据
├── index.html     # 界面（含加入账户指引 + 自动签到设置）
├── styles.css
├── front.js       # 列表/表单/设置/日志逻辑
├── app.js         # 后端：账户池 + 直签接口
└── package.json   # 无依赖
运行时生成：accounts.json / config.json / pool.log（全在工具目录）
```

## 3. 装进平台

1. 把 `quota-pool/` 整个文件夹复制到 `%APPDATA%\com.tools.platform\toolbox\quota-pool\`
  （开发期是本仓库 `data/toolbox/quota-pool/`）。
2. 主页面点「刷新」，点图标进入。无需装任何 npm 包。
3. 本地独立调试：`cd example/quota-pool && node app.js`（默认 `http://127.0.0.1:3935`）。

## 4. 加入账户（页面顶部“快捷登录”最省事）

- **WorkBuddy 本机号**：点“一键导入本机登录态”，工具直接读客户端会话文件入池，不用复制粘贴。别人的号仍需手动贴 token。
- **Trae 新号**：点“生成登录链接”→ 浏览器打开登录 → 把回调地址完整复制回来 → 点“完成登录并加入池子”。全程在工具里，不用下脚本；自带 `refreshToken`，过期后点行内“刷新”自动续。
- 手动贴仍可用（界面第 ② 步有各类型的取值位置）。

### WorkBuddy 号

1. 本机装 WorkBuddy 客户端并登录一次。
2. PowerShell 取登录态：
   ```powershell
   Get-Content "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info" -Raw
   ```
   取其中 `auth.accessToken` + `auth.refreshToken`。旧版本路径是
   `%APPDATA%\CodeBuddyExtension\...` 同名文件，找不到就换那边。
3. 贴到表单。`uid/endpoint` 一般不用填（自动从 token 解析，endpoint 默认 `https://copilot.tencent.com`）。
4. 别人号：让对方同样取一次发你。token 等同密码，泄露去客户端重登即失效。

### Trae 号

1. 该账号先在**它自己的 Windows 电脑**装 TraeWork 桌面端登录一次（完成设备绑定）。
2. 在那台电脑记下 `%APPDATA%\TRAE SOLO CN\ModularData\ckg_server\local_env.json` 里的 `device_id`。
3. 用 `trae-signin/traework2api` 的 `login.ps1` 换 token，或从已登录进程内存提取 JWT（`eyJ` 开头）。
4. `token + deviceId` 一起贴。**deviceId 错了会 9074（看着成功其实没到账）**，多号勿共用同一 ID。
5. token 短命正常，过期重贴 token 即可，deviceId 不变。

## 5. 自动签到

页面“自动签到”卡里定每天几点（-1=关闭），工具常驻后到点自动给全部启用账户查状态 + 签到，结果记到 `pool.log`。若到点时电脑没开（比如 9 点关机、12 点才开），下次启动后 30 秒内自动补签，当天不会漏。失败自动重试 3 次（间隔 10s/30s）；token 过期、Trae 9074 这类致命错误不重试，直接标红。
本工具 `manifest.json` 已带 `"autoStart": true`：平台启动即拉起，关掉页面不停止，托盘右键 → 后台工具可直达。改完 manifest 需重启平台生效。

## 6. 额度与重登时间（经验值，以官方为准）

- WorkBuddy：`accessToken≈60天`，`refreshToken≈90天`。60 天内一键刷新无感续，90 天后必须重登重贴。
- Trae：JWT 短命（小时/天级），过期重贴；`deviceId` 长期有效，换绑才变。
- Trae 一台设备一天只能签一个号；WorkBuddy 暂无此限制。
- 签到奖励：WorkBuddy 每天 100 通用积分；Trae 每天 200 Work 专属积分（月 cap 6200），IDE 通用积分不涨。
- 列表里“剩 X”是剩余额度（用量/资源接口算的），“签到累计 Y”是签到奖励包累计；状态接口自带的活动口径数字不是余额。
- WorkBuddy 按“周期剩”汇总（客户端口径）：如体验版剩 500 但周期剩 0 就不计入；无周期数据时才回退到总量。

## 7. 常见问题

| 现象 | 处理 |
|---|---|
| Trae `code=1001` | token 失效或鉴权头被改：重贴 token，本工具固定用 `Cloud-IDE-JWT` 前缀 |
| Trae `code=9074` | deviceId 未绑定：换该账号绑定过的 deviceId |
| WorkBuddy `401/403` | access 过期：先点“刷新”，不行就重贴 |
| 自动签到没跑 | 检查设置里 hour（-1=关闭），工具需常驻 |

## 8. 安全提醒

- `accounts.json` 明文存 token，仅本机 `127.0.0.1` 可访问，不要发网盘/截图。
- token 等同密码：怀疑泄露，去对应客户端重登一次即让旧 token 失效，再回来更新池子。
