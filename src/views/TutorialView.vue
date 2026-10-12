<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();
</script>

<template>
  <div class="tutorial">
    <header class="topbar">
      <button class="ghost" @click="router.push('/')">← 返回</button>
      <span class="title">📖 使用教程</span>
      <div class="spacer" />
      <button class="ghost" @click="router.push({ name: 'tool-editor-new' })">
        ➕ 去新建一个
      </button>
    </header>

    <main class="body">
      <section class="block">
        <h2>工具是什么？</h2>
        <p>平台里有<strong>三种</strong>工具，按「要花多少力气」排列：</p>
        <table>
          <tr><th>类型</th><th>是什么</th><th>怎么加</th></tr>
          <tr>
            <td><code>url</code> 网址工具</td>
            <td>直接加载一个外部网页，不跑本地进程</td>
            <td rowspan="2">「新建 ▾ → 添加网址 / 本地网页」</td>
          </tr>
          <tr>
            <td><code>static</code> 本地网页工具</td>
            <td>把本地 HTML 文件/目录复制进来，由平台托管</td>
          </tr>
          <tr>
            <td><code>local</code> 代码工具</td>
            <td>HTML 界面 + Node.js 后端，能力最完整</td>
            <td>「新建 ▾ → 写代码新建工具」</td>
          </tr>
        </table>
        <p>
          三种工具界面都由主窗口的 iframe 加载，各自占用一个独立端口。这带来两个重要好处：
        </p>
        <ul>
          <li>
            页面处在 <code>http://127.0.0.1:端口</code> 这个<strong>安全上下文</strong>下，
            WebRTC、剪贴板、Service Worker 等「只有 https / localhost 才能用」的能力都可以用；
          </li>
          <li>
            端口固定后 origin 稳定，<code>localStorage</code> / <code>IndexedDB</code>
            能跨重启保存（详见下面「端口与本地存储」）。
          </li>
        </ul>
      </section>

      <section class="block">
        <h2>三步创建一个代码工具</h2>
        <ol>
          <li>主页面 →「新建 ▾」→「写代码新建工具」→ 填名称 → 选模板 → 创建</li>
          <li>在编辑器中修改 <code>index.html</code>（界面）和 <code>app.js</code>（后端），Ctrl+S 保存</li>
          <li>点「运行 ▶」查看效果；需要什么库就去「更多 ▾ → 依赖管理」里安装</li>
        </ol>
      </section>

      <section class="block">
        <h2>不动代码：用网址或本地网页添加工具</h2>
        <p>主页面 →「新建 ▾」→「添加网址 / 本地网页」，弹窗里有两个页签。</p>

        <p class="sub">网址</p>
        <ul>
          <li>
            填 <code>https://…</code> 任意地址，或 <code>http://127.0.0.1:端口</code> /
            <code>http://localhost:端口</code> 的本地服务。
          </li>
          <li>页面由对方站点自己托管，存储也归它自己的域名。</li>
          <li>
            部分站点设了 <code>X-Frame-Options</code> / CSP <code>frame-ancestors</code>
            禁止被嵌入，页面会空白 —— 工具页右上角有「用浏览器打开」兜底。
          </li>
        </ul>

        <p class="sub">本地网页</p>
        <ul>
          <li>
            填一个 <code>.html</code> / <code>.htm</code> 文件路径，或一个<strong>含 <code>index.html</code> 的目录</strong>
            （整个目录会被复制，含同目录的 css / js / 图片；跳过 <code>node_modules</code> 与 <code>.git</code>）。
          </li>
          <li>
            内容会复制到 <code>toolbox/&lt;id&gt;/</code>，由平台的内置静态服务托管，<strong>自包含</strong>：
            之后改原文件不影响已添加的工具；要更新就重新添加一次，
            或直接改 <code>toolbox/&lt;id&gt;/</code> 里的副本（静态服务不缓存，刷新即生效）。
          </li>
        </ul>

        <p class="note">
          为什么比直接双击 <code>.html</code> 好？双击是 <code>file://</code>，属于<strong>非安全上下文</strong>，
          WebRTC、剪贴板、Service Worker 大多被浏览器直接禁用，存储行为也各浏览器不一致。
          放到这里跑在 <code>http://127.0.0.1:固定端口</code>，这些问题一次解决。
        </p>
      </section>

      <section class="block">
        <h2>目录结构</h2>
        <p class="sub">代码工具（local）</p>
        <pre><code>toolbox/my-tool/
