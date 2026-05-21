import { captunTunnelFromRemoteClient, type CaptunRemoteClient } from "./server-core.js";

// @ts-ignore -- capnweb exports separate types for bun but this lib is built from node. it'll work at runtime though.
import { newBunWebSocketRpcHandler } from "capnweb";

export function createCaptunBunTunnelHandler() {
  const capnweb = newBunWebSocketRpcHandler(() => undefined);

  return {
    accept(
      request: Request,
      server: { upgrade: Function },
      options: { onDisconnect?: () => void } = {},
    ) {
      const pendingTunnel = createPendingCaptunBunTunnel(options);
      const upgraded = server.upgrade(request, { data: { captunTunnel: pendingTunnel } });
      if (!upgraded) {
        pendingTunnel.tunnel[Symbol.dispose]();
        return undefined;
      }
      return pendingTunnel.tunnel;
    },
    websocket: {
      open(socket: unknown) {
        const _socket = socket as {
          data: { __capnwebStub: any; captunTunnel: any };
          close: Function;
        };
        const pendingTunnel = _socket.data.captunTunnel;
        if (!pendingTunnel) {
          _socket.close(1008, "Missing Captun tunnel data");
          return;
        }

        capnweb.open(_socket);
        pendingTunnel.connect(_socket.data.__capnwebStub);
      },
      message: capnweb.message,
      close: capnweb.close,
      error: capnweb.error,
    },
  };
}

/**
 * Creates a tunnel handle *before* Bun gives us the actual socket, because `server.upgrade(...)` just returns a boolean. The WebSocket arrives later in `open(...)`.
 * So we need to pass this "pending tunnel" reference to `server.upgrade(...)` via `data`, to be fished out later.
 */
function createPendingCaptunBunTunnel(options: { onDisconnect?: () => void }) {
  let connectedTunnel: ReturnType<typeof captunTunnelFromRemoteClient> | undefined;
  let connectTunnel: (tunnel: ReturnType<typeof captunTunnelFromRemoteClient>) => void = () => {};
  let rejectTunnel: (error: Error) => void = () => {};
  let closed = false;
  const tunnelReady = new Promise<ReturnType<typeof captunTunnelFromRemoteClient>>(
    (resolve, reject) => {
      connectTunnel = resolve;
      rejectTunnel = reject;
    },
  );
  tunnelReady.catch(() => undefined);

  const tunnel = {
    async fetch(request: Request) {
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
