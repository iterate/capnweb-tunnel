const storagePrefix = "captun-browser-demo:";
const defaultHandler = `async function fetch(request, context) {
  const url = new URL(request.url);
  const headers = new Headers(context.corsHeaders);
  headers.set("content-type", "application/json; charset=utf-8");

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: context.corsHeaders });
  }

  const body = request.method === "GET" || request.method === "HEAD"
    ? null
    : await request.text();

  context.log("handled " + request.method + " " + url.pathname);

  return new Response(JSON.stringify({
    ok: true,
    message: "Hello from a Captun browser tunnel",
    tunnel: context.tunnelName,
    method: request.method,
    pathname: url.pathname,
    search: url.search,
    body
  }, null, 2), { headers });
}`;

const elements = {
  serverUrl: document.querySelector("#serverUrl"),
  tunnelName: document.querySelector("#tunnelName"),
  secret: document.querySelector("#secret"),
  secretNotice: document.querySelector("#secretNotice"),
  connectionForm: document.querySelector("#connectionForm"),
  handlerSource: document.querySelector("#handlerSource"),
  connect: document.querySelector("#connect"),
  disconnect: document.querySelector("#disconnect"),
  status: document.querySelector("#status"),
  publicUrl: document.querySelector("#publicUrl"),
  openPublicUrl: document.querySelector("#openPublicUrl"),
  copyPublicUrl: document.querySelector("#copyPublicUrl"),
  newName: document.querySelector("#newName"),
  probeMethod: document.querySelector("#probeMethod"),
  probePath: document.querySelector("#probePath"),
  probeBody: document.querySelector("#probeBody"),
  sendProbe: document.querySelector("#sendProbe"),
  probeOutput: document.querySelector("#probeOutput"),
  logList: document.querySelector("#logList"),
  clearLog: document.querySelector("#clearLog"),
};

let activeTunnel;
let activePublicUrl = "";
let requestCount = 0;
let createTunnel;

initialize();

function initialize() {
  elements.serverUrl.value = storedValue("serverUrl", "");
  elements.tunnelName.value = storedValue("tunnelName", randomTunnelName());
  elements.handlerSource.value = storedValue("handlerSource", defaultHandler);
  elements.probePath.value = storedValue("probePath", "/health");

  elements.serverUrl.addEventListener("input", persistSettings);
  elements.tunnelName.addEventListener("input", persistSettings);
  elements.handlerSource.addEventListener("input", persistSettings);
  elements.probePath.addEventListener("input", persistSettings);
  elements.secret.addEventListener("input", updateSecretNotice);
  elements.connectionForm.addEventListener("submit", (event) => event.preventDefault());
  elements.connect.addEventListener("click", connect);
  elements.disconnect.addEventListener("click", disconnect);
  elements.copyPublicUrl.addEventListener("click", copyPublicUrl);
  elements.openPublicUrl.addEventListener("click", openPublicUrl);
  elements.newName.addEventListener("click", useNewTunnelName);
  elements.sendProbe.addEventListener("click", sendProbe);
  elements.clearLog.addEventListener("click", clearLog);
  elements.handlerSource.addEventListener("keydown", insertTabInTextarea);
  window.addEventListener("beforeunload", disposeActiveTunnel);

  updateSecretNotice();
  setDisconnected();
  appendLog("connection", "Ready");
}

async function connect() {
  if (activeTunnel) return;

  const serverUrl = elements.serverUrl.value.trim();
  const tunnelName = elements.tunnelName.value.trim();
  const secret = elements.secret.value.trim();

  if (!serverUrl) {
    setError("Enter a Captun server URL");
    return;
  }

  if (!isValidTunnelName(tunnelName)) {
    setError("Use a lowercase tunnel name with letters, numbers, and dashes");
    return;
  }

  if (secret) {
    setError("Browser WebSocket clients cannot send bearer headers");
    appendLog(
      "error",
      "Bearer secret was not sent",
      "Use a Captun Worker without CAPTUN_SECRET for this browser demo, or use the Node CLI for secret-protected tunnels.",
    );
    return;
  }

  try {
    compileHandler();
  } catch (error) {
    setError("Handler did not compile");
    appendLog("error", "Handler did not compile", formatError(error));
    return;
  }

  let publicUrl;
  try {
    publicUrl = buildPublicUrl(serverUrl, tunnelName);
  } catch (error) {
    setError("Server URL is invalid");
    appendLog("error", "Server URL is invalid", formatError(error));
    return;
  }

  setConnecting();
  appendLog("connection", "Connecting to " + connectUrl(publicUrl));

  try {
    const createBrowserCaptunTunnel = await loadBrowserClient();
    activeTunnel = await createBrowserCaptunTunnel({
      url: connectUrl(publicUrl),
      fetch: (request) => handleTunnelRequest(request, tunnelName),
    });
    activePublicUrl = publicUrl;
    setConnected(publicUrl);
    persistSettings();
    appendLog("connection", "Connected", publicUrl);
  } catch (error) {
    activeTunnel = undefined;
    activePublicUrl = "";
    setError("Connection failed");
    appendLog("error", "Connection failed", formatError(error));
  }
}

