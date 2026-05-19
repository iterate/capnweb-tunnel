import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun/server";
import { WeatherReporter } from "./app.js";

type WeatherReporterEnv = Env & {
  WEATHER_REPORTER_EGRESS: DurableObjectNamespace<WeatherReporterEgressTunnel>;
};

export class WeatherReporterEgressTunnel extends DurableObject<WeatherReporterEnv> {
  private egressTunnel: CaptunServerTunnel | undefined;
  private readonly egressFetch: typeof fetch = async (input, init) => {
    if (this.egressTunnel) return this.egressTunnel.fetch(new Request(input, init));
    return fetch(input, init);
  };
  private readonly app = new WeatherReporter(this.egressFetch);

  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      return this.app.fetch(request);
    }

    if (url.pathname === "/__intercept-egress-traffic") {
      // Here we set up our worker to allow clients/tests to intercept egress traffic
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (this.egressTunnel === tunnel) this.egressTunnel = undefined;
        },
      });
      this.egressTunnel?.[Symbol.dispose]();
      this.egressTunnel = tunnel;
      return response;
    }

    return this.app.fetch(request);
  }
}

export default {
  fetch(request: Request, env: WeatherReporterEnv) {
    return env.WEATHER_REPORTER_EGRESS.getByName("default").fetch(request);
  },
} satisfies ExportedHandler<WeatherReporterEnv>;
