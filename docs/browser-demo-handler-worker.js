self.addEventListener("message", (event) => {
  handleMessage(event.data).catch((error) => {
    postError(error);
  });
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    throw new Error("Handler worker received an invalid message.");
  }

  if (message.type === "validate") {
    compileHandler(message.source);
    self.postMessage({ type: "validated" });
    return;
  }

  if (message.type === "fetch") {
    const handler = compileHandler(message.source);
    const request = deserializeRequest(message.request);
    const response = await normalizeResponse(await handler(request, handlerContext(message)));
    const serialized = await serializeResponse(response);
    self.postMessage({ type: "result", response: serialized.response }, serialized.transfer);
    return;
  }

  throw new Error("Handler worker received an unknown message: " + message.type);
}

function compileHandler(source) {
  const handlerSource = source ? String(source).trim() : "";

  if (!handlerSource) {
    throw new Error("Handler source is empty.");
  }

  const value = Function(
    '"use strict";\nreturn (\n' +
      handlerSource +
      "\n);\n//# sourceURL=captun-browser-demo-handler-source.js",
  )();

  if (typeof value === "function") return value;
  if (value && typeof value.fetch === "function") return value.fetch.bind(value);

  throw new Error("Handler source must evaluate to a function or an object with fetch().");
}

function deserializeRequest(request) {
  const init = {
    headers: request.headers,
    method: request.method,
  };

  if (request.body !== null && typeof request.body !== "undefined") {
    init.body = request.body;
  }

  return new Request(request.url, init);
}

function handlerContext(message) {
  const context = message.context;

  return {
    corsHeaders: context.corsHeaders,
    log(value) {
      self.postMessage({
        type: "handler-log",
        message: String(value),
        requestId: context.requestId,
      });
    },
    publicUrl: context.publicUrl,
    requestId: context.requestId,
    tunnelName: context.tunnelName,
  };
}

async function normalizeResponse(value) {
  const resolved = await value;
  const isReadableStream =
    typeof ReadableStream === "function" && resolved instanceof ReadableStream;

  if (resolved instanceof Response) return resolved;
  if (
    typeof resolved === "string" ||
    resolved instanceof Blob ||
    isReadableStream ||
    resolved instanceof Uint8Array
  ) {
    return new Response(resolved);
  }

  throw new Error("Handler must return a Response, string, Blob, ReadableStream, or Uint8Array.");
}

async function serializeResponse(response) {
  if (response.type === "error") {
    return {
      response: { type: "error" },
      transfer: [],
    };
  }

  const body = response.body ? await response.arrayBuffer() : null;

  return {
    response: {
      body,
      headers: Array.from(response.headers.entries()),
      status: response.status,
      statusText: response.statusText,
      type: "default",
    },
    transfer: body ? [body] : [],
  };
}

function postError(error) {
  self.postMessage({
    type: "error",
    error: serializeError(error),
  });
}

function serializeError(error) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return {
    message: String(error),
    name: "Error",
  };
}