├── manifest.json    # 工具元信息（必填）
├── index.html       # 工具界面（必填）
├── app.js           # 工具后端（必填，Node.js）
├── package.json     # 依赖清单（由依赖管理页维护）
└── node_modules/    # 已安装的 npm 库</code></pre>

        <p class="sub">本地网页工具（static）</p>
        <pre><code>toolbox/my-page/
├── manifest.json    # 自动生成，也可以自己改
├── index.html       # 入口页面（必填）
└── …                # 同目录的 css / js / 图片等</code></pre>
        <p class="note">没有 Node 后端，所以不需要 <code>app.js</code>，也不参与依赖管理。</p>

        <p class="sub">网址工具（url）</p>
        <pre><code>toolbox/my-link/
└── manifest.json    # 只此一个文件，指向外部地址</code></pre>
      </section>

      <section class="block">
        <h2>manifest.json 字段</h2>
        <table>
          <tr><th>字段</th><th>说明</th></tr>
          <tr><td><code>id</code></td><td>唯一标识，仅小写字母/数字/-/_；就是目录名</td></tr>
          <tr><td><code>name</code></td><td>显示名称</td></tr>
          <tr><td><code>version</code></td><td>版本号</td></tr>
          <tr><td><code>description</code></td><td>一句话描述（显示在启动器卡片上）</td></tr>
          <tr>
            <td><code>type</code></td>
            <td>
              <code>local</code>（默认，跑 Node）/ <code>static</code>（本地网页）/
              <code>url</code>（外部网址）
            </td>
          </tr>
          <tr><td><code>url</code></td><td>仅 <code>type: "url"</code> 用，外部地址</td></tr>
          <tr><td><code>main</code></td><td>仅 <code>local</code> 用，后端入口 JS，如 <code>app.js</code></td></tr>
          <tr><td><code>html</code></td><td><code>local</code> / <code>static</code> 的入口页面，如 <code>index.html</code></td></tr>
          <tr>
            <td><code>port</code></td>
            <td><code>0</code> = 自动分配<strong>并记住</strong>（推荐）；填固定值则强制使用该端口</td>
          </tr>
        </table>
        <p class="note">
          没有 <code>manifest.json</code> 的目录也有救：只要里面<strong>有 <code>index.html</code></strong>，
          平台会自动按本地网页工具接管，并补生成一份 manifest.json（之后可在编辑器里改）。
        </p>
      </section>

      <section class="block">
        <h2>app.js —— 后端写法</h2>
        <p>推荐使用内置运行时 <code>ToolServer</code>（自动 serve 静态文件 + 提供路由）：</p>
        <pre><code>// 工具后端入口
const { ToolServer } = require(process.env.TOOL_RUNTIME);

const server = new ToolServer({
  dir: __dirname,      // serve 本目录的 index.html 与静态资源
  routes: {
    "/api/ping": (req, res, body) => res.json({ ok: true, msg: "pong" }),
    "/api/echo": (req, res, body) => res.json({ received: body }),
  },
});

server.start();        // 自动监听 process.env.TOOL_PORT</code></pre>
        <p>也可以不用运行时，自己写原生 http：</p>
        <pre><code>const http = require("http");
