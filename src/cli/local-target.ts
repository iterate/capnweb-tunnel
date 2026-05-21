import { createConnection } from "node:net";

import { CliFriendlyError } from "./cli-error.js";

export async function assertLocalTargetAcceptingConnections(
  targetUrl: string,
  options: { timeoutMs?: number } = {},
) {
  const url = new URL(targetUrl);
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const host = url.hostname;

  if (!Number.isInteger(port) || port <= 0) {
    throw new CliFriendlyError(`Cannot check local target port for ${targetUrl}`);
  }

  try {
    await tcpConnect({ host, port, timeoutMs: options.timeoutMs ?? 1_000 });
  } catch {
    throw new CliFriendlyError(`${targetUrl} is not accepting connections`);
  }
}

function tcpConnect(input: { host: string; port: number; timeoutMs: number }) {
  return new Promise<void>((resolvePromise, reject) => {
    const socket = createConnection({ host: input.host, port: input.port });
    const done = (callback: () => void) => {
      socket.removeAllListeners();
      socket.destroy();
      callback();
    };

    socket.setTimeout(input.timeoutMs);
    socket.once("connect", () => done(resolvePromise));
    socket.once("timeout", () => done(() => reject(new Error("Connection timed out"))));
    socket.once("error", (error) => done(() => reject(error)));
  });
}
