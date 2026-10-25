#!/bin/bash
GID=$(cat /tmp/gid.txt 2>/dev/null)
TOK=$(cat /tmp/tok.txt 2>/dev/null)
if [ -z "$GID" ] || [ -z "$TOK" ]; then
  G=$(curl -s -X POST http://localhost:3000/api/guest)
  GID=$(echo "$G" | sed 's/.*"guestId":"\([^"]*\)".*/\1/')
  TOK=$(echo "$G" | sed 's/.*"token":"\([^"]*\)".*/\1/')
  echo "$GID" > /tmp/gid.txt
  echo "$TOK" > /tmp/tok.txt
fi
echo "guest=$GID"

cd /tmp || exit 1
printf 'hello dtray upload test\n' > testup.txt

echo "=== SINGLE UPLOAD ==="
curl -s -H "x-guest-id: $GID" -H "x-guest-token: $TOK" \
  -H "Content-Type: text/plain" --data-binary @testup.txt \
  "http://localhost:3000/api/upload?name=testup.txt&type=text/plain"
echo
echo "=== CHUNKED INIT ==="
INIT=$(curl -s -X POST -H "x-guest-id: $GID" -H "x-guest-token: $TOK" \
  "http://localhost:3000/api/upload/init?name=big.bin&type=application/octet-stream")
echo "$INIT"
UPID=$(echo "$INIT" | sed 's/.*"uploadId":"\([^"]*\)".*/\1/')

echo "=== CHUNK 1 ==="
head -c 1048576 /dev/urandom > chunk1.bin
curl -s -H "x-guest-id: $GID" -H "x-guest-token: $TOK" \
  -H "Content-Type: application/octet-stream" --data-binary @chunk1.bin \
  "http://localhost:3000/api/upload/chunk?uploadId=$UPID&part=1"
echo

echo "=== CHUNK 2 ==="
head -c 1048576 /dev/urandom > chunk2.bin
curl -s -H "x-guest-id: $GID" -H "x-guest-token: $TOK" \
  -H "Content-Type: application/octet-stream" --data-binary @chunk2.bin \
  "http://localhost:3000/api/upload/chunk?uploadId=$UPID&part=2"
echo

echo "=== COMPLETE ==="
curl -s -X POST -H "x-guest-id: $GID" -H "x-guest-token: $TOK" \
  "http://localhost:3000/api/upload/complete?uploadId=$UPID"
echo
