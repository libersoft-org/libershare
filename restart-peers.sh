#!/bin/bash
# Restart LiberShare peer nodes: N backends + 1 frontend
# Usage: ./restart-peers.sh [num_peers]  (default: 3)
cd "$(dirname "$0")"
ROOT=$(pwd)
PID_FILE="$ROOT/.peer-pids"
NUM_PEERS=${1:-3}

BASE_API_PORT=1158
BASE_P2P_PORT=9090
FRONTEND_PORT=6003

# Stop previous run — kill by port (MSYS2 $! gives wrong PIDs for taskkill)
echo "=== Stopping previous peers ==="
for port in $(seq $BASE_API_PORT $((BASE_API_PORT + 9))); do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} " | grep LISTEN | awk '{print $5}' | head -1)
  [ -n "$pid" ] && taskkill //F //PID "$pid" > /dev/null 2>&1
done
# Kill frontend
pid=$(netstat -ano 2>/dev/null | grep ":${FRONTEND_PORT} " | grep LISTEN | awk '{print $5}' | head -1)
[ -n "$pid" ] && taskkill //F //PID "$pid" > /dev/null 2>&1
# Also kill P2P ports
for port in $(seq $BASE_P2P_PORT $((BASE_P2P_PORT + 9))); do
  pid=$(netstat -ano 2>/dev/null | grep ":${port} " | grep LISTEN | awk '{print $5}' | head -1)
  [ -n "$pid" ] && taskkill //F //PID "$pid" > /dev/null 2>&1
done
sleep 2

> "$PID_FILE"

# Start backends
echo "=== Starting $NUM_PEERS backends ==="
for i in $(seq 1 "$NUM_PEERS"); do
  API_PORT=$((BASE_API_PORT + i - 1))
  DATADIR=".node$i"
  LOG="/tmp/libershare-node${i}.log"

  bun run backend/src/app.ts --datadir "$DATADIR" --port "$API_PORT" --host localhost > "$LOG" 2>&1 &
  sleep 3
  # Record Windows PID from netstat (not MSYS2 $!)
  WIN_PID=$(netstat -ano 2>/dev/null | grep ":${API_PORT} " | grep LISTEN | awk '{print $5}' | head -1)
  echo "${WIN_PID:-unknown}" >> "$PID_FILE"
  echo "  Node $i: backend :$API_PORT, datadir $DATADIR (PID: ${WIN_PID:-?})"
done
sleep 1

# Cross-connect all peers (GossipSub doesn't auto-mesh via bootstrap alone)
echo "=== Connecting peers ==="
for i in $(seq 1 "$NUM_PEERS"); do
  API_I=$((BASE_API_PORT + i - 1))
  for j in $(seq 1 "$NUM_PEERS"); do
    [ "$i" -eq "$j" ] && continue
    P2P_J=$((BASE_P2P_PORT + j - 1))
    # Get peer ID from node j's log
    PEER_ID=$(grep "Node ID:" /tmp/libershare-node${j}.log 2>/dev/null | head -1 | grep -oE '12D3[A-Za-z0-9]+')
    if [ -n "$PEER_ID" ]; then
      bun -e "const ws=new WebSocket('ws://localhost:$API_I');ws.onopen=()=>ws.send(JSON.stringify({id:'1',method:'lishnets.connect',params:{multiaddr:'/ip4/127.0.0.1/tcp/$P2P_J/p2p/$PEER_ID'}}));ws.onmessage=()=>ws.close();" 2>/dev/null
      echo "  Node $i -> Node $j (port $P2P_J)"
    fi
  done
done
sleep 2

# Start single frontend
echo "=== Starting frontend on :$FRONTEND_PORT ==="
cd "$ROOT/frontend"
VITE_BACKEND_URL="ws://localhost:$BASE_API_PORT" bun --bun run dev --host --port "$FRONTEND_PORT" > /tmp/libershare-fe.log 2>&1 &
cd "$ROOT"

echo -n "  Waiting for frontend"
for j in $(seq 1 30); do
  if curl -s "http://localhost:$FRONTEND_PORT" > /dev/null 2>&1; then
    echo " OK"
    break
  fi
  echo -n "."
  sleep 2
done
# Record frontend Windows PID
FE_PID=$(netstat -ano 2>/dev/null | grep ":${FRONTEND_PORT} " | grep LISTEN | awk '{print $5}' | head -1)
echo "${FE_PID:-unknown}" >> "$PID_FILE"
echo ""

# Status
echo ""
echo "=== Status ==="
for i in $(seq 1 "$NUM_PEERS"); do
  API_PORT=$((BASE_API_PORT + i - 1))
  if [ "$i" -eq 1 ]; then
    echo "  Node $i: http://localhost:$FRONTEND_PORT  (backend :$API_PORT, default)"
  else
    echo "  Node $i: http://localhost:$FRONTEND_PORT?backend=ws://localhost:$API_PORT"
  fi
done

echo ""
echo "Backend logs:"
for i in $(seq 1 "$NUM_PEERS"); do
  echo "  Node $i: $(tail -1 /tmp/libershare-node${i}.log 2>/dev/null)"
done

PROCS=$(wc -l < "$PID_FILE")
echo ""
echo "Tracked PIDs: $PROCS (saved to .peer-pids)"
