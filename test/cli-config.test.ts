import { expect, test } from "vitest";

import { configSchema } from "../src/cli/bin.js";

test("CLI config requires the gateway/token shape", () => {
  expect(
    configSchema.parse({ gateway: "https://captun.example.workers.dev", token: "abc123" }),
  ).toMatchObject({
    gateway: "https://captun.example.workers.dev",
    token: "abc123",
  });
});

test("CLI config rejects legacy serverUrl/secret fields", () => {
  const parsed = configSchema.safeParse({
    serverUrl: "https://{name}.tunnels.example.com",
    secret: "abc123",
  });

  expect(parsed).toMatchObject({
    success: false,
    error: {
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "unrecognized_keys", keys: ["serverUrl", "secret"] }),
      ]),
    },
  });
});
