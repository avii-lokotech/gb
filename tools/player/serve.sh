#!/bin/zsh
# Serve the guitarbook folder locally and print the player URL.
# usage: tools/player/serve.sh [songs/Name.cho] [port]
# If a player server is already running on the port, just print the URL.
ROOT=${0:A:h:h:h}
SONG=${1:-songs/Madeline.cho}
PORT=${2:-8765}

while lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/tools/player/index.html" 2>/dev/null; then
    echo "Player server already running on port $PORT."
    echo "Player: http://localhost:$PORT/tools/player/?song=$SONG"
    exit 0
  fi
  echo "Port $PORT is used by something else, trying $((PORT + 1))…"
  PORT=$((PORT + 1))
done

echo "Player: http://localhost:$PORT/tools/player/?song=$SONG"
echo "(Ctrl-C to stop)"
exec python3 -m http.server $PORT --bind 127.0.0.1 --directory $ROOT
