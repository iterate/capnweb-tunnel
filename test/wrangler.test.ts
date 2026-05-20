import { expect, test } from "vitest";

import { ExecError, type ExecOptions, type ExecResult, type exec } from "../src/cli/exec.js";
import { assertWranglerAuthenticated } from "../src/cli/wrangler.js";

test("Wrangler auth preflight skips whoami when CLOUDFLARE_API_TOKEN is set", async () => {
  let called = false;
  const execFn: typeof exec = async () => {
    called = true;
    throw new Error("unexpected exec");
  };

  await assertWranglerAuthenticated({
    cwd: "/repo",
    env: { CLOUDFLARE_API_TOKEN: "token" },
    execFn,
  });

  expect(called).toBe(false);
});

test("Wrangler auth preflight checks whoami silently", async () => {
  const calls: Array<[string, string[], ExecOptions]> = [];
  const execFn: typeof exec = async (command, args, options) => {
    calls.push([command, args, options]);
    return execResult(command, args, options.cwd);
  };

  await assertWranglerAuthenticated({ cwd: "/repo", env: {}, execFn });

  expect(calls).toHaveLength(1);
  expect(calls[0]?.[1].slice(-2)).toEqual(["whoami", "--json"]);
  expect(calls[0]?.[2]).toMatchObject({ cwd: "/repo", silent: true });
});

test("Wrangler auth preflight explains how to authenticate when whoami fails", async () => {
  const execFn: typeof exec = async (command, args, options) => {
    throw new ExecError(execResult(command, args, options.cwd, 1));
  };

  await expect(assertWranglerAuthenticated({ cwd: "/repo", env: {}, execFn })).rejects.toThrow(
    "Run `wrangler login` or `npx wrangler login` once, or set CLOUDFLARE_API_TOKEN",
  );
});

function execResult(command: string, args: string[], cwd: string, exitCode = 0): ExecResult {
  return {
    command,
    args,
    cwd,
    stdout: "",
    stderr: "",
    output: "",
    exitCode,
  };
}
