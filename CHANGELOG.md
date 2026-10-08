# Changelog

All notable changes to Squadrant (formerly claude-cockpit) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **npm package now ships the `obsidian/` hub/spoke templates** (#873). `init` and `projects add` no longer create empty hub/spoke directories ("Hub template not found") on a global install. A packaging test asserts the template paths are in `npm pack`.
- **`crew close` / `side close` now actually close the cmux tab** (#895). cmux 0.65 refuses `close-surface` on a surface with a live process; `closePane` now passes `--force`, treats an already-gone surface as success, and no longer swallows other errors — close prints a `(pane close failed: …)` warning and still cleans up the worktree.
