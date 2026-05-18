import { fileURLToPath } from "node:url";
import { defineConfig } from "vite-plus";

export default defineConfig({
  lint: {
    options: {
      typeAware: true,
      typeCheck: true,
    },
  },
  pack: {
    entry: {
      index: "src/index.ts",
      client: "src/client.ts",
      server: "src/server.ts",
      cli: "src/cli.ts",
    },
    dts: { build: true },
    deps: {
      neverBundle: ["cloudflare:workers"],
    },
    format: ["esm"],
    sourcemap: true,
  },
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./test/cloudflare-workers-shim.ts", import.meta.url).href,
      ),
      "captun/client": fileURLToPath(new URL("./src/client.ts", import.meta.url).href),
      "captun/server": fileURLToPath(new URL("./src/server.ts", import.meta.url).href),
    },
  },
  test: {
    include: ["*.test.ts", "test/**/*.test.ts", "examples/**/*.test.ts"],
  },
});
