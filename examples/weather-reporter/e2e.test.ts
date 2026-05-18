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
        if (!request.url.startsWith("https://wttr.in/London?format=j1")) {
          return new Response("Unexpected egress", { status: 500 });
        }
        return Response.json({ current_condition: [{ temp_C: "18" }] });
      },
    });

    const response = await fetch(`${myWeatherAppUrl}/check-weather?city=London`);
    expect(await response.text()).toBe("The temperature in London is 18 celsius");
  });
});