http.createServer((req, res) => {
  res.end("hello");
}).listen(process.env.TOOL_PORT, "127.0.0.1");</code></pre>
        <p class="note">宿主会注入环境变量：<code>TOOL_ID</code>、<code>TOOL_PORT</code>、<code>TOOL_DIR</code>、<code>TOOL_RUNTIME</code>。</p>
      </section>

      <section class="block">
        <h2>index.html —— 界面写法</h2>
        <p>界面就是你熟悉的 HTML/CSS/JS，通过 <code>fetch</code> 调用自己的后端（同源，无跨域问题）：</p>
        <pre><code>&lt;button onclick="ping()"&gt;调用后端&lt;/button&gt;
&lt;pre id="out"&gt;&lt;/pre&gt;
&lt;script&gt;
  async function ping() {
    const r = await fetch("/api/ping");
    document.getElementById("out").textContent =
      JSON.stringify(await r.json(), null, 2);
  }
&lt;/script&gt;</code></pre>
      </section>

      <section class="block">
        <h2>安装 npm 库</h2>
        <p>
          主页面 →「依赖管理」→ 选择工具 → 输入包名（可加版本）→ 安装。
          装好后在 <code>app.js</code> 里直接 <code>require("包名")</code> 使用。
          依赖只装在该工具自己的目录，工具之间不共享。
        </p>
        <p class="note">示例：给工具装 <code>nanoid</code>，然后 <code>const { nanoid } = require("nanoid")</code> 就能生成唯一 ID。</p>
      </section>

      <section class="block">
        <h2>运行与调试</h2>
        <ul>
          <li>启动器点工具卡片 → 打开工具界面（右上角可查看「日志」、重新加载）</li>
          <li>工具后端打印的 <code>console.log</code> 会进「日志」抽屉</li>
          <li>改代码后点「重新加载」生效；编辑器里也可直接「运行 ▶」</li>
          <li>进程异常退出时启动器会显示「异常」状态，可查看日志排查</li>
          <li>静态网页工具没有进程，所以没有日志，右上角只有「重新加载」</li>
        </ul>
      </section>

      <section class="block">
        <h2>端口与本地存储（重要）</h2>
        <p>
          浏览器按 <strong>origin（协议 + 主机 + 端口）</strong>隔离存储。工具页是
          <code>http://127.0.0.1:&lt;端口&gt;</code>，所以 <strong>端口就是存储桶编号</strong>：
          端口一变就换了个桶，原来存的东西就「看不见」了（数据没被删，只是访问不到）。
        </p>
        <p>
          因此平台会把每个工具第一次分配到的端口记在 <code>ports.json</code> 里，
          之后每次启动都复用。效果是：
        </p>
        <ul>
          <li>同一个工具重启后仍能读到自己上次写的数据</li>
          <li>不同工具之间存储天然隔离、互不干扰</li>
          <li>删除工具时会一并清掉它的端口记忆，避免将来同名工具继承旧数据</li>
        </ul>
        <p class="note">
          想给工具写死一个端口，就在 manifest 里填 <code>port</code>；
          但要清楚这个端口的 origin 决定了它的存储位置，别随便改。
        </p>
      </section>

      <section class="block">
        <h2>工具打不开？可能是端口被占用</h2>
        <p>
          打开工具时如果它的记忆端口已被别人占用，平台<strong>不会擅自换端口</strong>
          （换端口就是换存储位置），而是弹窗让你选：
        </p>
        <table>
          <tr><th>选项</th><th>会发生什么</th></tr>
          <tr>
            <td><strong>先不启动</strong></td>
            <td>什么都不做，返回启动器；下次打开会重新检查</td>
          </tr>
          <tr>
            <td><strong>重试启动</strong></td>
            <td>你去关掉占用端口的程序后点它 —— 端口没变，<strong>数据不丢</strong>（推荐）</td>
          </tr>
          <tr>
            <td><strong>重新分配端口并启动</strong></td>
            <td>
              换个新端口启动。工具会换到新的存储位置，
              之前的 <code>localStorage</code> / <code>IndexedDB</code> 就读不到了
            </td>
          </tr>
        </table>
        <p class="note">
          另外两类情况：manifest 里<strong>写死</strong>的 <code>port</code> 被占用会直接报错；
          后台常驻（<code>autoStart</code>）工具遇到冲突只记日志跳过，等你进界面再决定。
        </p>
      </section>

      <section class="block">
        <h2>残留数据（磁盘空间）</h2>
        <p>
          一旦选了「重新分配端口」，旧端口上的 <code>localStorage</code> / <code>IndexedDB</code>
          就成了<strong>访问不到的残留</strong>。它不会自己消失 —— 同源策略不允许从外部删除
          另一个来源的数据。平台会自动收拾：
        </p>
        <ol>
          <li><strong>登记</strong>：旧端口记入 <code>residuals.json</code>（删除工具时也会登记）</li>
          <li><strong>等空闲</strong>：约每 3 分钟检查一次；被占用就跳过，绝不去抢别人的端口</li>
          <li>
            <strong>占下并清理</strong>：一旦空闲，宿主自己监听那个端口，取得该 origin 的同源身份，
            用一个不可见的 iframe 清掉里面的 localStorage / IndexedDB / Cache Storage /
            Service Worker 注册，随后关闭端口
          </li>
        </ol>
        <p>
          <strong>更多 ▾ → 设置 → 残留数据</strong>里能看到当前有哪些残留、属于哪个工具、登记时间，
          以及当前状态（空闲待清理 / 正在清理 / 被占用 / 冷却中）。每条提供两个操作：
          <strong>立即清理</strong>（可跳过冷却倒计时）和 <strong>放弃</strong>（数据继续留在磁盘上，不再尝试）。
        </p>
        <p class="note">
          不过还是建议优先选「重试启动」—— 清理属于事后补救，重试则数据完好无损。
        </p>
      </section>

      <section class="block">
        <h2>后台挂起 &amp; 系统托盘</h2>
        <p>点右上角「关闭 (×)」时，会弹出「转入后台 / 退出程序」选择，并可用「记住我的选择，不再询问」。</p>
        <ul>
          <li><strong>转入后台</strong>：窗口隐藏、继续在托盘运行，宿主与后台工具不中断；托盘<strong>左键单击/双击</strong>可重新打开主界面。</li>
          <li><strong>退出程序</strong>：真正结束，会停止宿主与所有工具进程。</li>
          <li>托盘<strong>右键</strong>菜单：显示主界面 / <strong>后台工具 ▸</strong>（点击直达某工具）/ 退出程序。</li>
          <li>这个记忆选择可在 <strong>主界面 → 更多 ▾ → 设置</strong> 里随时修改。</li>
        </ul>
      </section>

      <section class="block">
        <h2>后台常驻工具（autoStart）</h2>
        <p>在工具的 <code>manifest.json</code> 里加 <code>"autoStart": true</code>，平台启动时就会自动拉起它，且<strong>关闭它的界面不会停止它</strong>（例如剪贴板历史这样需要一直后台运行的）。</p>
        <ul>
          <li>后台工具会出现在<b>托盘右键 → 后台工具 ▸</b>，点击直达。</li>
          <li>普通工具（无 autoStart）仍按老逻辑：离开界面即停止。</li>
        </ul>
      </section>

      <section class="block">
        <h2>单实例：后台/托盘出现两个平台怎么办</h2>
        <p>平台是单实例的：重复启动不会再起第二个，只会唤起已有主界面。如果还是看到两个托盘图标/两套后台工具，说明 running 的是<strong>两个不同版本</strong>（最常见：开发版 <code>tauri dev</code> 和安装版同时开着）。</p>
        <ul>
          <li>先确认：任务管理器里找 <code>ToolPlatform</code> / <code>tools.exe</code>，只留一个。</li>
          <li>托盘多出来的图标：鼠标悬停上去一般会自动消失（Windows 残留）。</li>
          <li>签到类工具如果跑了两份，会同时签到甚至被官方限流（code=10001）；多号签到工具自带单实例定时锁，第二个进程只提供界面、不重复跑定时。</li>
        </ul>
      </section>

      <section class="block">
        <h2>全局快捷键（manifest 声明 + 统一管理）</h2>
        <p><strong>任意工具</strong>都可以在 <code>manifest.json</code> 里用 <code>shortcuts</code> 数组声明<strong>多个</strong>全局快捷键，每个对应一个不同动作。平台启动时读取并按你声明的组合键注册为<strong>系统级全局快捷键</strong>。</p>
        <pre><code>// manifest.json —— 声明一把快捷键
