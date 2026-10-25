#!/bin/bash
# Dtray startup script
# Starts the Node server + the Cloudflare named tunnel.
#
# The public hostname is NOT hardcoded here — it is read from the tunnel
# config so this file can live in a public repo without exposing (or
# advertising) the domain.
# Usage: bash start.sh

cd "$(dirname "$0")" || exit 1

CF_CONFIG="$HOME/.cloudflared/config.yml"
CF_BIN="C:/Users/Rx MHA/Downloads/cloudflared.exe"

# Public hostname comes from the tunnel ingress, never from this script.
PUBLIC_HOST=$(grep -m1 -E '^\s*-\s*hostname:' "$CF_CONFIG" 2>/dev/null | sed 's/.*hostname:[[:space:]]*//')

# Kill any existing instances
echo "Stopping any previous instances..."
pkill -f "node server.js" 2>/dev/null
pkill -f "cloudflared.*tunnel" 2>/dev/null
sleep 1

# Start the server
echo "Starting server on port 3000..."
node server.js &
SERVER_PID=$!
sleep 2

# Verify server is running
if ! curl -s --noproxy '*' -o /dev/null http://localhost:3000/ 2>/dev/null; then
  echo "Server failed to start. Check for errors above."
  kill $SERVER_PID 2>/dev/null
  exit 1
fi
echo "Server is running on http://localhost:3000"

echo ""
echo "Starting Cloudflare tunnel..."
if [ -n "$PUBLIC_HOST" ]; then
  echo "Public URL: https://$PUBLIC_HOST"
else
  echo "No hostname found in $CF_CONFIG"
fi
echo "========================================"
"$CF_BIN" tunnel run fileshare 2>&1 &

# Wait for either process to exit
wait
