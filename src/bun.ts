import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

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

interface CaptunBunWebSocketTransport {
  dispatchMessage(message: CaptunBunWebSocketMessage): void;
  dispatchClose(code: number, reason: string): void;
  dispatchError(error: Error): void;
}

interface CaptunBunWebSocketSession {
  transport: CaptunBunWebSocketTransport;
}

interface CaptunBunAcceptedTunnel {
  tunnel: CaptunServerTunnel;
  connect(remoteClient: CaptunRemoteClient): void;
}

interface CaptunBunServerWebSocketData {
  captunTunnel?: CaptunBunAcceptedTunnel;
}

const { newBunWebSocketRpcSession } = (await import("capnweb")) as unknown as {
  newBunWebSocketRpcSession<T>(
    socket: CaptunBunServerWebSocket,
    localMain?: unknown,
  ): { stub: T; transport: CaptunBunWebSocketTransport };
};

export function createCaptunBunTunnelHandler(): CaptunBunTunnelHandler {
  const sessions = new WeakMap<CaptunBunServerWebSocket, CaptunBunWebSocketSession>();

  return {
    accept(request, server, options = {}) {
      const acceptedTunnel = createCaptunBunAcceptedTunnel(options);
      if (!server.upgrade(request, { data: { captunTunnel: acceptedTunnel } })) {
        acceptedTunnel.tunnel[Symbol.dispose]();
        return undefined;
      }
      return acceptedTunnel.tunnel;
    },
    websocket: {
      open(socket) {
        const acceptedTunnel = (socket.data as CaptunBunServerWebSocketData).captunTunnel;
        if (!acceptedTunnel) {
          socket.close(1008, "Missing Captun tunnel data");
          return;
        }

        const session = newBunWebSocketRpcSession<CaptunRemoteClient>(socket);
        acceptedTunnel.connect(session.stub);
        sessions.set(socket, session);
      },
      message(socket, message) {
        sessions.get(socket)?.transport.dispatchMessage(message);
      },
      close(socket, code, reason) {
        const session = sessions.get(socket);
        if (!session) return;
        session.transport.dispatchClose(code, reason);
        sessions.delete(socket);
      },
      error(socket, error) {
        const session = sessions.get(socket);
        if (!session) return;
        session.transport.dispatchError(error);
        sessions.delete(socket);
      },
    },
  };
}

function createCaptunBunAcceptedTunnel(
  options: CaptunServerAcceptTunnelOptions,
): CaptunBunAcceptedTunnel {
  let connectedTunnel: CaptunServerTunnel | undefined;
  let connectRemoteClient: (remoteClient: CaptunRemoteClient) => void = () => {};
  let rejectRemoteClient: (error: Error) => void = () => {};
  let closed = false;
  const remoteClient = new Promise<CaptunRemoteClient>((resolve, reject) => {
    connectRemoteClient = resolve;
    rejectRemoteClient = reject;
  });
  remoteClient.catch(() => undefined);

  const tunnel: CaptunServerTunnel = {
    async fetch(request) {
      if (closed) throw new Error("Captun Bun tunnel is closed");
      const remote = await remoteClient;
      if (closed) throw new Error("Captun Bun tunnel is closed");
      return remote.fetch(request);
    },
    [Symbol.dispose]() {
      if (closed) return;
      closed = true;
      connectedTunnel?.[Symbol.dispose]();
      rejectRemoteClient(new Error("Captun Bun tunnel closed before the WebSocket opened"));
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
      connectRemoteClient(remote);
    },
  };
}
