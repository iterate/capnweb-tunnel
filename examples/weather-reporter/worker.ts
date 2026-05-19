import { DurableObject } from "cloudflare:workers";
import { acceptCaptunTunnel, type CaptunServerTunnel } from "captun/server";
import { WeatherReporter } from "./app.js";

type WeatherReporterEnv = Env & {
  WEATHER_REPORTER_EGRESS: DurableObjectNamespace<WeatherReporterEgressTunnel>;
};

export class WeatherReporterEgressTunnel extends DurableObject<WeatherReporterEnv> {
  private readonly app = new WeatherReporter();

  fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/__intercept-egress-traffic") {
      // Here we set up our worker to allow clients/tests to intercept egress traffic
      let acceptedTunnel: CaptunServerTunnel | undefined;
      const { response, tunnel } = acceptCaptunTunnel({
        onDisconnect: () => {
          if (acceptedTunnel) this.app.clearEgressTunnel(acceptedTunnel);
        },
      });
      acceptedTunnel = tunnel;
      this.app.replaceEgressTunnel(tunnel);
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
