#!/usr/bin/env bash
# Regenerate docs/media/*.png from the REAL renderer.
#
# Why not screenshot the packaged app: it would show your own sessions. This drives
# renderer/ (same HTML/CSS/JS the app ships) in headless Chrome with the Rust backend
# stubbed and a synthetic dataset — see fixture.js. Deterministic, and nothing private
# ever lands in the docs.
#
#   ./scripts/screenshots/capture.sh              # all shots → docs/media/
#   ./scripts/screenshots/capture.sh hero board   # only those
#   OUT=/tmp/shots ./scripts/screenshots/capture.sh   # write elsewhere (dry run)
#
# Env: CHROME (browser binary), PORT (default 8752), OUT (default docs/media).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${OUT:-$ROOT/docs/media}"
PORT="${PORT:-8752}"

# scene:file:width:height — banner LAST: it screenshots the landing page, which embeds
# the freshly written hero.png.
SHOTS=(
  "list:hero.png:1440:900"
  "light:light.png:1440:900"
  "rose:look-rose.png:1440:900"
  "board:board.png:1440:900"
  "settings:settings.png:1440:900"
  "terminal:terminal.png:1440:900"
  "banner:banner.png:1500:1000"
)

find_chrome() {
  if [ -n "${CHROME:-}" ]; then echo "$CHROME"; return; fi
  for c in \
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
    "/Applications/Chromium.app/Contents/MacOS/Chromium" \
    "$(command -v google-chrome || true)" \
    "$(command -v chromium || true)" \
    "$(command -v chromium-browser || true)"
  do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return; }
  done
  echo "ERROR: no Chrome/Chromium found — set CHROME=/path/to/browser" >&2
  exit 1
}
CHROME_BIN="$(find_chrome)"

WORK="$(mktemp -d)"
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# Web root: symlinks into the repo, so the renderer and the landing page are always the
# live ones — nothing here is a copy that could drift.
mkdir -p "$WORK/root/shots"
ln -s "$ROOT/renderer" "$WORK/root/app"
ln -s "$ROOT/docs" "$WORK/root/docs"
ln -s "$HERE/fixture.js" "$WORK/root/shots/fixture.js"

# The scene page IS renderer/index.html, with two lines injected: a <base> so relative
# assets resolve, and the fixture BEFORE lib/tauri-api.js (which destructures
# window.__TAURI__ at load, so the stub has to exist by then).
python3 - "$ROOT/renderer/index.html" "$WORK/root/shots/app.html" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
s = open(src).read()
assert s.count('<head>') == 1, 'renderer/index.html: no single <head>'
tag = '<script src="lib/tauri-api.js"></script>'
assert s.count(tag) == 1, 'renderer/index.html: tauri-api.js script tag moved'
s = s.replace('<head>', '<head>\n  <base href="/app/">', 1)
s = s.replace(tag, '<script src="/shots/fixture.js"></script>\n  ' + tag, 1)
open(dst, 'w').write(s)
PY

# no-store, else the browser serves a stale renderer between runs.
python3 - "$WORK/root" "$PORT" <<'PY' &
import http.server, socketserver, sys, os
os.chdir(sys.argv[1])
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()
    def log_message(self, *a): pass
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('127.0.0.1', int(sys.argv[2])), H) as s:
    s.serve_forever()
PY
SERVER_PID=$!
sleep 1

shoot() { # url out w h
  local url="$1" out="$2" w="$3" h="$4"
  rm -f "$out"
  rm -rf "$WORK/profile"
  # Chrome writes the PNG, then hangs on exit: this page keeps a live event loop, so its
  # virtual-time budget never drains. Launch detached, wait for the file to settle, kill.
  "$CHROME_BIN" --headless=new --disable-gpu --hide-scrollbars \
    --force-device-scale-factor=1 --window-size="$w,$h" \
    --virtual-time-budget=9000 --user-data-dir="$WORK/profile" \
    --screenshot="$out" "$url" >/dev/null 2>&1 &
  local pid=$! prev=-1 size
  for _ in $(seq 1 60); do
    sleep 1
    if [ -f "$out" ]; then
      size=$(wc -c < "$out")
      [ "$size" = "$prev" ] && [ "$size" -gt 1000 ] && break
      prev=$size
    fi
  done
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [ -f "$out" ] || { echo "  !! nothing written for $url" >&2; return 1; }
}

mkdir -p "$OUT"
want=("$@")
for entry in "${SHOTS[@]}"; do
  IFS=: read -r scene file w h <<< "$entry"
  if [ ${#want[@]} -gt 0 ] && [[ ! " ${want[*]} " == *" ${scene} "* ]]; then continue; fi
  if [ "$scene" = "banner" ]; then
    url="http://127.0.0.1:$PORT/docs/index.html"
  else
    url="http://127.0.0.1:$PORT/shots/app.html?scene=$scene"
  fi
  printf '%-10s → %s\n' "$scene" "$file"
  shoot "$url" "$OUT/$file" "$w" "$h"
  python3 - "$OUT/$file" "$w" "$h" <<'PY'
import struct, sys
w, h = struct.unpack('>II', open(sys.argv[1], 'rb').read(24)[16:24])
want = (int(sys.argv[2]), int(sys.argv[3]))
print(f"           {w}x{h}" + ("" if (w, h) == want else f"  !! expected {want[0]}x{want[1]}"))
PY
done

echo "Done → $OUT"
