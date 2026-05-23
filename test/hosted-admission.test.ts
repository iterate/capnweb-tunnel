import { expect, test } from "vitest";

import { decideTunnelAdmission, type HostedAdmissionEnv } from "../src/hosted-admission.js";

test("hosted tunnel admission allows self-hosted connects without owner tokens", () => {
  const admission = decideTunnelAdmission({
    request: new Request("https://captun.example.com/demo/__captun-connect"),
    env: { CUSTOM_HOSTNAME: "captun.example.com" },
    activeOwnerToken: undefined,
  });

  expect(admission).toMatchObject({ ok: true, ownerToken: undefined });
});

test("hosted tunnel admission checks configured secrets before owner-token policy", async () => {
  const rejected = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect"),
    env: { CUSTOM_HOSTNAME: "captun.sh", CAPTUN_SECRET: "secret" },
    activeOwnerToken: undefined,
  });
  const accepted = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect", {
      headers: { authorization: "Bearer secret" },
    }),
    env: { CUSTOM_HOSTNAME: "captun.sh", CAPTUN_SECRET: "secret" },
    activeOwnerToken: undefined,
  });

  expect(rejected).toMatchObject({ ok: false });
  if (rejected.ok) throw new Error("expected secret rejection");
  expect(rejected.response).toMatchObject({ status: 401 });
  expect(await rejected.response.text()).toBe("Unauthorized\n");
  expect(accepted).toMatchObject({ ok: true, ownerToken: undefined });
});

test("hosted tunnel admission requires anonymous owner tokens on captun.sh", async () => {
  const missing = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect"),
    env: hostedEnv(),
    activeOwnerToken: undefined,
  });
  const invalid = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect?captun-owner-token=no spaces"),
    env: hostedEnv(),
    activeOwnerToken: undefined,
  });

  expect(missing).toMatchObject({ ok: false });
  if (missing.ok) throw new Error("expected missing token rejection");
  expect(missing.response).toMatchObject({ status: 400 });
  expect(await missing.response.text()).toBe("Missing tunnel ownership token\n");

  expect(invalid).toMatchObject({ ok: false });
  if (invalid.ok) throw new Error("expected invalid token rejection");
  expect(invalid.response).toMatchObject({ status: 400 });
  expect(await invalid.response.text()).toBe("Invalid tunnel ownership token\n");
});

test("hosted tunnel admission allows first and same-owner anonymous connects", () => {
  const first = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect?captun-owner-token=owner-a"),
    env: hostedEnv(),
    activeOwnerToken: undefined,
  });
  const sameOwner = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect", {
      headers: { "x-captun-owner-token": "owner-a" },
    }),
    env: hostedEnv(),
    activeOwnerToken: "owner-a",
  });

  expect(first).toMatchObject({ ok: true, ownerToken: "owner-a" });
  expect(sameOwner).toMatchObject({ ok: true, ownerToken: "owner-a" });
});

test("hosted tunnel admission rejects different active anonymous owners", async () => {
  const admission = decideTunnelAdmission({
    request: new Request("https://demo.captun.sh/__captun-connect?captun-owner-token=owner-b"),
    env: hostedEnv(),
    activeOwnerToken: "owner-a",
  });

  expect(admission).toMatchObject({ ok: false });
  if (admission.ok) throw new Error("expected active owner rejection");
  expect(admission.response).toMatchObject({ status: 409 });
  expect(admission.response.headers.get("cache-control")).toBe("no-store");
  expect(await admission.response.text()).toBe("Tunnel name is already connected\n");
});

function hostedEnv(): HostedAdmissionEnv {
  return { CUSTOM_HOSTNAME: "captun.sh" };
}