"shortcuts": [
  { "id": "toggle-quick", "name": "唤起 / 收起快速面板",
    "accel": "ctrl+shift+v", "action": "toggle-quick" }
]</code></pre>
        <ul>
          <li>所有工具的快捷键集中在 <strong>主界面 → 更多 ▾ → 全局快捷键</strong> 统一查看、修改、恢复默认，改动即时生效。</li>
          <li>若同一组合键被<strong>多个动作</strong>占用，这两项都会标红「冲突」且不注册；改成冲突键时页面会拦截并提示（系统自身已占用也会有提示）。</li>
          <li>剪贴板历史示例默认声明了 <code>ctrl+shift+v</code>（唤起/收起快速面板）。</li>
        </ul>
      </section>

      <section class="block">
        <h2>按下快捷键后发生了什么（纯事件转发）</h2>
        <p>平台对组合键按下只做一件事：把 <code>{ shortcutId, action }</code> 通过宿主 <code>POST</code> 转发给<strong>该工具的 <code>/__platform/shortcut</code></strong>，由你的工具代码决定做什么。平台不做任何"预设行为"。</p>
        <pre><code>// 工具后端 app.js —— 处理快捷键事件
server.route("/__platform/shortcut", (req, res, body) => {
  const j = JSON.parse(body || "{}");
  console.log("快捷键", j.shortcutId, "→", j.action);
  res.json({ ok: true });
});</code></pre>
        <p>工具未运行时事件会被丢弃（可在该路由打日志排查）。一个工具可以声明多把快捷键，<code>action</code> 互不干扰。</p>
      </section>

      <section class="block">
        <h2>悬浮面板：交给你的用户代码</h2>
        <p>窗口（webview）只有平台能创建，但<strong>要不要弹、弹哪个页面、何时收起</strong>完全由工具的用户代码决定，平台不把面板绑定到任何快捷键上。先声明面板元数据：</p>
        <pre><code>// manifest.json —— 声明悬浮面板（纯窗口描述，与快捷键无关）
