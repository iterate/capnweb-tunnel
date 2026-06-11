/**
 * The reserved health path every captun Tunnel Client answers itself instead
 * of proxying, so a tunnel can be probed end-to-end without involving the
 * local fetcher (`confirmTunnelHealth` in the CLI relies on this).
 */
export const captunHealthPath = "/__captun/health";

export function isCaptunHealthRequest(request: Request) {
  return new URL(request.url).pathname === captunHealthPath;
}

export function captunHealthResponse() {
  return Response.json({ ok: true });
}
