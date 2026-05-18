import { describe, expect, test } from "vite-plus/test";
import { captunRouteParts, captunShardName } from "../src/worker";

describe("captunRouteParts", () => {
  const cases: Array<
    [
      hostname: string,
      path: string,
      tunnelName: string | undefined,
      forwardedPath: string | undefined,
    ]
  > = [
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
    expect(captunRouteParts(hostname, path)).toEqual(
      tunnelName ? { name: tunnelName, path: forwardedPath } : undefined,
    );
  });
});

describe("captunShardName", () => {
  test("uses one warm shard by default", () => {
    expect(captunShardName("alpha", 1)).toBe("tunnel-shard-0");
    expect(captunShardName("beta", 0)).toBe("tunnel-shard-0");
  });

  test("keeps a tunnel name on a stable shard", () => {
    expect(captunShardName("my-test", 16)).toBe(captunShardName("my-test", 16));
    expect(captunShardName("my-test", 16)).toMatch(/^tunnel-shard-(?:[0-9]|1[0-5])$/);
  });
});