"panels": [
  { "id": "quick", "page": "quick.html", "title": "剪贴板历史",
    "width": 380, "height": 560 }
]</code></pre>
        <p>工具进程没有 Tauri API，通过<strong>标记文件</strong>请求平台建/收窗：</p>
        <ul>
          <li>写 <code>.quick-toggle</code>（内容 <code>{"panelId":"quick"}</code>）→ 平台按面板<strong>当前可见性开/关</strong>（按一次开、再按一次必关，最可靠）。</li>
          <li>写 <code>.quick-open</code> / <code>.quick-close</code> → 显式请求弹出 / 收起。</li>
          <li>平台每 400ms 扫描各工具目录的这些标记执行。</li>
          <li>面板页自身想关闭：面板页脚本 <code>fetch("/api/panel-close")</code>（面板页与你的后端同源）即可。</li>
        </ul>
        <pre><code>// 剪贴板示例 app.js：收到 toggle-quick 时请求平台“开/关”面板
server.route("/__platform/shortcut", (req, res, body) => {
  const j = JSON.parse(body || "{}");
  if (j.action === "toggle-quick") {
    fs.writeFileSync(path.join(__dirname, ".quick-toggle"),
      JSON.stringify({ panelId: "quick" }));
  }
  res.json({ ok: true });
});</code></pre>
      </section>

      <section class="block">
        <h2>原生“另存为”弹窗：给工具的文件存盘通道</h2>
        <p>工具界面是沙盒 <code>iframe</code>，网页的 <code>showSaveFilePicker</code> 会 <code>SecurityError</code>，静默下载也可能被沙盒拦掉。需要让用户选位置存文件时，走<strong>文件桥</strong>（和面板标记同模式）：工具后端写请求文件 → 平台弹原生“另存为” → 结果回写响应文件。</p>
        <pre><code>// 工具后端 app.js —— 请求平台弹“另存为”存一段文本