function disconnect() {
  if (!activeTunnel) return;
  disposeActiveTunnel();
  appendLog("connection", "Disconnected");
  setDisconnected();
}

async function handleTunnelRequest(request, tunnelName) {
  const id = requestCount + 1;
  requestCount = id;

  const url = new URL(request.url);
  appendLog("request", "#" + id + " " + request.method + " " + url.pathname + url.search);

  try {
    const handler = compileHandler();
    const response = await normalizeResponse(
      await handler(request, {
        corsHeaders: corsHeaders(),
        log(message) {
          appendLog("handler", "#" + id + " " + message);
        },
        publicUrl: activePublicUrl,
        requestId: id,
        tunnelName,
      }),
    );
    appendLog("response", "#" + id + " " + response.status + " " + response.statusText);
    return response;
  } catch (error) {
    appendLog("error", "#" + id + " handler error", formatError(error));
    return jsonErrorResponse(error);
  }
}

function compileHandler() {
  const source = elements.handlerSource.value.trim();
  const value = Function('"use strict"; return (' + source + ");")();

  if (typeof value === "function") return value;
  if (value && typeof value.fetch === "function") return value.fetch.bind(value);

  throw new Error("Handler source must evaluate to a function or an object with fetch().");
}

async function normalizeResponse(value) {
  const resolved = await value;
  if (resolved instanceof Response) return resolved;
  if (
    typeof resolved === "string" ||
    resolved instanceof Blob ||
    resolved instanceof ReadableStream ||
    resolved instanceof Uint8Array
  ) {
    return new Response(resolved);
  }

  throw new Error("Handler must return a Response, string, Blob, ReadableStream, or Uint8Array.");
}

async function sendProbe() {
  if (!activePublicUrl) {
    appendLog("error", "Connect before sending a probe request");
    return;
  }

  const method = elements.probeMethod.value;
  const url = probeUrl(activePublicUrl, elements.probePath.value);
  const init = { method };

  if (method !== "GET" && method !== "HEAD") {
    init.body = elements.probeBody.value;
    init.headers = { "content-type": "text/plain; charset=utf-8" };
  }

  elements.sendProbe.disabled = true;
  elements.probeOutput.value = "Sending " + method + " " + url;
  appendLog("request", "probe " + method + " " + url);

  try {
    const response = await fetch(url, init);
    const text = method === "HEAD" ? "" : await response.text();
    elements.probeOutput.value = [
      response.status + " " + response.statusText,
      "",
      text,
    ].join("\n");
    appendLog("response", "probe " + response.status + " " + response.statusText);
  } catch (error) {
    elements.probeOutput.value = formatError(error);
    appendLog("error", "Probe failed", formatError(error));
  } finally {
    elements.sendProbe.disabled = false;
  }
}

async function copyPublicUrl() {
  if (!activePublicUrl) return;

  try {
    await navigator.clipboard.writeText(activePublicUrl);
    appendLog("connection", "Copied public URL");
  } catch {
    elements.publicUrl.select();
    document.execCommand("copy");
    appendLog("connection", "Copied public URL");
  }
}

function openPublicUrl(event) {
  if (!activePublicUrl) {
    event.preventDefault();
    return;
  }
  elements.openPublicUrl.href = activePublicUrl;
}

function useNewTunnelName() {
  elements.tunnelName.value = randomTunnelName();
  persistSettings();
}

function clearLog() {
  elements.logList.replaceChildren();
  appendLog("connection", "Log cleared");
}

async function loadBrowserClient() {
  if (createTunnel) return createTunnel;
  createTunnel = window.createBrowserCaptunTunnel;
  if (typeof createTunnel !== "function") {
    throw new Error("Browser Captun client did not load.");
  }
  return createTunnel;
}

function setConnecting() {
  elements.status.textContent = "Connecting";
  elements.status.dataset.status = "connecting";
  elements.connect.disabled = true;
  elements.disconnect.disabled = true;
  elements.sendProbe.disabled = true;
}

function setConnected(publicUrl) {
  elements.status.textContent = "Connected";
  elements.status.dataset.status = "connected";
  elements.connect.disabled = true;
  elements.disconnect.disabled = false;
  elements.sendProbe.disabled = false;
  elements.publicUrl.value = publicUrl;
  elements.openPublicUrl.href = publicUrl;
  elements.openPublicUrl.setAttribute("aria-disabled", "false");
  elements.copyPublicUrl.disabled = false;
}

