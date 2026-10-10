"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var tsup_1 = require("tsup");
var url_1 = require("url");
var path_1 = require("path");
var __dirname = path_1.default.dirname((0, url_1.fileURLToPath)(import.meta.url));
var sharedDist = path_1.default.resolve(__dirname, "packages/shared/dist/index.js");
var coreDist = path_1.default.resolve(__dirname, "packages/core/dist/index.js");
var agentsDist = path_1.default.resolve(__dirname, "packages/agents/dist/index.js");
var workspacesDist = path_1.default.resolve(__dirname, "packages/workspaces/dist/index.js");
var webDist = path_1.default.resolve(__dirname, "packages/web/dist/index.js");
// Resolve @squadrant/* directly to their dist outputs, bypassing the global
// Yarn PnP manifest which would otherwise intercept and block inlining.
var inlinePackagesPlugin = {
    name: "inline-cockpit-packages",
    setup: function (build) {
        build.onResolve({ filter: /^@squadrant\/shared$/ }, function () { return ({
            path: sharedDist,
        }); });
        build.onResolve({ filter: /^@squadrant\/core$/ }, function () { return ({
            path: coreDist,
        }); });
        build.onResolve({ filter: /^@squadrant\/agents$/ }, function () { return ({
            path: agentsDist,
        }); });
        build.onResolve({ filter: /^@squadrant\/workspaces$/ }, function () { return ({
            path: workspacesDist,
        }); });
        build.onResolve({ filter: /^@squadrant\/web$/ }, function () { return ({
            path: webDist,
        }); });
    },
};
exports.default = (0, tsup_1.defineConfig)({
    entry: {
        index: "packages/cli/src/index.ts", // -> dist/index.js  (cockpit bin)
        squadrantd: "packages/cli/src/squadrantd.ts", // -> dist/squadrantd.js (launchd daemon)
    },
    format: "esm",
    platform: "node",
    target: "node24",
    bundle: true,
    splitting: false, // keep two independent self-contained bundles
    sourcemap: true,
    clean: true,
    dts: false, // bin/daemon don't ship types; faster build
    // npm deps stay external (commander, chalk, etc.); @squadrant/* are inlined
    // via inlinePackagesPlugin which resolves them to their dist outputs.
    noExternal: ["@squadrant/shared", "@squadrant/core", "@squadrant/agents", "@squadrant/workspaces", "@squadrant/web"],
    esbuildPlugins: [inlinePackagesPlugin],
    // src/index.ts already has #!/usr/bin/env node; tsup preserves it. No banner needed.
});
