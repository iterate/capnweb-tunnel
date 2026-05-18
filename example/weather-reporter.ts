import { CapnwebTunnelServer } from "../src/server.ts";

let egressTunnel: CapnwebTunnelServer | undefined;

const egressFetch = (request: Request) => {
  if (egressTunnel) return egressTunnel.fetch(request);
  return fetch(request);
}

export default {
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
