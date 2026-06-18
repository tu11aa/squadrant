import { defineConfig } from "tsup";
import { fileURLToPath } from "url";
import path from "path";
import type { Plugin } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedDist = path.resolve(__dirname, "packages/shared/dist/index.js");
const coreDist = path.resolve(__dirname, "packages/core/dist/index.js");
const agentsDist = path.resolve(__dirname, "packages/agents/dist/index.js");

// Resolve @cockpit/* directly to their dist outputs, bypassing the global
// Yarn PnP manifest which would otherwise intercept and block inlining.
const inlinePackagesPlugin: Plugin = {
  name: "inline-cockpit-packages",
  setup(build) {
    build.onResolve({ filter: /^@cockpit\/shared$/ }, () => ({
      path: sharedDist,
    }));
    build.onResolve({ filter: /^@cockpit\/core$/ }, () => ({
      path: coreDist,
    }));
    build.onResolve({ filter: /^@cockpit\/agents$/ }, () => ({
      path: agentsDist,
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
  // npm deps stay external (commander, chalk, etc.); @cockpit/* are inlined
  // via inlinePackagesPlugin which resolves them to their dist outputs.
  noExternal: ["@cockpit/shared", "@cockpit/core", "@cockpit/agents"],
  esbuildPlugins: [inlinePackagesPlugin],
  // src/index.ts already has #!/usr/bin/env node; tsup preserves it. No banner needed.
});