function setDisconnected() {
  elements.status.textContent = "Disconnected";
  elements.status.dataset.status = "disconnected";
  elements.connect.disabled = false;
  elements.disconnect.disabled = true;
  elements.sendProbe.disabled = true;
  elements.publicUrl.value = "";
  elements.openPublicUrl.href = "#";
  elements.openPublicUrl.setAttribute("aria-disabled", "true");
  elements.copyPublicUrl.disabled = true;
}

function setError(message) {
  elements.status.textContent = message;
  elements.status.dataset.status = "error";
  elements.connect.disabled = false;
  elements.disconnect.disabled = !activeTunnel;
  elements.sendProbe.disabled = !activePublicUrl;
}

function disposeActiveTunnel() {
  const tunnel = activeTunnel;
  activeTunnel = undefined;
  activePublicUrl = "";
  if (!tunnel) return;
  if (typeof tunnel.close === "function") tunnel.close();
  else if (Symbol.dispose in tunnel) tunnel[Symbol.dispose]();
}

function updateSecretNotice() {
  const hasSecret = Boolean(elements.secret.value.trim());
  elements.secretNotice.hidden = !hasSecret;
}

function buildPublicUrl(serverUrl, tunnelName) {
  if (serverUrl.includes("{name}")) {
    return trimTrailingSlash(serverUrl.replaceAll("{name}", encodeURIComponent(tunnelName)));
  }

  const url = new URL(serverUrl);
  url.hash = "";
  url.search = "";
  url.pathname = "/" + encodeURIComponent(tunnelName);
  return trimTrailingSlash(url.href);
}

function connectUrl(publicUrl) {
  return publicUrl + "/__captun-connect";
}

function probeUrl(publicUrl, inputPath) {
  const url = new URL(publicUrl);
  const path = inputPath.trim() || "/";
  const suffix = path.startsWith("/") ? path : "/" + path;
  const basePath = trimTrailingSlash(url.pathname);

  if (suffix === "/") url.pathname = basePath || "/";
  else url.pathname = (basePath + suffix).replace(/\/{2,}/g, "/");

  return url.href;
}

function corsHeaders() {
  return {
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    "access-control-allow-origin": "*",
  };
}

function jsonErrorResponse(error) {
  const headers = new Headers(corsHeaders());
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(
    JSON.stringify(
      {
        error: formatError(error),
      },
      null,
      2,
    ),
    { status: 500, headers },
  );
}

function appendLog(kind, message, detail) {
  const row = document.createElement("li");
  const timestamp = document.createElement("time");
  const label = document.createElement("span");
  const text = document.createElement("span");

  row.className = "log-row";
  row.dataset.kind = kind;
  timestamp.dateTime = new Date().toISOString();
  timestamp.textContent = new Date().toLocaleTimeString();
  label.className = "log-kind";
  label.textContent = kind;
  text.textContent = message;

  row.append(timestamp, label, text);

  if (detail) {
    const detailBlock = document.createElement("pre");
    detailBlock.textContent = detail;
    row.append(detailBlock);
  }

  elements.logList.prepend(row);

  while (elements.logList.children.length > 120) {
    elements.logList.lastElementChild.remove();
  }
}

function persistSettings() {
  localStorage.setItem(storagePrefix + "serverUrl", elements.serverUrl.value.trim());
  localStorage.setItem(storagePrefix + "tunnelName", elements.tunnelName.value.trim());
  localStorage.setItem(storagePrefix + "handlerSource", elements.handlerSource.value);
  localStorage.setItem(storagePrefix + "probePath", elements.probePath.value.trim());
}

function storedValue(key, fallback) {
  return localStorage.getItem(storagePrefix + key) || fallback;
}

function isValidTunnelName(name) {
  return /^[a-z0-9][a-z0-9-]{0,62}$/.test(name) && !name.endsWith("-");
}

function randomTunnelName() {
  const adjectives = ["amber", "brisk", "clear", "direct", "fresh", "plain"];
  const nouns = ["bridge", "hook", "path", "relay", "route", "signal"];
  const adjective = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const suffix = Math.random().toString(36).slice(2, 8);
  return adjective + "-" + noun + "-" + suffix;
}

function insertTabInTextarea(event) {
  if (event.key !== "Tab") return;

  event.preventDefault();
  const textarea = event.currentTarget;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  textarea.value = textarea.value.slice(0, start) + "  " + textarea.value.slice(end);
  textarea.selectionStart = start + 2;
  textarea.selectionEnd = start + 2;
  persistSettings();
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function formatError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}
