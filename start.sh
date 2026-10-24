#!/bin/bash
# File share startup script
# Starts the Node server + Cloudflare quick tunnel with one command
# Usage: bash start.sh

cd "$(dirname "$0")"

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
if ! curl -s -o /dev/null -w "" http://localhost:3000/ 2>/dev/null; then
  echo "Server failed to start. Check for errors above."
  kill $SERVER_PID 2>/dev/null
  exit 1
fi
echo "Server is running on http://localhost:3000"

# Start cloudflared quick tunnel (no login, no CC, no bandwidth limit)
echo ""
echo "Starting Cloudflare tunnel..."
echo "Your public URL will appear below:"
echo "========================================"
"C:/Users/Rx MHA/Downloads/cloudflared.exe" tunnel --url http://localhost:3000 2>&1 &

# Wait for either process to exit
wait
