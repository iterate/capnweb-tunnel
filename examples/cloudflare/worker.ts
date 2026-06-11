import { DurableObject } from "cloudflare:workers";
import { acceptFetcherCapability, type FetcherStub } from "captun";

type WeatherReporterEnv = Env & {
  WEATHER_REPORTER_EGRESS: DurableObjectNamespace<WeatherReporterEgressTunnel>;
};

export class WeatherReporterEgressTunnel extends DurableObject<WeatherReporterEnv> {
  private egressTunnel: FetcherStub | undefined;
  private readonly egressFetch: typeof fetch = async (input, init) => {
    if (this.egressTunnel) return this.egressTunnel.fetch(new Request(input, init));
    return fetch(input, init);
  };

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      // Here's the value our app provides: fetching and gorgeously formatting weather data
      const city = url.searchParams.get("city") || "";
      const response = await this.egressFetch(`https://wttr.in/${city}?format=j1`);
      const weather = (await response.json()) as {
        current_condition: [{ temp_C: string }];
      };
      return new Response(
        `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
      );
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      // Here we set up our worker to allow clients/tests to intercept egress traffic
      const { response, fetcher } = acceptFetcherCapability({
        request,
        onDisconnect: () => {
          if (this.egressTunnel === fetcher) this.egressTunnel = undefined;
        },
      });
      this.egressTunnel?.[Symbol.dispose]();
      this.egressTunnel = fetcher;
      queueMicrotask(() => void fetcher.ready({ url: new URL(request.url).origin }));
      return response;
    }

    return new Response("Not found\n", { status: 404 });
  }
}

export default {
  fetch(request: Request, env: WeatherReporterEnv) {
    return env.WEATHER_REPORTER_EGRESS.getByName("default").fetch(request);
  },
} satisfies ExportedHandler<WeatherReporterEnv>;
