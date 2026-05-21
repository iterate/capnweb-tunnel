import { acceptCaptunTunnelFromSocket } from "./server-core.js";

/** A type `import('ws').WebSocket` conforms to. This will be cast internally before passing to `capnweb` */
export interface WSWebSocketLike {
  readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

export function acceptCaptunNodeTunnel(
  socket: WSWebSocketLike,
  options: { onDisconnect?: () => void } = {},
) {
  return acceptCaptunTunnelFromSocket(socket as unknown as WebSocket, options);
}
