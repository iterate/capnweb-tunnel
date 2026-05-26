import { HOSTED_CAPTUN_HOSTNAME, isLoopbackHostname, RESERVED_TUNNEL_NAMES } from "../routing.js";

export function hostedCaptunResponse(request: Request): Response | undefined {
  const url = new URL(request.url);
  if (isLoopbackHostname(url.hostname) && isWwwCaptunPath(url.pathname)) {
    return wwwCaptunResponse(url);
  }

  if (url.hostname === HOSTED_CAPTUN_HOSTNAME) {
    return Response.redirect(
      `https://www.${HOSTED_CAPTUN_HOSTNAME}${url.pathname}${url.search}`,
      308,
    );
  }

  const suffix = `.${HOSTED_CAPTUN_HOSTNAME}`;
  if (!url.hostname.endsWith(suffix)) return undefined;

  const labels = url.hostname.slice(0, -suffix.length).split(".");
  const subdomain = labels[labels.length - 1] || "";
  if (subdomain === "www") {
    return wwwCaptunResponse(url);
  }
  if (RESERVED_TUNNEL_NAMES.includes(subdomain)) {
    return new Response("Reserved Captun tunnel name\n", { status: 404 });
  }
}

function isWwwCaptunPath(pathname: string) {
  return pathname === "/" || pathname === "/captun.browser.js" || pathname === "/favicon.svg";
}

