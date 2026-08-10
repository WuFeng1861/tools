<script setup lang="ts">
import { useRouter } from "vue-router";

const router = useRouter();
</script>

<template>
  <div class="tutorial">
    <header class="topbar">
      <button class="ghost" @click="router.push('/')">← 返回</button>
      <span class="title">📖 新建工具教程</span>
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
