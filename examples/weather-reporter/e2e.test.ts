import { describe, expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../../src/client.ts";

vi.setConfig({ testTimeout: 15_000 });

const weatherReporterUrl = process.env.WEATHER_REPORTER_URL;
if (!weatherReporterUrl) {
  throw new Error("WEATHER_REPORTER_URL is required to load this e2e test module");
}
const myWeatherAppUrl = weatherReporterUrl;

describe("weather reporter e2e", () => {
  test("returns nicely formatted weather report", async () => {
    using _tunnel = await createCaptunTunnel({
      url: `${myWeatherAppUrl}/__intercept-egress-traffic`,
      fetch(request) {
        if (request.url === "https://wttr.in/london?format=j1") {
          return Response.json({ current_condition: [{ temp_C: "18" }] });
        }
        if (request.url === "https://wttr.in/new+york?format=j1") {
          return Response.json({ current_condition: [{ temp_C: "22" }] });
        }
        return new Response("Unexpected egress", { status: 500 });
      },
    });

    const london = await fetch(`${myWeatherAppUrl}/weather/london`);
    expect(await london.text()).toBe("The temperature in london is 18 celsius");

    const newYork = await fetch(`${myWeatherAppUrl}/weather/new+york`);
    expect(await newYork.text()).toBe("The temperature in new+york is 22 celsius");
  });
});
