import { expect, test } from "vitest";

import { decideTunnelAdmission, type HostedAdmissionEnv } from "../src/hosted-admission.js";

test("hosted tunnel admission allows self-hosted connects without tokens", () => {
  const admission = decideTunnelAdmission({
    request: new Request("https://captun.example.com/?captun-connect=1&captun-name=demo"),
    env: { CUSTOM_HOSTNAME: "captun.example.com" },
    activeToken: undefined,
  });

  expect(admission).toMatchObject({ ok: true, token: undefined });
});

test("hosted tunnel admission checks configured tokens before public-hosted policy", async () => {
  const rejected = decideTunnelAdmission({
    request: new Request("https://captun.sh/?captun-connect=1&captun-name=demo"),
    env: { CUSTOM_HOSTNAME: "captun.sh", CAPTUN_TOKEN: "secret" },
    activeToken: undefined,
  });
  const accepted = decideTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=secret",
    ),
    env: { CUSTOM_HOSTNAME: "captun.sh", CAPTUN_TOKEN: "secret" },
    activeToken: undefined,
  });

  expect(rejected).toMatchObject({ ok: false });
  if (rejected.ok) throw new Error("expected token rejection");
  expect(rejected.response).toMatchObject({ status: 401 });
  expect(await rejected.response.text()).toBe("Unauthorized\n");
  expect(accepted).toMatchObject({ ok: true, token: "secret" });
});

test("hosted tunnel admission ignores active anonymous tokens when token auth is configured", () => {
  const admission = decideTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=secret",
    ),
    env: { CUSTOM_HOSTNAME: "captun.sh", CAPTUN_TOKEN: "secret" },
    activeToken: "anonymous-a",
  });

  expect(admission).toMatchObject({ ok: true, token: "secret" });
});

test("hosted tunnel admission requires anonymous tokens on captun.sh", async () => {
  const missing = decideTunnelAdmission({
    request: new Request("https://captun.sh/?captun-connect=1&captun-name=demo"),
    env: hostedEnv(),
    activeToken: undefined,
  });
  const invalid = decideTunnelAdmission({
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

test("hosted tunnel admission allows first and same-token anonymous connects", () => {
  const first = decideTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    ),
    env: hostedEnv(),
    activeToken: undefined,
  });
  const sameToken = decideTunnelAdmission({
    request: new Request(
      "https://captun.sh/?captun-connect=1&captun-name=demo&captun-token=token-a",
    ),
    env: hostedEnv(),
    activeToken: "token-a",
  });

  expect(first).toMatchObject({ ok: true, token: "token-a" });
  expect(sameToken).toMatchObject({ ok: true, token: "token-a" });
});

test("hosted tunnel admission rejects different active anonymous tokens", async () => {
  const admission = decideTunnelAdmission({
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

function hostedEnv(): HostedAdmissionEnv {
  return { CUSTOM_HOSTNAME: "captun.sh" };
}
