import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXPECTED_RULE_CODES = [
  "captun-test(helpers-after-tests)",
  "captun-test(no-describe)",
  "captun-test(no-lifecycle-hooks)",
  "captun-test(no-vi-mock)",
  "captun-test(prefer-object-property-match)",
];

test("Captun test lint rules reject non-preferred test structure", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await using tempDir = await createTempDirFixture();
  const badTestFile = join(tempDir.path, "bad.test.ts");
  await writeFile(
    badTestFile,
    `
      import { beforeEach, describe, expect, test, vi } from "vitest";

      function helper() {
        return { status: 200 };
      }

      beforeEach(() => {});

      describe("wrapped tests", () => {});

      test("uses discouraged patterns", () => {
        vi.mock("node:fs");
        const response = helper();
        expect(response.status).toBe(200);
      });
    `,
  );

  const result = await execFileResult(
    "pnpm",
    ["exec", "oxlint", badTestFile, "-c", ".oxlintrc.json", "--threads", "1", "-f", "json"],
    repoRoot,
  );
  const report = JSON.parse(result.stdout) as any;
  const codes = report.diagnostics.map((diagnostic: any) => diagnostic.code).sort();

  expect(result).toMatchObject({ status: 1 });
  expect(codes).toEqual(expect.arrayContaining(EXPECTED_RULE_CODES));
});

async function createTempDirFixture() {
  const path = await mkdtemp(join(tmpdir(), "captun-oxlint-"));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
}

async function execFileResult(command: string, args: string[], cwd: string) {
  return new Promise<{ stdout: string; stderr: string; status: number }>((resolve) => {
    execFile(command, args, { cwd }, (error, stdout, stderr) => {
      const status = typeof error?.code === "number" ? error.code : 0;
      resolve({ stdout, stderr, status });
    });
  });
}
