import { acceptFetcherCapabilityFromSocket } from "./server-core.js";

export function acceptFetcherCapabilityFromDenoSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
) {
  return acceptFetcherCapabilityFromSocket(socket, options);
}
