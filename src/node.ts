import { acceptCaptunTunnelFromSocket } from "./server-core.js";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export interface CaptunNodeWebSocket {
  readyState: number;
  addEventListener(type: string, listener: (event: any) => void): void;
  send(message: string): unknown;
  close(code?: number, reason?: string): void;
}

export function acceptCaptunNodeTunnel(
  socket: CaptunNodeWebSocket,
  options: CaptunServerAcceptTunnelOptions = {},
): CaptunServerTunnel {
  return acceptCaptunTunnelFromSocket(socket as unknown as WebSocket, options);
}
