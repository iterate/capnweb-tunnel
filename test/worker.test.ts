import { describe, expect, test } from "vitest";
import { CaptunServer } from "../src/server";
import { CaptunRouteParts, CaptunShardName } from "../src/worker";

describe("CaptunRouteParts", () => {
  const cases: Array<[
    hostname: string,
    path: string,
    tunnelName: string | undefined,
    forwardedPath: string | undefined,
  ]> = [
    ["captun.account.workers.dev", "/my-test/hello", "my-test", "/hello"],
    ["captun.account.workers.dev", "/my-test/__connect", "my-test", "/__connect"],
    ["captun.account.workers.dev", "/__connect", undefined, undefined],
    ["captun.account.workers.dev", "/", undefined, undefined],
    ["localhost", "/my-test/hello", "my-test", "/hello"],
    ["my-tunnels.com", "/my-test/hello", "my-test", "/hello"],
    ["tunnels.example.com", "/my-test/hello", "my-test", "/hello"],
    ["tunnels.example.com", "/my-test/__connect", "my-test", "/__connect"],
    ["my-test.tunnels.example.com", "/hello", "my-test", "/hello"],
    ["my-test.my-tunnels.com", "/hello", "my-test", "/hello"],
    ["my-test.my-tunnels.com", "/__connect", "my-test", "/__connect"],
    ["my-test.mysubdomain.mydomain.com", "/hello", "my-test", "/hello"],
    ["some-tunnel.example.com", "/some-path", "some-tunnel", "/some-path"],
    ["captun.account.workers.dev", "/bad%/hello", undefined, undefined],
  ];

  test.each(cases)("%s%s -> %s %s", (hostname, path, tunnelName, forwardedPath) => {
    expect(CaptunRouteParts(hostname, path)).toEqual(
      tunnelName ? { name: tunnelName, path: forwardedPath } : undefined,
    );
  });
});

describe("CaptunShardName", () => {
  test("uses one warm shard by default", () => {
    expect(CaptunShardName("alpha", 1)).toBe("tunnel-shard-0");
    expect(CaptunShardName("beta", 0)).toBe("tunnel-shard-0");
  });

  test("keeps a tunnel name on a stable shard", () => {
    expect(CaptunShardName("my-test", 16)).toBe(CaptunShardName("my-test", 16));
    expect(CaptunShardName("my-test", 16)).toMatch(/^tunnel-shard-(?:[0-9]|1[0-5])$/);
  });
});

describe("CaptunServer", () => {
  test("returns 503 before a client connects", async () => {
    const response = await new CaptunServer().fetch(new Request("https://example.com/hello"));
    expect(response.status).toBe(503);
  });

  test("rejects connect requests with the wrong secret", async () => {
    const response = await new CaptunServer({ secret: "secret" }).fetch(
      new Request("https://example.com/__connect?secret=wrong"),
    );
    expect(response.status).toBe(401);
  });
});
