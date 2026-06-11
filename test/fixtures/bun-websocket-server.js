const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT),
  fetch(request, server) {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (server.upgrade(request)) return;
      return new Response("WebSocket upgrade failed\n", { status: 500 });
    }

    return new Response("ok\n");
  },
  websocket: {
    message(socket, message) {
      socket.send(`echo:${message}`);
    },
  },
});

process.on("SIGINT", () => {
  server.stop(true);
  process.exit(0);
});
