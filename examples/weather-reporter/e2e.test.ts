import { describe, expect, test, vi } from "vite-plus/test";
import { createCaptunTunnel } from "../../src/client";

vi.setConfig({ testTimeout: 15_000 });

const myWeatherAppUrl = process.env.WEATHER_REPORTER_URL;
const testE2e = myWeatherAppUrl ? test : test.skip;

describe("weather reporter e2e", () => {
  testE2e("returns nicely formatted weather report", async () => {
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