const reqId = crypto.randomBytes(8).toString("hex");
fs.writeFileSync(path.join(__dirname, ".save-request.json"),
  JSON.stringify({ id: reqId, filename: "导出.json", content: text }));
// 之后轮询 .save-response.json（同 id）：
// { id, ok: true, path } 或 { id, ok: false, error }，读到后删掉响应文件</code></pre>
        <ul>
          <li>文件名会被消毒（只留本体，防目录穿越），内容上限 5MB。</li>
          <li>用户取消也算一种正常返回（<code>ok: false, error: "用户取消"</code>），前端别当报错弹。</li>
          <li>平台每 400ms 扫描一次；前端拿不到响应超过 120 秒就提示用户重试（一般是平台版本太旧）。</li>
          <li>网页弹窗 → 平台原生弹窗 → 静默下载，三档兜底都写上，用户体验最稳。</li>
        </ul>
      </section>

      <section class="block">
        <h2>给自己的工具加「全局快捷键 / 悬浮面板」</h2>
        <ol>
          <li>在 <code>manifest.json</code> 加 <code>shortcuts</code>（声明快捷键）和可选 <code>panels</code>（声明悬浮面板）。</li>
          <li>重启平台，或到 <strong>更多 ▾ → 全局快捷键</strong> 页点「刷新」，快捷键即完成注册（冲突项会标红）。</li>
          <li>把面板页（如 <code>quick.html</code>）放进工具目录 —— 它与 <code>index.html</code> 共用同一个后端端口，能直接 <code>fetch</code> 自己的 <code>/api/*</code>。</li>
          <li>在 <code>app.js</code> 加 <code>/__platform/shortcut</code> 路由处理你的动作；需要弹/收面板时就写 <code>.quick-open</code> / <code>.quick-close</code> 标记。</li>
        </ol>
        <p class="note">这是纯工具层配置，不需要改平台源码；剪贴板历史就是这套机制的完整示例。</p>
      </section>

      <section class="block">
        <h2>剪贴板历史工具（示例）</h2>
        <p>这是平台内置的一个实用示例工具，展示“后台常驻 + 全局快捷键 + 持久化”的完整用法：</p>
        <ul>
          <li>后台记录复制的<strong>文字 / 图片 / 文件</strong>；全局去重只留最新。</li>
          <li>支持搜索、类型筛选、置顶、单条删除、清空、来源显示。</li>
          <li>保存条数 / 图片张数可调（默认 200 / 50），重启保留。</li>
        </ul>
      </section>

      <section class="block">
        <h2>多号签到工具（示例）</h2>
        <p>WorkBuddy / Trae 多账户自动签到，展示“后台常驻 + 定时任务 + 文件桥导出”的组合用法，放在 <code>example/quota-pool/</code>：</p>
        <ul>
          <li><strong>快捷登录</strong>：WorkBuddy 点“一键导入本机登录态”（直接读客户端会话文件）；Trae 点“生成登录链接”→ 浏览器登录 → 粘贴回调地址，全程不用下脚本，还自带 <code>refreshToken</code>。</li>
          <li><strong>自动签到</strong>：每天指定时间跑一次，已签跳过；到点没开机下次启动 30 秒内补签；临时错误自动重试 3 次（间隔 10s/30s），token 过期、9074 这类致命错误直接标红。</li>
          <li><strong>单实例定时锁</strong>：<code>scheduler.lock</code> 保证同一时间只有一个进程跑定时，多开只提供界面。</li>
          <li><strong>导入/导出</strong>：账户池可导出 JSON 迁移（导出走上面的三档存盘通道），导入按“同类型+同备注”去重。</li>
          <li><strong>额度口径</strong>：剩余额度走用量/资源接口，WorkBuddy 按“周期剩”汇总（和客户端一致），分包明细可展开对账。</li>
        </ul>
      </section>

      <section class="block">
        <h2>常见问题</h2>
        <ul>
          <li>
            <strong>手动放进 toolbox 的目录报「缺少 manifest.json」？</strong>
            只要目录里有 <code>index.html</code>，平台现在会<strong>自动按本地网页工具接管</strong>
            并补生成一份 manifest.json；两者都没有才会报错。也可以用
            「新建 ▾ → 添加网址 / 本地网页」导入。
          </li>
          <li>
            <strong>端口冲突？</strong> <code>port: 0</code> 会自动分配<strong>并记住</strong>、
            之后一直复用，不再每次更换。若该端口被别人占用，打开工具时会弹窗让你选
            「重试启动」或「重新分配端口」，详见上面「端口与本地存储」。
          </li>
          <li>
            <strong>能不能用外部编辑器？</strong> 可以，工具目录就在
            <code>%APPDATA%\com.tools.platform\toolbox\</code>，外部写好后点「刷新」即可。
          </li>
          <li><strong>工具能互相通信吗？</strong> 默认隔离；如需共享数据，可把中间结果写到文件或调用对方的 <code>127.0.0.1:端口</code>。</li>
          <li>
            <strong>导出没弹「另存为」？</strong> 沙盒里网页弹窗一定会被禁，这是预期的三档兜底：
            先看提示条里的原因；平台够新会自动走原生弹窗；都没有才落默认下载目录。
          </li>
          <li><strong>后台出现两个平台？</strong> 见上面「单实例」一节：只留一个进程，托盘残留图标悬停即消失。</li>
        </ul>
      </section>
    </main>
  </div>
</template>

<style scoped>
.tutorial {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  background: var(--bg-panel);
  border-bottom: 1px solid var(--border);
}
.title {
  font-weight: 600;
}
.spacer {
  flex: 1;
}
.body {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
  max-width: 860px;
  margin: 0 auto;
  width: 100%;
}
.block {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 22px;
  margin-bottom: 16px;
}
.block h2 {
  font-size: 16px;
  margin-bottom: 10px;
}
.block .sub {
  font-size: 14px;
  font-weight: 600;
  margin: 14px 0 6px;
  color: var(--text);
}
.block p,
.block li {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text);
}
.block ol,
.block ul {
  padding-left: 20px;
}
.block li {
  margin-bottom: 4px;
}
code {
  background: rgba(79, 110, 247, 0.1);
  border-radius: 4px;
  padding: 1px 5px;
  font-family: Consolas, Menlo, monospace;
  font-size: 12px;
  color: var(--accent);
}
pre {
  background: #282c34;
  color: #e6e8ec;
  border-radius: 8px;
  padding: 14px 16px;
  overflow-x: auto;
  margin: 10px 0;
}
pre code {
  background: transparent;
  color: inherit;
  padding: 0;
  font-size: 12.5px;
  line-height: 1.6;
}
.note {
  font-size: 12px;
  color: var(--text-dim);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
  margin: 8px 0;
}
th,
td {
  text-align: left;
  padding: 7px 10px;
  border-bottom: 1px solid var(--border);
}
th {
  color: var(--text-dim);
  font-weight: 500;
}
</style>
