import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

await rewriteDeclarations("dist");

async function rewriteDeclarations(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteDeclarations(path);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;

    const source = await readFile(path, "utf8");
    const rewritten = source.replace(
      /((?:from|import)\s*["']\.{1,2}\/[^"']+)\.ts(["'])/g,
      "$1.js$2",
    );
    if (rewritten !== source) await writeFile(path, rewritten);
  }
}
