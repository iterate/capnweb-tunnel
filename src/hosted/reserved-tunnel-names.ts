export const HOSTED_RESERVED_TUNNEL_NAMES = [
  "account",
  "accounts",
  "admin",
  "api",
  "app",
  "auth",
  "billing",
  "captun",
  "dash",
  "dashboard",
  "docs",
  "gateway",
  "gateways",
  "iterate",
  "login",
  "payment",
  "payments",
  "status",
  "support",
  "tunnel",
  "tunnels",
  "www",
];

export function isHostedReservedTunnelName(name: string) {
  return HOSTED_RESERVED_TUNNEL_NAMES.includes(name);
}
