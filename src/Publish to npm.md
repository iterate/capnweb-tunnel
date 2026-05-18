Publish to npm 

`pnpm dlx capnweb-tunnel deploy` 
- trpc cli asks some questions and deploys with wrangler
- asks for 
  - worker route  (optional) - default to capnweb-tunnel.your-account.workers.dev
  - secret (default to some random secret)
  - runs `wrangler deploy`
  - writes json to ~/.capnweb-tunnel.json

- `pnpm dlx capnweb-tunnel 3000` - makes a tunnel 
- optional args 
  - server url 
  - secret
  - tunnel name

# Programmatic Usage


super-weather-reporter.ts 
```ts
import { CapnwebTunnelServer } from "capnweb-tunnel";

let egressTunnel: CapnwebTunnelServer | undefined;

const egressFetch = (request: Request) => {
  if (egressTunnel) return egressTunnel.fetch(request);
  return fetch(request);
}

export default {
    port: 1234,
    fetch: async (request: Request) => {
        const url = new URL(request.url);
        // Our application is a weather app that nicely formats weather reports from a third party API
        if (url.pathname === "/check-weather") {
            const res = await egressFetch(new Request("https://api.example.com/api/weather?city=London"));
            return new Response(`The temperature in London is ${(await res.json()).temperature} celsius`);
        }
        // In e2e tests we allow a vitest test process to capture and mock all network egress
        // (even if our application server is deployed on a different computer)
        if (url.pathname === "/__intercept-egress-traffic") {
            egressTunnel = new CapnwebTunnelServer();
            return egressTunnel.fetch(request);
        }
        return new Response("Not found", { status: 404 });
    }
};
```

Then deploy and run your server however you like doing that sort of thing e.g. `bun super-weather-reporter.ts` or `pnpm dlx srvx super-weather-reporter.ts` or wrangler or whatever.

super-weather-reporter.test.ts
```ts
import { CapnwebTunnelClient } from "capnweb-tunnel";
import { test, expect } from "vitest";

test('returns nicely formatted weather report', async () => {

  const myWeatherAppUrl = 'http://127.0.0.1:1234'; // or deployed URL somewhere

  // This will send all egress from the deployed worker app through out mocked fetch function above
  using client = await CapnwebTunnelClient.connect({
    url: myWeatherAppUrl + "/__intercept-egress-traffic",
    fetch: (request) => {
        return new Response(JSON.stringify({ temperature: 20 }), { status: 200 });
    }
  });

  const response = await fetch(worker.url + "/get-weather-report");
  expect(await response.text()).toBe("The temperature in London is 20 celsius");
});
```


# iterate specific usecase

```ts

await using project = new ProjectFixture();

await using tunnel = await CapnwebTunnelClient.connect({
    serverUrl: project.urlOfTheActualDurableObject, // os.iterate.com/durable-objects/project/[name]/__connect
    fetch: (request) => {
        if (request.url.includes("api.weather.com")) {
            return new Response(JSON.stringify({ temperature: 20 }), { status: 200 });
        }
    }
});

```

# Build

- dist/ 

# Publish
- Use "np" to publish
