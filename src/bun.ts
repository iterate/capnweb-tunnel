import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export interface CaptunBunTunnelHandler {
  accept(
    request: Request,
    server: CaptunBunServer,
    options?: CaptunServerAcceptTunnelOptions,
  ): CaptunServerTunnel | undefined;
  websocket: CaptunBunWebSocketHandler;
}

export interface CaptunBunWebSocketHandler {
  open(socket: CaptunBunServerWebSocket): void;
  message(socket: CaptunBunServerWebSocket, message: CaptunBunWebSocketMessage): void;
  close(socket: CaptunBunServerWebSocket, code: number, reason: string): void;
  error(socket: CaptunBunServerWebSocket, error: Error): void;
}

export interface CaptunBunServerWebSocket {
  data: unknown;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

export interface CaptunBunServer {
  upgrade(request: Request, options: { data: unknown }): boolean;
}

export type CaptunBunWebSocketMessage = string | Uint8Array | ArrayBuffer;

interface PendingCaptunBunTunnel {
  tunnel: CaptunServerTunnel;
  connect(remoteClient: CaptunRemoteClient): void;
}

interface CaptunBunUpgradeData {
  captunTunnel?: PendingCaptunBunTunnel;
}

interface CapnwebBunWebSocketData {
  __capnwebStub: CaptunRemoteClient;
}

const { newBunWebSocketRpcHandler } = (await import("capnweb")) as unknown as {
  newBunWebSocketRpcHandler(createMain: () => unknown): CaptunBunWebSocketHandler;
};

export function createCaptunBunTunnelHandler(): CaptunBunTunnelHandler {
  const capnweb = newBunWebSocketRpcHandler(() => undefined);

  return {
    accept(request, server, options = {}) {
      const pendingTunnel = createPendingCaptunBunTunnel(options);
      if (!server.upgrade(request, { data: { captunTunnel: pendingTunnel } })) {
        pendingTunnel.tunnel[Symbol.dispose]();
        return undefined;
      }
      return pendingTunnel.tunnel;
    },
    websocket: {
      open(socket) {
        const pendingTunnel = (socket.data as CaptunBunUpgradeData).captunTunnel;
        if (!pendingTunnel) {
          socket.close(1008, "Missing Captun tunnel data");
          return;
        }

        capnweb.open(socket);
        pendingTunnel.connect((socket.data as CapnwebBunWebSocketData).__capnwebStub);
      },
      message: capnweb.message,
      close: capnweb.close,
      error: capnweb.error,
    },
  };
}

function createPendingCaptunBunTunnel(
  options: CaptunServerAcceptTunnelOptions,
): PendingCaptunBunTunnel {
  let connectedTunnel: CaptunServerTunnel | undefined;
  let connectTunnel: (tunnel: CaptunServerTunnel) => void = () => {};
  let rejectTunnel: (error: Error) => void = () => {};
  let closed = false;
  const tunnelReady = new Promise<CaptunServerTunnel>((resolve, reject) => {
    connectTunnel = resolve;
    rejectTunnel = reject;
  });
  tunnelReady.catch(() => undefined);

  const tunnel: CaptunServerTunnel = {
    async fetch(request) {
      if (closed) throw new Error("Captun Bun tunnel is closed");
      const connected = await tunnelReady;
      if (closed) throw new Error("Captun Bun tunnel is closed");
      return connected.fetch(request);
    },
    [Symbol.dispose]() {
      if (closed) return;
      closed = true;
      connectedTunnel?.[Symbol.dispose]();
      rejectTunnel(new Error("Captun Bun tunnel closed before the WebSocket opened"));
    },
  };

  return {
    tunnel,
    connect(remote) {
      if (closed) {
        remote[Symbol.dispose]();
        return;
      }
      connectedTunnel = captunTunnelFromRemoteClient(remote, options);
      connectTunnel(connectedTunnel);
    },
  };
}
