import { describe, expect, test } from "vitest";
import { createWeatherReporter } from "../src/worker";

describe("weather reporter e2e", () => {
  test("renders weather from mocked internet egress", async () => {
    const seen: string[] = [];
    const worker = createWeatherReporter({
      internetFetch: (request) => {
        seen.push(request.url);
        return Response.json({ temperature: 18 });
      },
    });

    const response = await worker.fetch(new Request("https://weather.example/check-weather?city=London"));

    expect(await response.text()).toBe("The temperature in London is 18 celsius");
    expect(seen).toEqual(["https://api.example.com/weather?city=London"]);
  });

  test("keeps the Captun endpoint out of application routes", async () => {
    const worker = createWeatherReporter();
    const response = await worker.fetch(new Request("https://weather.example/nope"));

    expect(response.status).toBe(404);
  });
});
