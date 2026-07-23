#!/usr/bin/env bash
# render-gif.sh — explainer-reel's GIF pipeline (the part the engine doesn't ship).
#
# Drives the scene's `?t=N` seek harness (same contract as diagram-animation's seek-shot.sh) to
# capture one screenshot per frame across a fixed duration/fps, then encodes them into a looping
# GIF with FFmpeg two-pass palettegen/paletteuse (plain GIF export bands badly on neon-on-black).
#
# Usage:
#   scripts/render-gif.sh <file.html> <duration_s> <fps> <out.gif> [width] [viewport WxH]
#   scripts/render-gif.sh examples/jwt-reel.html 12 15 examples/jwt-reel.gif 480 400,640
#
# [viewport WxH] should match the scene's stage pixel size (e.g. the `.er-stage` width/height in
# your HTML) so the capture is a tight crop instead of a full 1280x720 browser window.
#
# Needs: npx (Playwright auto-fetches Chromium on first run), ffmpeg.
set -euo pipefail
html="${1:?usage: render-gif.sh <file.html> <duration_s> <fps> <out.gif> [width] [viewport WxH]}"
duration="${2:?duration in seconds}"
fps="${3:?frames per second}"
out="${4:?output .gif path}"
width="${5:-480}"
viewport="${6:-480,854}"

abs="$(cd "$(dirname "$html")" && pwd)/$(basename "$html")"
outdir="$(cd "$(dirname "$out")" && pwd)"
frames_dir="$(mktemp -d)"
trap 'rm -rf "$frames_dir"' EXIT

n_frames=$(awk -v d="$duration" -v f="$fps" 'BEGIN{printf "%d", d*f}')
echo "capturing ${n_frames} frames at ${fps}fps over ${duration}s (viewport ${viewport})..."
for ((i = 0; i < n_frames; i++)); do
  t=$(awk -v i="$i" -v f="$fps" 'BEGIN{printf "%.4f", i/f}')
  frame=$(printf '%s/frame-%05d.png' "$frames_dir" "$i")
  npx -y playwright screenshot --viewport-size="$viewport" --wait-for-timeout=80 "file://${abs}?t=${t}" "$frame" >/dev/null 2>&1
done
echo "  ✓ ${n_frames} frames captured"

palette="${frames_dir}/palette.png"
ffmpeg -y -framerate "$fps" -i "${frames_dir}/frame-%05d.png" \
  -vf "scale=${width}:-1:flags=lanczos,palettegen=stats_mode=diff" "$palette" -loglevel error
ffmpeg -y -framerate "$fps" -i "${frames_dir}/frame-%05d.png" -i "$palette" \
  -lavfi "scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=sierra2_4a" \
  -loop 0 "${outdir}/$(basename "$out")" -loglevel error
echo "  ✓ GIF → ${out}"
