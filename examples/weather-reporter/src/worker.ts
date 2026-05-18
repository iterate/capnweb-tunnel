import { CaptunServer, type CaptunFetcher } from "captun";

type WeatherReporterOptions = {
  internetFetch?: CaptunFetcher;
};

export function createWeatherReporter(options: WeatherReporterOptions = {}) {
  let egressTunnel: CaptunServer | undefined;

  const internetFetch: CaptunFetcher = (request) => {
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
        egressTunnel = new CaptunServer();
        return egressTunnel.fetch(request);
      }

      return new Response("Not found\n", { status: 404 });
    },
  };
}

export default createWeatherReporter();
