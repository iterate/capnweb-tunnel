import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun";

type WeatherReporterOptions = {
  internetFetch?: CaptunServerTunnel["fetch"];
};

export function createWeatherReporter(options: WeatherReporterOptions = {}) {
  let egressTunnel: CaptunServerTunnel | undefined;

  const internetFetch: CaptunServerTunnel["fetch"] = (request) => {
    if (options.internetFetch) return options.internetFetch(request);
    if (egressTunnel) return egressTunnel.fetch(request);
    return fetch(request);
  };

  return {
    async fetch(request: Request) {
      const url = new URL(request.url);

      if (url.pathname === "/check-weather") {
        const city = url.searchParams.get("city") ?? "London";
        const response = await internetFetch(new Request(`https://api.example.com/weather?city=${city}`));
        const weather = await response.json() as { temperature: number };
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
}

export default createWeatherReporter();
