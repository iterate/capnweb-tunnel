import { acceptCaptunDenoTunnel } from "captun/deno";

let egressTunnel: ReturnType<typeof acceptCaptunDenoTunnel> | undefined;
const egressFetch: typeof fetch = async (input, init) => {
  if (egressTunnel) return egressTunnel.fetch(new Request(input, init));
  return fetch(input, init);
};

const server = Deno.serve(
  { hostname: "127.0.0.1", port: Number(Deno.env.get("PORT")) },
  async (request) => {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      const city = url.searchParams.get("city") || "";
      const response = await egressFetch(`https://wttr.in/${city}?format=j1`);
      const weather = (await response.json()) as {
        current_condition: [{ temp_C: string }];
      };
      return new Response(
        `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
      );
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      const { socket, response } = Deno.upgradeWebSocket(request);
      socket.addEventListener("open", () => {
        const tunnel = acceptCaptunDenoTunnel(socket, {
          onDisconnect: () => {
            if (egressTunnel === tunnel) egressTunnel = undefined;
          },
        });
        egressTunnel?.[Symbol.dispose]();
        egressTunnel = tunnel;
      });
      return response;
    }

    return new Response("Not found\n", { status: 404 });
  },
);

Deno.addSignalListener("SIGINT", () => {
  server.shutdown().finally(() => Deno.exit(0));
});
