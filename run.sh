#!/usr/bin/env bash
# Start the karaoke machine. First run sets up a local Python environment with yt-dlp.
#   ./run.sh           start (opens the control panel in your browser)
#   ./run.sh --update  update yt-dlp first (do this if search stops working)
#   ./run.sh --title "Jo's Karaoke Night"   use your own title (also: --port, --no-browser)
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -x .venv/bin/python ]; then
  echo "First run: setting up .venv with yt-dlp…"
  if command -v uv >/dev/null; then uv venv -q .venv; else python3 -m venv .venv; fi
  NEED_INSTALL=1
fi

if [ "${1:-}" = "--update" ] || [ -n "${NEED_INSTALL:-}" ]; then
  [ "${1:-}" = "--update" ] && shift
  if command -v uv >/dev/null; then uv pip install -q -U --python .venv/bin/python yt-dlp
  else .venv/bin/python -m pip install -q -U yt-dlp; fi
fi

exec .venv/bin/python server.py "$@"
