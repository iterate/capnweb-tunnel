// Browser-only Captun client for docs/browser-demo.html.
// This mirrors src/client.ts, but avoids depending on an unpublished captun npm package.
window.createBrowserCaptunTunnel = createBrowserCaptunTunnel;

async function createBrowserCaptunTunnel(options) {
  const { newWebSocketRpcSession, RpcTarget } = await import(
    "https://esm.sh/capnweb@0.8.0?bundle"
  );
  const socket = new WebSocket(toWebSocketUrl(options.url));
  const session = newWebSocketRpcSession(
    socket,
    new (browserLocalFetcher(RpcTarget))(options.fetch),
  );

  try {
    await waitUntilOpen(socket);
  } catch (error) {
    disposeSession(session);
    throw error;
  }

  return {
    [Symbol.dispose]() {
      disposeSession(session);
    },
    close() {
      disposeSession(session);
    },
  };
}

function browserLocalFetcher(RpcTarget) {
  return class BrowserLocalFetcher extends RpcTarget {
    constructor(fetchHandler) {
      super();
      this.fetchHandler = fetchHandler;
    }

    fetch(request) {
      return this.fetchHandler(request);
    }
  };
}

function toWebSocketUrl(input) {
  const url = new URL(input);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  return url.href;
}

async function waitUntilOpen(socket) {
  if (socket.readyState === WebSocket.OPEN) return;
  if (socket.readyState !== WebSocket.CONNECTING) {
    throw new Error("WebSocket closed before opening");
  }

  const listeners = new AbortController();
  await new Promise((resolve, reject) => {
    const settle = (callback) => {
      listeners.abort();
      callback();
    };

    socket.addEventListener("open", () => settle(resolve), { signal: listeners.signal });
    socket.addEventListener(
      "error",
      () => settle(() => reject(new Error("WebSocket connection failed"))),
      { signal: listeners.signal },
    );
    socket.addEventListener(
      "close",
      (event) => {
        settle(() => {
          reject(new Error(`WebSocket closed before opening: ${event.code} ${event.reason}`));
        });
      },
      { signal: listeners.signal },
    );
  });
}

function disposeSession(session) {
  if (session && Symbol.dispose in session) {
    session[Symbol.dispose]();
  }
}
