import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const EXPECTED_RULE_CODES = [
  "captun(helpers-after-tests)",
  "captun(no-describe)",
  "captun(no-lifecycle-hooks)",
  "captun(no-vi-mock)",
  "captun(prefer-object-property-match)",
];

test("Captun test lint rules reject non-preferred test structure", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await using tempDir = await createTempDirFixture();
  const badTestFile = join(tempDir.path, "bad.test.ts");
  await writeFile(
    badTestFile,
    `
      import { beforeEach, describe, expect, test, vi } from "vitest";

      beforeEach(() => {});

      describe("wrapped tests", () => {});

      test("uses discouraged patterns", () => {
        expect([1, 2, 3].length).toBe(3);
      });

      function helper() {
        return { status: 200 };
      }

      test("uses more discouraged patterns", () => {
        vi.doMock("node:fs");
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

test("Captun test lint rules allow non-object property assertions and helpers below tests", async () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  await using tempDir = await createTempDirFixture();
  const goodTestFile = join(tempDir.path, "good.test.ts");
  await writeFile(
    goodTestFile,
    `
      import { expect, test } from "vitest";

      test("uses allowed property assertions", () => {
        const suite = {
          beforeEach() {
            return "setup";
          },
          afterAll() {
            return "teardown";
          },
        };
        const database = {
          mock() {
            return "mock";
          },
          doMock() {
            return "doMock";
          },
        };
        const items = [1, 2, 3];
        expect(items.length).toBe(3);
        const key = "status";
        const response = helper();
        expect(response[key]).toBe(200);
        expect(response).toMatchObject({ status: 200 });
        expect([suite.beforeEach(), suite.afterAll(), database.mock(), database.doMock()]).toEqual([
          "setup",
          "teardown",
          "mock",
          "doMock",
        ]);
      });

      function helper() {
        return { status: 200 };
      }
    `,
  );

  const result = await execFileResult(
    "pnpm",
    ["exec", "oxlint", goodTestFile, "-c", ".oxlintrc.json", "--threads", "1", "-f", "json"],
    repoRoot,
  );
  const report = JSON.parse(result.stdout) as any;

  expect(result).toMatchObject({ status: 0 });
  expect(report).toMatchObject({ diagnostics: [] });
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
      const status = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      resolve({ stdout, stderr, status });
    });
  });
}
