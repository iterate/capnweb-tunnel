import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun/server";

let egressTunnel: CaptunServerTunnel | undefined;

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/check-weather") {
      const city = url.searchParams.get("city") ?? "London";
      const response = await internetFetch(
        new Request(`https://api.example.com/weather?city=${city}`),
      );
      const weather = (await response.json()) as { temperature: number };
      return new Response(`The temperature in ${city} is ${weather.temperature} celsius`);
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      egressTunnel?.[Symbol.dispose]();
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (egressTunnel === tunnel) egressTunnel = undefined;
        },
      });
      egressTunnel = tunnel;
      return response;
    }

    return new Response("Not found\n", { status: 404 });
  },
};

function internetFetch(request: Request) {
  if (egressTunnel) return egressTunnel.fetch(request);
  return fetch(request);
}
