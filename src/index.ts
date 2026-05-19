import { createCaptunTunnel as createTunnel } from "./client.ts";
import {
  acceptCaptunTunnel as acceptTunnel,
  acceptCaptunTunnelFromSocket as acceptTunnelFromSocket,
} from "./server.ts";
import type { createCaptunTunnel as CreateCaptunTunnel } from "./client.js";
import type {
  acceptCaptunTunnel as AcceptCaptunTunnel,
  acceptCaptunTunnelFromSocket as AcceptCaptunTunnelFromSocket,
} from "./server.js";

export const createCaptunTunnel: typeof CreateCaptunTunnel = createTunnel;
export const acceptCaptunTunnel: typeof AcceptCaptunTunnel = acceptTunnel;
export const acceptCaptunTunnelFromSocket: typeof AcceptCaptunTunnelFromSocket =
  acceptTunnelFromSocket;
