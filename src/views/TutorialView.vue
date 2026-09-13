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
        <p>
          一个工具 = <strong>一个 HTML 界面</strong>（<code>index.html</code>）+ <strong>一个 Node.js 后端</strong>（<code>app.js</code>）。
          运行时每个工具是<strong>独立的 Node 进程 + 独立的随机端口</strong>，界面由主窗口的
          iframe 加载，互不影响。你能用 Node.js 做任何事：文件读写、网络、npm 生态里的任意库。
        </p>
      </section>

      <section class="block">
        <h2>三步创建一个工具</h2>
        <ol>
          <li>主页面点「新建工具」→ 填名称 → 选模板 → 创建</li>
          <li>在编辑器中修改 <code>index.html</code>（界面）和 <code>app.js</code>（后端），Ctrl+S 保存</li>
          <li>点「运行 ▶」查看效果；需要什么库就去「依赖管理」里安装</li>
        </ol>
      </section>

      <section class="block">
        <h2>目录结构</h2>
        <pre><code>toolbox/my-tool/
├── manifest.json    # 工具元信息（必填）
├── index.html       # 工具界面（必填）
├── app.js           # 工具后端（必填，Node.js）
├── package.json     # 依赖清单（由依赖管理页维护）
└── node_modules/    # 已安装的 npm 库</code></pre>
      </section>

      <section class="block">
        <h2>manifest.json 字段</h2>
        <table>
          <tr><th>字段</th><th>说明</th></tr>
          <tr><td><code>id</code></td><td>唯一标识，仅小写字母/数字/-/_</td></tr>
          <tr><td><code>name</code></td><td>显示名称</td></tr>
          <tr><td><code>version</code></td><td>版本号</td></tr>
          <tr><td><code>description</code></td><td>一句话描述（显示在启动器卡片上）</td></tr>
          <tr><td><code>main</code></td><td>后端入口 JS，如 <code>app.js</code></td></tr>
          <tr><td><code>html</code></td><td>界面文件，如 <code>index.html</code></td></tr>
          <tr><td><code>port</code></td><td>0 = 运行时随机分配（推荐）</td></tr>
        </table>
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
        </ul>
      </section>

      <section class="block">
        <h2>后台挂起 &amp; 系统托盘</h2>
        <p>点右上角「关闭 (×)」时，会弹出「转入后台 / 退出程序」选择，并可用「记住我的选择，不再询问」。</p>
        <ul>
          <li><strong>转入后台</strong>：窗口隐藏、继续在托盘运行，宿主与后台工具不中断；托盘<strong>左键单击/双击</strong>可重新打开主界面。</li>
          <li><strong>退出程序</strong>：真正结束，会停止宿主与所有工具进程。</li>
          <li>托盘<strong>右键</strong>菜单：显示主界面 / <strong>后台工具 ▸</strong>（点击直达某工具）/ 退出程序。</li>
          <li>这个记忆选择可在 <strong>主界面 → ⚙️ 设置</strong> 里随时修改。</li>
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
        <h2>全局快捷键（manifest 声明 + 统一管理）</h2>
        <p><strong>任意工具</strong>都可以在 <code>manifest.json</code> 里用 <code>shortcuts</code> 数组声明<strong>多个</strong>全局快捷键，每个对应一个不同动作。平台启动时读取并按你声明的组合键注册为<strong>系统级全局快捷键</strong>。</p>
        <pre><code>// manifest.json —— 声明一把快捷键
"shortcuts": [
  { "id": "toggle-quick", "name": "唤起 / 收起快速面板",
    "accel": "ctrl+shift+v", "action": "toggle-quick" }
]</code></pre>
        <ul>
          <li>所有工具的快捷键集中在 <strong>主界面 → ⌨️ 快捷键</strong> 统一查看、修改、恢复默认，改动即时生效。</li>
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
        <h2>给自己的工具加「全局快捷键 / 悬浮面板」</h2>
        <ol>
          <li>在 <code>manifest.json</code> 加 <code>shortcuts</code>（声明快捷键）和可选 <code>panels</code>（声明悬浮面板）。</li>
          <li>重启平台，或到 <strong>⌨️ 快捷键</strong> 页点「刷新」，快捷键即完成注册（冲突项会标红）。</li>
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
        <h2>常见问题</h2>
        <ul>
          <li><strong>id 不能改吗？</strong> 可以，但只能用小写字母/数字/<code>-</code>/<code>_</code>，且 id 就是目录名。</li>
          <li><strong>端口冲突？</strong> 用默认 <code>port: 0</code>，运行时自动分配空闲端口。</li>
          <li><strong>能不能用外部编辑器？</strong> 可以，工具目录就在 <code>%APPDATA%\com.tools.platform\toolbox\</code>，外部写好后点「刷新」即可。</li>
          <li><strong>工具能互相通信吗？</strong> 默认隔离；如需共享数据，可把中间结果写到文件或调用对方的 <code>127.0.0.1:端口</code>。</li>
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
