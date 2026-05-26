import { expect, test } from "vitest";

import {
  decidePublicTunnelAdmission,
  type PublicGatewayPolicyEnv,
} from "../src/hosted/public-gateway-policy.js";

test("public gateway policy checks configured tokens before anonymous ownership policy", async () => {
  const rejected = decidePublicTunnelAdmission({
    request: new Request("https://captun.sh/?captun-connect=1&captun-name=demo"),
    env: { CAPTUN_TOKEN: "secret" },
    activeToken: undefined,
  });
  const accepted = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=secret",
    ),
    env: { CAPTUN_TOKEN: "secret" },
    activeToken: undefined,
  });

  expect(rejected).toMatchObject({ ok: false });
  if (rejected.ok) throw new Error("expected token rejection");
  expect(rejected.response).toMatchObject({ status: 401 });
  expect(await rejected.response.text()).toBe("Unauthorized\n");
  expect(accepted).toMatchObject({ ok: true, token: "secret" });
});

test("public gateway policy ignores active anonymous tokens when token auth is configured", () => {
  const admission = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=secret",
    ),
    env: { CAPTUN_TOKEN: "secret" },
    activeToken: "anonymous-a",
  });

  expect(admission).toMatchObject({ ok: true, token: "secret" });
});

test("public gateway policy requires anonymous ownership tokens", async () => {
  const missing = decidePublicTunnelAdmission({
    request: new Request("https://captun.sh/?captun-connect=1&captun-name=demo"),
    env: hostedEnv(),
    activeToken: undefined,
  });
  const invalid = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=no spaces",
    ),
    env: hostedEnv(),
    activeToken: undefined,
  });

  expect(missing).toMatchObject({ ok: false });
  if (missing.ok) throw new Error("expected missing token rejection");
  expect(missing.response).toMatchObject({ status: 400 });
  expect(await missing.response.text()).toBe("Missing tunnel token\n");

  expect(invalid).toMatchObject({ ok: false });
  if (invalid.ok) throw new Error("expected invalid token rejection");
  expect(invalid.response).toMatchObject({ status: 400 });
  expect(await invalid.response.text()).toBe("Invalid tunnel token\n");
});

test("public gateway policy allows first and same-token anonymous connects", () => {
  const first = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    ),
    env: hostedEnv(),
    activeToken: undefined,
  });
  const sameToken = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    ),
    env: hostedEnv(),
    activeToken: "token-a",
  });

  expect(first).toMatchObject({ ok: true, token: "token-a" });
  expect(sameToken).toMatchObject({ ok: true, token: "token-a" });
});

test("public gateway policy rejects different active anonymous tokens", async () => {
  const admission = decidePublicTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-b",
    ),
    env: hostedEnv(),
    activeToken: "token-a",
  });

  expect(admission).toMatchObject({ ok: false });
  if (admission.ok) throw new Error("expected active-token rejection");
  expect(admission.response).toMatchObject({ status: 409 });
  expect(admission.response.headers.get("cache-control")).toBe("no-store");
  expect(await admission.response.text()).toBe("Tunnel name is already connected\n");
});

function hostedEnv(): PublicGatewayPolicyEnv {
  return {};
}
