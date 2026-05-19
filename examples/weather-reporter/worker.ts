import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun/server";

type WeatherReporterEnv = Env & {
  WEATHER_REPORTER_EGRESS: DurableObjectNamespace<WeatherReporterEgressTunnel>;
};

export class WeatherReporterEgressTunnel extends DurableObject<WeatherReporterEnv> {
  private egressTunnel: CaptunServerTunnel | undefined;

  async fetch(request: Request) {
    const url = new URL(request.url);

    const city = url.pathname.match(/^\/weather\/([^/]+)$/)?.[1];
    if (city) {
      const response = await this.egressFetch(new Request(`https://wttr.in/${city}?format=j1`));
      const weather = await response.json<{ current_condition: [{ temp_C: string }] }>();
      return new Response(`The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`);
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      this.egressTunnel?.[Symbol.dispose]();
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (this.egressTunnel === tunnel) this.egressTunnel = undefined;
        },
      });
      this.egressTunnel = tunnel;
      return response;
    }

    return new Response("Not found\n", { status: 404 });
  }

  private egressFetch(request: Request) {
    if (this.egressTunnel) return this.egressTunnel.fetch(request);
    return fetch(request);
  }
}

export default {
  fetch(request: Request, env: WeatherReporterEnv) {
    return env.WEATHER_REPORTER_EGRESS.getByName("default").fetch(request);
  },
} satisfies ExportedHandler<WeatherReporterEnv>;
