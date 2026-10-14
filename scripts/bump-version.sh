#!/usr/bin/env bash
# Bump the asset version (?v=N) everywhere in index.html, so browsers fetch fresh copies of
# every file (including lazy-loaded deep dives, visualizations and looks, which inherit it)
# after a deploy. Run it whenever you publish changes:  scripts/bump-version.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CUR="$(grep -o '?v=[0-9]*' "$ROOT/index.html" | head -1 | cut -d= -f2)"
NEXT=$((CUR + 1))
sed -i.bak "s/?v=$CUR\"/?v=$NEXT\"/g" "$ROOT/index.html" && rm -f "$ROOT/index.html.bak"
echo "asset version: v=$CUR -> v=$NEXT ($(grep -c "?v=$NEXT\"" "$ROOT/index.html") references in index.html)"
