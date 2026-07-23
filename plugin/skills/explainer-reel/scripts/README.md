# `scripts/` — explainer-reel pipeline + verify loop

| Script | Origin | What it does |
|---|---|---|
| `render-gif.sh` | **new** (this skill) | The GIF pipeline: captures one frame per tick via the scene's `?t=N` seek harness, then FFmpeg two-pass `palettegen`/`paletteuse` → looping GIF. This is the piece `iart-ai/explainer-video-skills` doesn't ship (it stops at HTML/Remotion). |
| `seek-shot.sh` | vendored from `iart-ai/explainer-video-skills` (MIT) | Freezes the `?t=N` harness at given times and screenshots each — used for the contact-sheet verify loop, not the GIF itself. |
| `contact-sheet.sh` | vendored from `iart-ai/explainer-video-skills` (MIT) | Tiles frames side-by-side (start / mid / end) for one-glance review against the reference. |

## Author → verify → render

```bash
# 1. author the scene as one self-contained .html with a ?t=N seek harness (see ../examples/jwt-reel.html)

# 2. verify fidelity before rendering the GIF — freeze + tile + eyeball vs the reference
scripts/seek-shot.sh examples/jwt-reel.html 0 4 8 11
scripts/contact-sheet.sh /tmp/jwt-contact-sheet.png frame-0.png frame-4.png frame-8.png frame-11.png

# 3. render the primary deliverable — a looping GIF
scripts/render-gif.sh examples/jwt-reel.html 12 15 examples/jwt-reel.gif 480

# 4. optional: MP4 via Remotion (see diagram-animation's Heavy tier) — not required for the GIF path
```

## Requirements
- `npx` + Playwright Chromium (`npx playwright install chromium` once).
- `ffmpeg` / `ffprobe`.

Both vendored scripts are unmodified except for an attribution header. Re-sync them from
`iart-ai/explainer-video-skills` (`npx skills add iart-ai/explainer-video-skills -a claude-code -s
diagram-animation -y`, then copy `scripts/*.sh`) if upstream improves the verify loop.
