#!/usr/bin/env bash
# Run scripts/check-viz.sh on every visualization embedded in the book, a few at a time.
#   scripts/check-all-viz.sh            # all chapters
#   scripts/check-all-viz.sh ch5 ch7    # some chapters
#   SKIN=terminal scripts/check-all-viz.sh   # under a specific look (default: the site default)
# Prints one line per viz and a summary; exit code 1 if any fail. Details for failures are
# kept in the output directory it prints.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$(mktemp -d "${TMPDIR:-/tmp}/allviz.XXXXXX")"
JOBS="${JOBS:-4}"
IDS="$(node -e '
  const m = require("fs").readFileSync(process.argv[1] + "/core/manifest.js", "utf8");
  const M = JSON.parse(m.slice(m.indexOf("{"), m.lastIndexOf("}") + 1));
  const want = process.argv.slice(2);
  for (const [ch, e] of Object.entries(M)) if (!want.length || want.includes(ch)) e.viz.forEach(v => console.log(v.id));
' "$ROOT" "$@")"
check_one() {
  local id="$1" out="$2" root="$3" safe
  safe="$(echo "$id" | tr '/' '_')"
  if "$root/scripts/check-viz.sh" "$id" --steps 2 ${SKIN:+--skin "$SKIN"} --out "$out/$safe" > "$out/$safe.json" 2>&1; then
    echo "✓ $id"
  else
    echo "✗ $id   ($(node -e 'try{const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.problems.join(" | ").slice(0,300))}catch(e){console.log("no result")}' "$out/$safe.json"))"
  fi
}
export -f check_one
export SKIN="${SKIN:-}"
RESULTS="$(echo "$IDS" | xargs -P "$JOBS" -I{} bash -c 'check_one "$@"' _ {} "$OUT" "$ROOT")"
echo "$RESULTS" | sort
TOTAL=$(echo "$RESULTS" | grep -c . || true)
FAILED=$(echo "$RESULTS" | grep -c '^✗' || true)
echo "---"
echo "$((TOTAL - FAILED))/$TOTAL visualizations passed. Details: $OUT"
[[ "$FAILED" == 0 ]]
