#!/usr/bin/env bash
# ATO-229 — a throwaway update feed for an A -> B update test on one Mac.
#
#   desktop/scripts/serve-test-feed.sh <dir> [port]
#
# Serves <dir> over plain http on 127.0.0.1 (default port 8765) with
# python3's http.server, until Ctrl+C. Put the B build's update files in
# <dir>/desktop/ (stable-mac.yml, the *-mac.zip and its .blockmap) and build A
# with feed_url = http://127.0.0.1:<port>/desktop/ . Test only: no TLS, local
# address only, every request is logged.
set -euo pipefail

dir="${1:-}"
port="${2:-8765}"
if [[ -z "$dir" || ! -d "$dir" ]]; then
  echo "usage: $0 <dir> [port]   (dir must exist)" >&2
  exit 2
fi
if ! [[ "$port" =~ ^[0-9]+$ ]]; then
  echo "port must be a number (got: $port)" >&2
  exit 2
fi
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

echo "Serving $(cd "$dir" && pwd) at http://127.0.0.1:$port/  (Ctrl+C to stop)"
ls -la "$dir" "$dir/desktop" 2>/dev/null || true
exec python3 -m http.server "$port" --bind 127.0.0.1 --directory "$dir"
