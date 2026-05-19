import { acceptCaptunTunnelFromSocket } from "./server.js";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

export function acceptCaptunDenoTunnel(
  socket: WebSocket,
  options: CaptunServerAcceptTunnelOptions = {},
): CaptunServerTunnel {
  return acceptCaptunTunnelFromSocket(socket, options);
}
