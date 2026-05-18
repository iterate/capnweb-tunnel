import { describe, expect, test } from "vite-plus/test";
import worker from "../src/worker";

describe("weather reporter e2e", () => {
  test("renders weather from mocked internet egress", async () => {
    const originalFetch = globalThis.fetch;
    const seen: string[] = [];

    globalThis.fetch = (async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      seen.push(request.url);
      return Response.json({ temperature: 18 });
    }) as typeof fetch;

    try {
      const response = await worker.fetch(
        new Request("https://weather.example/check-weather?city=London"),
      );

      expect(await response.text()).toBe("The temperature in London is 18 celsius");
      expect(seen).toEqual(["https://api.example.com/weather?city=London"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("keeps the Captun endpoint out of application routes", async () => {
    const response = await worker.fetch(new Request("https://weather.example/nope"));

    expect(response.status).toBe(404);
  });
});