function wwwCaptunResponse(url: URL): Response {
  if (url.pathname === "/captun.browser.js") {
    return new Response(WWW_BROWSER_MODULE, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  if (url.pathname === "/favicon.svg") {
    return new Response(WWW_FAVICON, {
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  return new Response(WWW_LANDING_PAGE, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const FROM_CODE_SOURCE = js`
import { createCaptunTunnel } from "captun";

const tunnel = await createCaptunTunnel({
  fetch: (request) => {
    const url = new URL(request.url);
    return Response.json({ method: request.method, path: url.pathname });
  },
});

console.log(tunnel.url);
`;

const HELLO_WORLD_DEMO_SOURCE = js`
createCaptunTunnel({
  fetch: () => new Response("hello world from this browser tab\n"),
});
`;

const CHAT_ROOM_DEMO_SOURCE = js`
createCaptunTunnel({
  fetch: async (request) => {
    // your "server" is this browser tab!
    window.chatMessages ||= [];
    if (request.method === "POST") {
      window.chatMessages.push(await request.text());
      return Response.json({ ok: true });
    }

    const messages = window.chatMessages
      .join("\n")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;")
      .replace(new RegExp(String.fromCharCode(96), "g"), "&#96;");

    return new Response(
      [
        "<script>",
        "  let username = document.cookie.match(/username=([^;]+)/)?.[1];",
        "  username ||= 'user' + Math.random().toString().slice(2, 8);",
        "  document.cookie = 'username=' + username + '; Path=/; Secure';",
        "  function send(form) {",
        "    fetch('/', { method: 'POST', body: username + ': ' + form.m.value }).then(() => location.reload());",
        "  }",
        "</script>",
        "<pre>" + messages + "</pre>",
        "<form onsubmit=\\"send(this); return false\\">",
        "  <input name=\\"m\\" style=\\"font-size:16px\\" autofocus><button>send</button>",
        "</form>",
      ].join("\n"),
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  },
});
`;

const MCP_SERVER_DEMO_SOURCE = js`
const { z } = await import("https://esm.sh/zod@3.25.76");
const { McpServer } = await import(
  "https://esm.sh/@modelcontextprotocol/sdk@1.29.0/server/mcp.js?deps=zod@3.25.76"
);
const { WebStandardStreamableHTTPServerTransport } = await import(
  "https://esm.sh/@modelcontextprotocol/sdk@1.29.0/server/webStandardStreamableHttp.js?deps=zod@3.25.76"
);

for (const transport of window.mcpTransports?.values() || []) {
  await transport.close?.();
}
window.mcpTransports = new Map();

createCaptunTunnel({
  fetch: async (request) => {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    const sessionId = request.headers.get("mcp-session-id");
    const transport = window.mcpTransports.get(sessionId) || await createMcpTransport();
    const response = await transport.handleRequest(request);
    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) window.mcpTransports.set(responseSessionId, transport);
    return withCors(response);
  },
});

function withCors(response) {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "accept, authorization, content-type, mcp-protocol-version, mcp-session-id");
  response.headers.set("Access-Control-Expose-Headers", "mcp-session-id");
  return response;
}

async function createMcpTransport() {
  const mcpServer = new McpServer({
    name: "browser-tab-mcp",
    version: "1.0.0",
  });

  mcpServer.registerTool(
    "ask_question",
    {
      description: "Ask a question in the browser tab that owns this MCP server.",
      inputSchema: {
        question: z.string().describe("Question to ask in the browser prompt."),
      },
    },
    async ({ question }) => {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const answer = window.prompt(question) || "";
      return {
        content: [{ text: answer, type: "text" }],
        structuredContent: { answer },
      };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await mcpServer.connect(transport);
  return transport;
}
`;

const LANDING_PAGE_SCRIPT_SOURCE = js`
const fromCodeSource = document.querySelector("#from-code-source");
const fromCodeEditorHost = document.querySelector("#from-code-editor");
const description = document.querySelector("#demo-description");
const source = document.querySelector("#demo-source");
const editorHost = document.querySelector("#demo-editor");
const snippetButtons = Array.from(document.querySelectorAll("[data-demo-snippet]"));
const button = document.querySelector("#demo-create");
const reload = document.querySelector("#demo-reload");
const status = document.querySelector("#demo-status");
const urlRow = document.querySelector("#demo-url");
const link = document.querySelector("#demo-link");
const frame = document.querySelector("#demo-frame");
const error = document.querySelector("#demo-error");
let tunnel;
let activeFetch;
let editor;
void enhanceEditor();
const captunBrowser = import("/captun.browser.js");
const snippets = {
  hello: {
    description: "Return a tiny text response from this browser tab.",
    path: "",
    source: source.value,
  },
  chat: {
    description: "Run the chat room currently on captun.sh from this browser tab.",
    path: "",
    source: document.querySelector("#demo-chat-source").value,
  },
  mcp: {
    description: "Run an MCP server from this browser tab. Use the shown URL in MCP Inspector.",
    path: "/mcp",
    source: document.querySelector("#demo-mcp-source").value,
  },
};
let activeSnippet = "hello";

function currentSource() {
  return editor ? editor.state.doc.toString() : source.value;
}

async function evaluateDemo() {
  let capturedFetch;
  const createCaptunTunnel = (options) => {
    capturedFetch = options.fetch;
    return Promise.resolve({ url: tunnel ? tunnel.url : "https://pending.captun.sh" });
  };
  await new Function(
    "createCaptunTunnel",
    "return (async () => {\n" + currentSource() + "\n})()",
  )(createCaptunTunnel);
  if (typeof capturedFetch !== "function") {
    throw new Error("Call createCaptunTunnel({ fetch }) in the editor.");
  }
  activeFetch = capturedFetch;
}

async function refreshTunnelFromSource() {
  if (!tunnel) return;
  try {
    await evaluateDemo();
    status.textContent = "updated";
    error.textContent = "";
    showTunnelTarget(tunnel.url);
  } catch (caught) {
    status.textContent = "edit has an error";
    error.textContent = caught && caught.stack ? caught.stack : String(caught);
  }
}

function switchSnippet(name) {
  const snippet = snippets[name];
  if (!snippet) return;
  activeSnippet = name;
  description.innerText = snippet.description;
  for (const snippetButton of snippetButtons) {
    snippetButton.setAttribute("aria-pressed", String(snippetButton.dataset.demoSnippet === name));
  }
  setSource(snippet.source);
  if (!editor) void refreshTunnelFromSource();
}

function setSource(nextSource) {
  if (!editor) {
    source.value = nextSource;
    return;
  }
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: nextSource },
  });
}

function tunnelUrlForActiveSnippet(tunnelUrl) {
  return tunnelUrl.replace(/\/$/, "") + snippets[activeSnippet].path;
}

function showTunnelTarget(tunnelUrl) {
  const url = tunnelUrlForActiveSnippet(tunnelUrl);
  link.href = url;
  link.textContent = url;
  if (snippets[activeSnippet].path === "/mcp") {
    frame.removeAttribute("src");
    frame.srcdoc = previewHtml(url);
    return;
  }

  frame.removeAttribute("srcdoc");
  frame.src = url;
}

source.addEventListener("input", () => void refreshTunnelFromSource());
for (const snippetButton of snippetButtons) {
  snippetButton.addEventListener("click", () => switchSnippet(snippetButton.dataset.demoSnippet));
}
reload.addEventListener("click", () => {
  if (tunnel) showTunnelTarget(tunnel.url);
});

button.addEventListener("click", async () => {
  const startedAt = performance.now();
  button.disabled = true;
  reload.disabled = true;
  status.textContent = "connecting";
  error.textContent = "";

  try {
    if (tunnel) tunnel.close();
    await evaluateDemo();
    const { createCaptunTunnel } = await captunBrowser;
    const options = { fetch: (request) => activeFetch(request) };
    tunnel = await createCaptunTunnel(options);
    urlRow.classList.remove("hidden");
    showTunnelTarget(tunnel.url);
    status.textContent = "connected in " + Math.round(performance.now() - startedAt) + "ms";
    reload.disabled = false;
  } catch (caught) {
    status.textContent = "failed";
    error.textContent = caught && caught.stack ? caught.stack : String(caught);
  } finally {
    button.disabled = false;
  }
});

function previewHtml(url) {
  return "<pre>MCP server listening at\n" + escapeHtml(url) + "\n\nUse ask_question to prompt this browser tab and return the answer.</pre>";
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function enhanceEditor() {
  try {
    const [{ EditorView, basicSetup }, { javascript }] = await Promise.all([
      import("https://esm.sh/codemirror@6.0.1"),
      import("https://esm.sh/@codemirror/lang-javascript@6.2.4"),
    ]);
    new EditorView({
      doc: fromCodeSource.value,
      extensions: [basicSetup, javascript(), EditorView.editable.of(false)],
      parent: fromCodeEditorHost,
    });
    editor = new EditorView({
      doc: source.value,
      extensions: [basicSetup, javascript(), EditorView.updateListener.of((update) => {
        if (update.docChanged) void refreshTunnelFromSource();
      })],
      parent: editorHost,
    });
    fromCodeSource.classList.add("enhanced");
    fromCodeEditorHost.classList.add("enhanced");
    source.classList.add("enhanced");
    editorHost.classList.add("enhanced");
  } catch (caught) {
    console.warn("CodeMirror failed to load; using textarea editor.", caught);
  }
}
`;

const WWW_LANDING_PAGE = landingPageHtml();

function landingPageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>captun</title>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <style>
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
    body { max-width: 840px; margin: 56px auto; padding: 0 20px 48px; font: 16px/1.55 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111; background: #fff; }
    h1 { font-size: 28px; margin: 0 0 24px; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    pre, #from-code-source, #demo-source { padding: 12px 14px; overflow-x: auto; background: #f4f4f4; border: 1px solid #ddd; border-radius: 0; }
    #from-code-source, #demo-source { width: 100%; resize: vertical; font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: inherit; display: block; }
    #from-code-source { min-height: 210px; }
    #demo-source { min-height: 300px; }
    #from-code-source.enhanced, #demo-source.enhanced { display: none; }
    #from-code-editor, #demo-editor { display: none; border: 1px solid #ddd; background: #f4f4f4; }
    #from-code-editor.enhanced, #demo-editor.enhanced { display: block; }
    #from-code-editor .cm-editor, #demo-editor .cm-editor { background: #f4f4f4; font: 16px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    #from-code-editor .cm-scroller { min-height: 210px; }
    #demo-editor .cm-scroller { min-height: 300px; }
    .snippet-tabs { display: flex; align-items: stretch; margin: 12px 0 0; border: 1px solid #ddd; border-bottom: 0; background: #eee; }
    .snippet-tab { margin: 0; padding: 7px 10px; color: #111; background: #fff; border: 0; border-right: 1px solid #ddd; }
    .snippet-tab[aria-pressed="true"] { color: #fff; background: #111; }
    .snippet-tabs + #demo-source { border-top: 0; }
    .snippet-tabs + #demo-source.enhanced + #demo-editor.enhanced { border-top: 0; }
    button { margin: 12px 0; padding: 9px 12px; font: inherit; color: #fff; background: #111; border: 1px solid #111; cursor: pointer; }
    button:disabled { opacity: 0.55; cursor: wait; }
    .status-group { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; white-space: nowrap; }
    .icon-button { width: 36px; height: 36px; margin: 0; padding: 0; align-items: center; justify-content: center; background: #fff; color: #111; line-height: 1; }
    iframe { width: 100%; height: 180px; border: 1px solid #ddd; background: #fff; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    .muted { color: #555; }
    .error { color: #a40000; white-space: pre-wrap; }
    .hidden { display: none; }
    a { color: #0645ad; }
  </style>
</head>
<body>
  <h1>captun</h1>
  <p>cap[<a href="https://github.com/cloudflare/capnweb">nweb</a>] tun[nel]: a tiny, <a href="https://github.com/iterate/captun#performance">fast</a> public tunnel for local HTTP servers.</p>
  <p>Run this with something listening on port 3000:</p>
  <pre>npx captun 3000</pre>
  <p>You get a URL like:</p>
  <pre>https://abc123.captun.sh</pre>
  <p>Requests to that URL are forwarded to your local server until you stop the process.</p>

  <h2>From code</h2>
  <p>You don't need to run a local server. Just a fetch function:</p>
  <textarea id="from-code-source" spellcheck="false" readonly>${htmlText(FROM_CODE_SOURCE)}</textarea>
  <div id="from-code-editor"></div>

  <h2>Try it in this tab</h2>
  <p>This works in <em>any</em> environment supported by <a href="https://github.com/cloudflare/capnweb">capnweb</a>, so you can run a "server" basically anywhere, even the browser.</p>
  <p id="demo-description">Return a tiny text response from this browser tab.</p>
  <div class="snippet-tabs" role="tablist" aria-label="demo snippets">
    <button class="snippet-tab" type="button" data-demo-snippet="hello" aria-pressed="true">hello world</button>
    <button class="snippet-tab" type="button" data-demo-snippet="chat" aria-pressed="false">chat room</button>
    <button class="snippet-tab" type="button" data-demo-snippet="mcp" aria-pressed="false">mcp server</button>
  </div>
  <textarea id="demo-source" spellcheck="false">${htmlText(HELLO_WORLD_DEMO_SOURCE)}</textarea>
  <div id="demo-editor"></div>
  <textarea id="demo-chat-source" hidden>${htmlText(CHAT_ROOM_DEMO_SOURCE)}</textarea>
  <textarea id="demo-mcp-source" hidden>${htmlText(MCP_SERVER_DEMO_SOURCE)}</textarea>
  <div class="row">
    <button id="demo-create" type="button">create tunnel</button>
    <span class="status-group">
      <span id="demo-status" class="muted">idle</span>
      <button id="demo-reload" class="icon-button" type="button" aria-label="reload iframe" title="reload iframe" disabled>&#8635;</button>
    </span>
  </div>
  <p id="demo-url" class="hidden"><a id="demo-link" target="_blank" rel="noreferrer"></a></p>
  <p id="demo-error" class="error"></p>
  <iframe id="demo-frame" title="captun demo response"></iframe>

  <h2>Bring your own Cloudflare account</h2>
  <pre>npx captun deploy</pre>
  <p>Source: <a href="https://github.com/iterate/captun">github.com/iterate/captun</a></p>

  <script type="module">${htmlScript(LANDING_PAGE_SCRIPT_SOURCE)}</script>
</body>
</html>`;
}

function htmlText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function htmlScript(value: string) {
  return value.replace(/<\/script/gi, "<\\/script");
}

function stripCommonIndent(source: string) {
  const lines = source
    .replace(/^\n/, "")
    .replace(/\n\s*$/, "")
    .split("\n");
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(/^[ \t]*/);
      return match ? match[0].length : 0;
    });
  if (!indents.length) return "";

  const indent = Math.min(...indents);
  return lines.map((line) => (line.trim() ? line.slice(indent) : "")).join("\n");
}

function js(strings: TemplateStringsArray, ...values: string[]) {
  return stripCommonIndent(String.raw(strings, ...values)).trim();
}

const WWW_FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="12" fill="#111"/>
  <path d="M14 52V34a18 18 0 0 1 36 0v18h-8V34a10 10 0 0 0-20 0v18z" fill="#fff"/>
  <path d="M28 52V36a4 4 0 0 1 8 0v16z" fill="#111"/>
</svg>`;

const WWW_BROWSER_MODULE = `import { newWebSocketRpcSession, RpcTarget } from "https://esm.sh/capnweb@0.8.0";

export async function createCaptunTunnel(options) {
  const connect = gatewayConnectUrl(options);
  const socket = new WebSocket(connect.url);
  const readyPromise = waitForReady();
  const tunnelTargetFetcher = new TunnelTargetFetcher(options.fetch, readyPromise.ready);
  const session = newWebSocketRpcSession(socket, tunnelTargetFetcher);
  await waitUntilOpen(socket);
  const tunnel = await readyPromise.promise;
  return {
    url: tunnel.url,
    token: tunnel.token || connect.token,
    close: () => disposeSession(session),
  };
}

class TunnelTargetFetcher extends RpcTarget {
  constructor(fetcher, ready) {
    super();
    this.fetcher = fetcher;
    this.readyCallback = ready;
  }

  fetch(request) {
    return this.fetcher(request);
  }

  ready(tunnel) {
    return this.readyCallback(tunnel);
  }
}

function gatewayConnectUrl(options) {
  const url = new URL(options.gateway || "https://captun.sh");
  const token = options.token || randomConnectToken();
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  url.searchParams.set("captun-connect", "1");
  url.searchParams.set("captun-name", options.name || randomTunnelName());
  if (token) url.searchParams.set("captun-token", token);
  return { url, token };
}

function waitUntilOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  if (socket.readyState !== WebSocket.CONNECTING) {
    return Promise.reject(new Error("WebSocket closed before opening"));
  }

  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const settle = (callback) => {
      listeners.abort();
      callback();
    };
    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener("error", () => settle(() => reject(new Error("WebSocket connection failed"))), { signal: listeners.signal });
    socket.addEventListener("close", (event) => settle(() => reject(new Error("WebSocket closed before opening: " + event.code + " " + event.reason))), { signal: listeners.signal });
  });
}

function waitForReady() {
  let timer;
  let resolveReady;
  let rejectReady;
  const promise = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
    timer = setTimeout(() => reject(new Error("Timed out waiting for tunnel gateway")), 5000);
  });
  return {
    promise,
    ready: (tunnel) => {
      clearTimeout(timer);
      resolveReady(tunnel);
    },
    reject: rejectReady,
  };
}

function randomTunnelName() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomConnectToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function disposeSession(session) {
  const disposeSymbol = Symbol.dispose;
  if (disposeSymbol && typeof session[disposeSymbol] === "function") session[disposeSymbol]();
}
`;
