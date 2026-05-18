import { describe, expect, test } from "vitest";
import { CapnwebTunnelServer } from "../src/server";
import { tunnelRouteParts, tunnelShardName } from "../src/worker";

describe("tunnelRouteParts", () => {
  const cases: Array<[
    hostname: string,
    path: string,
    tunnelName: string | undefined,
    forwardedPath: string | undefined,
  ]> = [
    ["capnweb-tunnel.account.workers.dev", "/my-test/hello", "my-test", "/hello"],
    ["capnweb-tunnel.account.workers.dev", "/my-test/__connect", "my-test", "/__connect"],
    ["capnweb-tunnel.account.workers.dev", "/__connect", undefined, undefined],
    ["capnweb-tunnel.account.workers.dev", "/", undefined, undefined],
    ["localhost", "/my-test/hello", "my-test", "/hello"],
    ["my-tunnels.com", "/my-test/hello", "my-test", "/hello"],
    ["tunnels.example.com", "/my-test/hello", "my-test", "/hello"],
    ["tunnels.example.com", "/my-test/__connect", "my-test", "/__connect"],
    ["my-test.tunnels.example.com", "/hello", "my-test", "/hello"],
    ["my-test.my-tunnels.com", "/hello", "my-test", "/hello"],
    ["my-test.my-tunnels.com", "/__connect", "my-test", "/__connect"],
    ["my-test.mysubdomain.mydomain.com", "/hello", "my-test", "/hello"],
    ["some-tunnel.example.com", "/some-path", "some-tunnel", "/some-path"],
    ["capnweb-tunnel.account.workers.dev", "/bad%/hello", undefined, undefined],
  ];

  test.each(cases)("%s%s -> %s %s", (hostname, path, tunnelName, forwardedPath) => {
    expect(tunnelRouteParts(hostname, path)).toEqual(
      tunnelName ? { name: tunnelName, path: forwardedPath } : undefined,
    );
  });
});

describe("tunnelShardName", () => {
  test("uses one warm shard by default", () => {
    expect(tunnelShardName("alpha", 1)).toBe("tunnel-shard-0");
    expect(tunnelShardName("beta", 0)).toBe("tunnel-shard-0");
  });

  test("keeps a tunnel name on a stable shard", () => {
    expect(tunnelShardName("my-test", 16)).toBe(tunnelShardName("my-test", 16));
    expect(tunnelShardName("my-test", 16)).toMatch(/^tunnel-shard-(?:[0-9]|1[0-5])$/);
  });
});

describe("CapnwebTunnelServer", () => {
  test("returns 503 before a client connects", async () => {
    const response = await new CapnwebTunnelServer().fetch(new Request("https://example.com/hello"));
    expect(response.status).toBe(503);
  });

  test("rejects connect requests with the wrong secret", async () => {
    const response = await new CapnwebTunnelServer({ secret: "secret" }).fetch(
      new Request("https://example.com/__connect?secret=wrong"),
    );
    expect(response.status).toBe(401);
  });
});
