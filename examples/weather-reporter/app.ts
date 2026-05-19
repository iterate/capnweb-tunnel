import type { CaptunServerTunnel } from "captun/server";

export class WeatherReporter {
  private egressTunnel: CaptunServerTunnel | undefined;

  replaceEgressTunnel(tunnel: CaptunServerTunnel) {
    this.egressTunnel?.[Symbol.dispose]();
    this.egressTunnel = tunnel;
  }

  clearEgressTunnel(tunnel: CaptunServerTunnel) {
    if (this.egressTunnel === tunnel) this.egressTunnel = undefined;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/weather") {
      const city = url.searchParams.get("city") || "";
      const response = await this.egressFetch(`https://wttr.in/${city}?format=j1`);
      const weather = (await response.json()) as {
        current_condition: [{ temp_C: string }];
      };
      return new Response(
        `The temperature in ${city} is ${weather.current_condition[0].temp_C} celsius`,
      );
    }

    return new Response("Not found\n", { status: 404 });
  }

  private get egressFetch(): typeof fetch {
    if (this.egressTunnel) {
      return async (input, init) => this.egressTunnel!.fetch(new Request(input, init));
    }
    return fetch;
  }
}
