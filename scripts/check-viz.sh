#!/usr/bin/env bash
# Headless smoke test + screenshots for one visualization.
#
#   scripts/check-viz.sh ch5/quorum                 # errors + legibility + screenshots
#   scripts/check-viz.sh ch5/quorum --steps 4       # also screenshot after 4 stepper steps
#   scripts/check-viz.sh ch5/quorum --out /tmp/x    # where screenshots go (default: a temp dir)
#
# Prints a JSON summary. Exit code 1 if the viz throws, fails to mount, overflows
# horizontally on a phone, or renders SVG text smaller than 9px on a phone.
set -euo pipefail

ID="${1:?usage: check-viz.sh <chapter/name> [--steps N] [--out DIR]}"
shift
STEPS=0
OUT=""
SKIN="editorial"   # the site's default look; --skin classic tests the base stylesheet
while [[ $# -gt 0 ]]; do
  case "$1" in
    --steps) STEPS="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --skin) SKIN="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME" ]] || CHROME="$(command -v google-chrome || command -v chromium || true)"
[[ -n "$CHROME" ]] || { echo '{"ok":false,"errors":[{"error":"Chrome not found"}]}'; exit 1; }

SAFE="$(echo "$ID" | tr '/' '_')"
[[ -n "$OUT" ]] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/vizcheck.XXXXXX")"
mkdir -p "$OUT"
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/vizprof.XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT

URL="file://$ROOT/test/viz.html?id=$ID${SKIN:+&skin=$SKIN}"
# Every Chrome run gets a hard 90 s limit (macOS has no `timeout`), so one hung headless
# instance can't stall a whole test run; a killed run is reported as "no result".
chrome() {
  perl -e 'alarm shift; exec @ARGV' 90 "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check \
    --disable-extensions --mute-audio --user-data-dir="$PROFILE" "$@" 2>/dev/null
}
extract() { sed -n 's:.*<pre id="__result">\(.*\)</pre>.*:\1:p' | sed 's/&quot;/"/g; s/&lt;/</g; s/&gt;/>/g; s/&amp;/\&/g'; }

# 1) Monkey test at desktop width (clicks every control) -> runtime errors
DESK_JSON="$(chrome --virtual-time-budget=20000 --window-size=1000,1400 --dump-dom "$URL&width=820&click=1" | extract || true)"
# 2) Phone width, light theme -> legibility + overflow
PHONE_JSON="$(chrome --virtual-time-budget=6000 --window-size=390,1400 --dump-dom "$URL&theme=light&width=358" | extract || true)"
# 3) Screenshots (initial state)
chrome --virtual-time-budget=4000 --window-size=900,1600 --screenshot="$OUT/${SAFE}-desktop-dark.png" "$URL&width=860" >/dev/null || true
chrome --virtual-time-budget=4000 --window-size=390,1600 --screenshot="$OUT/${SAFE}-phone-light.png" "$URL&theme=light&width=358" >/dev/null || true
if [[ "$STEPS" != "0" ]]; then
  BUDGET=$(( 4000 + STEPS * 3000 ))
  chrome --virtual-time-budget="$BUDGET" --window-size=900,1600 --screenshot="$OUT/${SAFE}-desktop-steps${STEPS}.png" "$URL&width=860&steps=$STEPS" >/dev/null || true
fi

node -e '
const [desk, phone, out, safe, steps] = process.argv.slice(1);
const parse = s => { try { return JSON.parse(s); } catch (e) { return { ok: false, errors: [{ error: "no result from headless run (page crashed, script syntax error, or timed out): " + String(s).slice(0, 200) }] }; } };
const d = parse(desk), p = parse(phone);
const problems = [];
(d.errors || []).forEach(e => problems.push("desktop/monkey: " + e.error));
(p.errors || []).forEach(e => problems.push("phone: " + e.error));
if (d.mounted === false || p.mounted === false) problems.push("did not mount");
if (p.horizontalOverflow) problems.push(`phone: content overflows horizontally by ${p.horizontalOverflow}px`);
if (p.minSvgFontPx !== null && p.minSvgFontPx !== undefined && p.minSvgFontPx < 9) problems.push(`phone: SVG text renders at ${p.minSvgFontPx}px ("${p.minSvgFontText}") - too small; use a compact layout or larger font sizes`);
const shots = [`${out}/${safe}-desktop-dark.png`, `${out}/${safe}-phone-light.png`];
if (steps !== "0") shots.push(`${out}/${safe}-desktop-steps${steps}.png`);
const summary = { id: d.id || p.id, ok: problems.length === 0, problems, desktop: d, phone: p, screenshots: shots };
console.log(JSON.stringify(summary, null, 2));
process.exit(problems.length ? 1 : 0);
' "$DESK_JSON" "$PHONE_JSON" "$OUT" "$SAFE" "$STEPS"
