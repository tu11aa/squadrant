import { defineConfig } from "tsup";
import { fileURLToPath } from "url";
import path from "path";
import type { Plugin } from "esbuild";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sharedDist = path.resolve(__dirname, "packages/shared/dist/index.js");
const coreDist = path.resolve(__dirname, "packages/core/dist/index.js");
const agentsDist = path.resolve(__dirname, "packages/agents/dist/index.js");
const workspacesDist = path.resolve(__dirname, "packages/workspaces/dist/index.js");
const webDist = path.resolve(__dirname, "packages/web/dist/index.js");

// Resolve @squadrant/* directly to their dist outputs, bypassing the global
// Yarn PnP manifest which would otherwise intercept and block inlining.
const inlinePackagesPlugin: Plugin = {
  name: "inline-cockpit-packages",
  setup(build) {
    build.onResolve({ filter: /^@squadrant\/shared$/ }, () => ({
      path: sharedDist,
    }));
    build.onResolve({ filter: /^@squadrant\/core$/ }, () => ({
      path: coreDist,
    }));
    build.onResolve({ filter: /^@squadrant\/agents$/ }, () => ({
      path: agentsDist,
    }));
    build.onResolve({ filter: /^@squadrant\/workspaces$/ }, () => ({
      path: workspacesDist,
    }));
    build.onResolve({ filter: /^@squadrant\/web$/ }, () => ({
      path: webDist,
    }));
  },
};

export default defineConfig({
  entry: {
    index: "packages/cli/src/index.ts",            // -> dist/index.js  (cockpit bin)
    squadrantd: "packages/cli/src/squadrantd.ts", // -> dist/squadrantd.js (launchd daemon)
  },
  format: "esm",
  platform: "node",
  target: "node24",
  bundle: true,
  splitting: false,        // keep two independent self-contained bundles
  sourcemap: true,
  clean: true,
  dts: false,              // bin/daemon don't ship types; faster build
  // npm deps stay external (commander, chalk, etc.); @squadrant/* are inlined
  // via inlinePackagesPlugin which resolves them to their dist outputs.
  noExternal: ["@squadrant/shared", "@squadrant/core", "@squadrant/agents", "@squadrant/workspaces", "@squadrant/web"],
  esbuildPlugins: [inlinePackagesPlugin],
  // src/index.ts already has #!/usr/bin/env node; tsup preserves it. No banner needed.
});
