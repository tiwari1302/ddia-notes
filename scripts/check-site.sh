#!/usr/bin/env bash
# Whole-site smoke test in headless Chrome: renders every page/tab, mounts every
# visualization, expands every Q&A, and reports any runtime errors as JSON.
#   scripts/check-site.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/siteprof.XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT
"$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check --user-data-dir="$PROFILE" \
  --virtual-time-budget=300000 --window-size=1300,1000 --dump-dom "file://$ROOT/index.html?selftest=1" 2>/dev/null \
| node -e '
let html = ""; process.stdin.on("data", d => html += d).on("end", () => {
  const m = html.match(/<pre id="__result"[^>]*>([\s\S]*?)<\/pre>/);
  const unesc = s => s.replace(/&quot;/g, "\"").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  let r;
  try { r = JSON.parse(unesc(m[1])); } catch (e) { console.log(JSON.stringify({ ok: false, error: "no self-test result (page crashed or timed out)" })); process.exit(1); }
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
});'
