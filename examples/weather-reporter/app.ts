type EgressFetch = typeof fetch;

export class WeatherReporter {
  private readonly egressFetch: EgressFetch;

  constructor(egressFetch: EgressFetch) {
    this.egressFetch = egressFetch;
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
}
