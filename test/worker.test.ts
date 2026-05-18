import { describe, expect, test } from "vitest";
import { tunnelRouteParts } from "../src/worker";

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
  ];

  test.each(cases)("%s%s -> %s %s", (hostname, path, tunnelName, forwardedPath) => {
    expect(tunnelRouteParts(hostname, path)).toEqual(
      tunnelName ? { name: tunnelName, path: forwardedPath } : undefined,
    );
  });
});
