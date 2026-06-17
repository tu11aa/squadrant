import { defineConfig } from "tsup";
import { fileURLToPath } from "url";
import path from "path";
import type { Plugin } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedDist = path.resolve(__dirname, "packages/shared/dist/index.js");

// Resolve @cockpit/shared directly to its dist output, bypassing the global
// Yarn PnP manifest which would otherwise intercept and block inlining.
const inlineSharedPlugin: Plugin = {
  name: "inline-cockpit-shared",
  setup(build) {
    build.onResolve({ filter: /^@cockpit\/shared$/ }, () => ({
      path: sharedDist,
    }));
  },
};

export default defineConfig({
  entry: {
    index: "src/index.ts",            // -> dist/index.js  (cockpit bin)
    cockpitd: "src/control/cockpitd.ts", // -> dist/cockpitd.js (launchd daemon)
  },
  format: "esm",
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,        // keep two independent self-contained bundles
  sourcemap: true,
  clean: true,
  dts: false,              // bin/daemon don't ship types; faster build
  // npm deps stay external (commander, chalk, etc.); @cockpit/shared is inlined
  // via inlineSharedPlugin which resolves it to packages/shared/dist/index.js.
  noExternal: ["@cockpit/shared"],
  esbuildPlugins: [inlineSharedPlugin],
  // src/index.ts already has #!/usr/bin/env node; tsup preserves it. No banner needed.
});
