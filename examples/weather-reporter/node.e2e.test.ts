import { expect, test, vi } from "vitest";

import { createCaptunTunnel } from "../../src/client.js";
import { createRuntimeWeatherReporterFixture } from "./runtime-fixtures.js";

vi.setConfig({ testTimeout: 20_000 });

test("returns nicely formatted weather report from a Node server", async () => {
  await using app = await createRuntimeWeatherReporterFixture("node");
  using _tunnel = await createCaptunTunnel({
    url: `${app.url}/__intercept-egress-traffic`,
    fetch(request) {
      if (request.url === "https://wttr.in/london?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "18" }] });
      }
      if (request.url === "https://wttr.in/paris?format=j1") {
        return Response.json({ current_condition: [{ temp_C: "22" }] });
      }
      return new Response("Unexpected egress", { status: 500 });
    },
  });

  const london = await fetch(`${app.url}/weather?city=london`);
  expect(await london.text()).toBe("The temperature in london is 18 celsius");

  const paris = await fetch(`${app.url}/weather?city=paris`);
  expect(await paris.text()).toBe("The temperature in paris is 22 celsius");
});
