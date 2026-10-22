#!/usr/bin/env bash
# Run PageVault on macOS: start the local sync server and open the reader UI.
set -e
cd "$(dirname "$0")/server"
PORT="${PORT:-8731}" node server.js &
PID=$!
sleep 1
open "http://localhost:$PORT"
trap "kill $PID 2>/dev/null" EXIT INT TERM
echo "PageVault running on http://localhost:$PORT  (Ctrl-C to stop)"
wait $PID
