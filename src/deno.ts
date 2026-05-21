import { acceptCaptunTunnelFromSocket } from "./server-core.js";

export function acceptCaptunDenoTunnel(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
) {
  return acceptCaptunTunnelFromSocket(socket, options);
}
