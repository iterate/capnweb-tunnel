import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";
import type { CaptunServerAcceptTunnelOptions, CaptunServerTunnel } from "./types.js";

const { newBunWebSocketRpcHandler } = (await import("capnweb")) as any;

export function createCaptunBunTunnelHandler() {
  const capnweb = newBunWebSocketRpcHandler(() => undefined);

  return {
    accept(request: Request, server: any, options: CaptunServerAcceptTunnelOptions = {}) {
      const pendingTunnel = createPendingCaptunBunTunnel(options);
      if (!server.upgrade(request, { data: { captunTunnel: pendingTunnel } })) {
        pendingTunnel.tunnel[Symbol.dispose]();
        return undefined;
      }
      return pendingTunnel.tunnel;
    },
    websocket: {
      open(socket: any) {
        const pendingTunnel = socket.data.captunTunnel;
        if (!pendingTunnel) {
          socket.close(1008, "Missing Captun tunnel data");
          return;
        }

        capnweb.open(socket);
        pendingTunnel.connect(socket.data.__capnwebStub);
      },
      message: capnweb.message,
      close: capnweb.close,
      error: capnweb.error,
    },
  };
}

function createPendingCaptunBunTunnel(
  options: CaptunServerAcceptTunnelOptions,
) {
  let connectedTunnel: CaptunServerTunnel | undefined;
  let connectTunnel: (tunnel: CaptunServerTunnel) => void = () => {};
  let rejectTunnel: (error: Error) => void = () => {};
  let closed = false;
  const tunnelReady = new Promise<CaptunServerTunnel>((resolve, reject) => {
    connectTunnel = resolve;
    rejectTunnel = reject;
  });
  tunnelReady.catch(() => undefined);

  const tunnel: CaptunServerTunnel = {
    async fetch(request) {
      if (closed) throw new Error("Captun Bun tunnel is closed");
      const connected = await tunnelReady;
      if (closed) throw new Error("Captun Bun tunnel is closed");
      return connected.fetch(request);
    },
    [Symbol.dispose]() {
      if (closed) return;
      closed = true;
      connectedTunnel?.[Symbol.dispose]();
      rejectTunnel(new Error("Captun Bun tunnel closed before the WebSocket opened"));
    },
  };

  return {
    tunnel,
    connect(remote: CaptunRemoteClient) {
      if (closed) {
        remote[Symbol.dispose]();
        return;
      }
      connectedTunnel = captunTunnelFromRemoteClient(remote, options);
      connectTunnel(connectedTunnel);
    },
  };
}
