import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";
import type { CaptunServerTunnel } from "./types.js";

export type { CaptunServerTunnel } from "./types.js";

export interface CaptunBunWebSocketHandlerOptions {
  onTunnel(tunnel: CaptunServerTunnel): void;
  onDisconnect?: (tunnel: CaptunServerTunnel) => void;
}

export interface CaptunBunWebSocketHandler {
  open(socket: CaptunBunServerWebSocket): void;
  message(socket: CaptunBunServerWebSocket, message: CaptunBunWebSocketMessage): void;
  close(socket: CaptunBunServerWebSocket, code: number, reason: string): void;
  error(socket: CaptunBunServerWebSocket, error: Error): void;
}

export interface CaptunBunServerWebSocket {
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
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

const { newBunWebSocketRpcSession } = (await import("capnweb")) as unknown as {
  newBunWebSocketRpcSession<T>(
    socket: CaptunBunServerWebSocket,
    localMain?: unknown,
  ): { stub: T; transport: CaptunBunWebSocketTransport };
};

export function createCaptunBunWebSocketHandler(
  options: CaptunBunWebSocketHandlerOptions,
): CaptunBunWebSocketHandler {
  const sessions = new WeakMap<CaptunBunServerWebSocket, CaptunBunWebSocketSession>();

  return {
    open(socket) {
      let acceptedTunnel: CaptunServerTunnel | undefined;
      const session = newBunWebSocketRpcSession<CaptunRemoteClient>(socket);
      const tunnel = captunTunnelFromRemoteClient(session.stub, {
        onDisconnect: () => {
          if (acceptedTunnel) options.onDisconnect?.(acceptedTunnel);
        },
      });

      acceptedTunnel = tunnel;
      sessions.set(socket, session);
      options.onTunnel(tunnel);
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
  };
}
