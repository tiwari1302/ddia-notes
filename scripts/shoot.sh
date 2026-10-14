#!/usr/bin/env bash
# Screenshot pages as a reader sees them, as readable tiles (one screenful each).
#   scripts/shoot.sh ch5                      # every deep-dive part: hook, each section, takeaways
#   scripts/shoot.sh ch5 --only quorum-limits # one part (a section id, "hook" or "takeaways")
#   scripts/shoot.sh '#/viz'                  # any page by route: '#/', '#/quiz', '#/glossary',
#                                             #   '#/cheatsheet', '#/ch5/concepts', '#/ch5/interview', ...
#   --phone        phone layout (390px wide, light theme) instead of desktop (1280px, dark theme)
#   --out DIR      output directory (default: a temp dir)
#   --skin NAME    render with skins/NAME.css (default: the base look)
#   --theme T      force light or dark (default: dark on desktop, light on phone)
# Prints one PNG path per tile. Every visualization is mounted, in its first frame.
set -euo pipefail
TARGET="${1:?usage: shoot.sh <chapter|#/route> [--only <part>] [--phone] [--out DIR]}"; shift
ONLY=""; OUT=""; PHONE=0; SKIN=""; THEME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only) ONLY="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --phone) PHONE=1; shift ;;
    --skin) SKIN="$2"; shift 2 ;;
    --theme) THEME="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -n "$OUT" ]] || OUT="$(mktemp -d "${TMPDIR:-/tmp}/shoot.XXXXXX")"
mkdir -p "$OUT"
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/shootprof.XXXXXX")"
trap 'rm -rf "$PROFILE"' EXIT
# Headless Chrome can't make windows narrower than ~500px, so the phone layout is drawn
# 390px wide (?w=390) inside a 520px window and cropped. (sips treats a 0 x-offset as
# "center the crop", hence offset 1.)
if [[ $PHONE == 1 ]]; then W=390; WIN=520; TILE=1300; Q="theme=light&w=390"; TAG=phone; else W=1280; WIN=1280; TILE=1100; Q="theme=dark"; TAG=desktop; fi
[[ -n "$THEME" ]] && Q="$(echo "$Q" | sed "s/theme=[a-z]*/theme=$THEME/")"
[[ -n "$SKIN" ]] && { Q="$Q&skin=$SKIN"; TAG="$SKIN-$TAG"; }
[[ -n "$THEME" ]] && TAG="$TAG-$THEME"
chrome() { "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --user-data-dir="$PROFILE" "$@" 2>/dev/null; }

shoot_url() { # $1 = base url (with ?...), $2 = file prefix
  local base="$1" prefix="$2" H y i h
  H="$(chrome --virtual-time-budget=6000 --window-size=$WIN,$TILE --dump-dom "$base" | sed -n 's:.*<title>H\:\([0-9]*\)</title>.*:\1:p' | head -1)"
  [[ -n "$H" ]] || H=$TILE
  y=0; i=1
  while (( y < H )); do
    h=$(( H - y < TILE ? H - y : TILE )); (( h < 200 )) && h=200
    local f="$OUT/${prefix}-${TAG}-$(printf %02d $i).png"
    chrome --virtual-time-budget=6000 --window-size=$WIN,$h --screenshot="$f.tmp.png" "${base/\?/?y=$y&}" >/dev/null || true
    if [[ -f "$f.tmp.png" ]]; then
      if [[ $WIN != $W ]]; then sips -c $h $W --cropOffset 0 1 "$f.tmp.png" --out "$f" >/dev/null 2>&1; rm -f "$f.tmp.png"; else mv "$f.tmp.png" "$f"; fi
      echo "$f"
    fi
    y=$(( y + TILE )); i=$(( i + 1 ))
  done
}

if [[ "$TARGET" == \#* ]]; then
  SAFE="$(echo "$TARGET" | tr -c 'a-zA-Z0-9-' '_' | sed 's/^_*//;s/_*$//')"; [[ -n "$SAFE" ]] || SAFE=dashboard
  shoot_url "file://$ROOT/index.html?shoot=1&$Q$TARGET" "$SAFE"
  exit 0
fi
CH="$TARGET"
if [[ -n "$ONLY" ]]; then PARTS="$ONLY"; else
  PARTS="hook $(node -e '
    const fs=require("fs"),vm=require("vm"),p=require("path");const R=process.argv[1],ch=process.argv[2];
    const sb={window:{}};sb.window.window=sb.window;vm.createContext(sb);
    vm.runInContext(fs.readFileSync(p.join(R,"core/registry.js"),"utf8"),sb);sb.DDIA=sb.window.DDIA;
    for (const f of [ch+".js",ch+".deep.js",ch+".deep2.js"]) { const fp=p.join(R,"chapters",f); if (fs.existsSync(fp)) vm.runInContext(fs.readFileSync(fp,"utf8"),sb); }
    const c=sb.window.DDIA.chapter(ch); console.log(((c.deepDive&&c.deepDive.sections)||[]).map(s=>s.id).join(" "));
  ' "$ROOT" "$CH") takeaways"
fi
for part in $PARTS; do
  shoot_url "file://$ROOT/index.html?only=$part&$Q#/$CH/learn" "${CH}-${part}"
done
