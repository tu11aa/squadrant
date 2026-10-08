# Changelog

All notable changes to Squadrant (formerly claude-cockpit) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`doctor` no longer FAILs on optional dependencies** (#876, #875). The `superpowers`, `claude-mem` and `context7` plugins and the Obsidian app are now WARN (with what each enables) and never block a clean run; "hub reachable" remains the real gate. Install hints are now the exact commands (`/plugin install <name>@claude-plugins-official`; claude-mem marketplace add + install), and `init` step 3/5 and QUICKSTART mark the plugins optional.
- **npm package now ships the `obsidian/` hub/spoke templates** (#873). `init` and `projects add` no longer create empty hub/spoke directories ("Hub template not found") on a global install. A packaging test asserts the template paths are in `npm pack`.
- **`crew close` / `side close` now actually close the cmux tab** (#895). cmux 0.65 refuses `close-surface` on a surface with a live process; `closePane` now passes `--force`, treats an already-gone surface as success, and no longer swallows other errors — close prints a `(pane close failed: …)` warning and still cleans up the worktree.
