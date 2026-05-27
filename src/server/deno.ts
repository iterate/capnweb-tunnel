import { acceptFetcherCapabilityFromSocket } from "../index.js";

export function acceptFetcherCapabilityFromDenoSocket(
  socket: WebSocket,
  options: { onDisconnect?: () => void } = {},
) {
  return acceptFetcherCapabilityFromSocket(socket, options);
}
