#!/usr/bin/env bash
# Forces reorgs through a real local Amp, on an Anvil fork of Base, and checks what the dataset and the SDK do (WORK-497).
#   scripts/reorg-local.sh [depth...]   Depths default to 5 100 250 350 600. See scripts/reorg-local.ts.
#   AMP_COMPACTION=off turns Amp's compactor off, and KEEP_LOGS=<dir> keeps the logs there.
# Everything it starts is in a temporary folder and its own Postgres container, and it all goes when it exits. It uses
# other ports than scripts/amp, so a local Amp started for the app can keep running.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AMP_BIN="$HOME/.amp/bin"
FORK_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
ANVIL_PORT=18597
FLIGHT_PORT=11602
ADMIN_PORT=11610
CONTAINER="pricetag-reorg-metadb"
POSTGRES_IMAGE="postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5"

WORK="$(mktemp -d /tmp/pricetag-reorg.XXXX)"
ANVIL_URL="http://127.0.0.1:$ANVIL_PORT"
ADMIN_URL="http://127.0.0.1:$ADMIN_PORT"
say() { printf '%s\n' "$*" >&2; }
ampctl() { env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" "$@" > /dev/null; }
rpc() { curl -fsS -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$ANVIL_URL"; }

cleanup() {
  local pid
  for pid in "$(cat "$WORK/ampd.pid" 2> /dev/null)" "$(cat "$WORK/anvil.pid" 2> /dev/null)"; do
    [ -n "$pid" ] && kill "$pid" 2> /dev/null || true
  done
  docker rm -f -v "$CONTAINER" > /dev/null 2>&1 || true
  # The logs are kept when asked, for evidence.
  if [ -n "${KEEP_LOGS:-}" ]; then
    mkdir -p "$KEEP_LOGS" && cp "$WORK"/*.log "$KEEP_LOGS"/ 2> /dev/null || true
  fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

for port in "$ANVIL_PORT" "$FLIGHT_PORT" "$ADMIN_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then say "error: port $port is in use."; exit 1; fi
done

say "Starting an Anvil fork of Base, mining only when asked..."
(cd "$WORK"; nohup anvil --fork-url "$FORK_URL" --port "$ANVIL_PORT" --no-mining --silent > "$WORK/anvil.log" 2>&1 < /dev/null & echo $! > "$WORK/anvil.pid")
for _ in $(seq 1 60); do rpc eth_blockNumber '[]' > /dev/null 2>&1 && break; sleep 0.5; done
rpc anvil_mine '["0x1"]' > /dev/null
START_BLOCK=$(( $(rpc eth_blockNumber '[]' | jq -r .result) ))

say "Starting a throwaway Postgres and ampd..."
docker run -d --rm --name "$CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 "$POSTGRES_IMAGE" > /dev/null
for _ in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1; done
metadb_port="$(docker port "$CONTAINER" 5432/tcp | sed 's/.*://' | head -n 1)"
mkdir -p "$WORK/amp/providers"
# The same worker settings as scripts/amp.
cat > "$WORK/amp/config.toml" <<EOF
[metadb]
url = "postgresql://postgres@127.0.0.1:$metadb_port/postgres"

[server]
flight_addr = "127.0.0.1:$FLIGHT_PORT"

[worker]
health_addr = "127.0.0.1:11620"
microbatch_max_interval = 50
segment_flush_interval_secs = 20

[controller]
admin_api_addr = "127.0.0.1:$ADMIN_PORT"
EOF
# To see whether compaction is what a deep reorg trips on.
if [ "${AMP_COMPACTION:-on}" = off ]; then printf '\n[writer.compactor]\nactive = false\n' >> "$WORK/amp/config.toml"; fi
cat > "$WORK/amp/providers/base.toml" <<EOF
kind = "evm-rpc"
network = "base-mainnet"
url = "$ANVIL_URL"
concurrent_request_limit = 8
EOF
(cd "$WORK/amp"; set -m; env -u AMP_AUTH_TOKEN nohup "$AMP_BIN/ampd" solo --amp-dir "$WORK/amp" > "$WORK/ampd.log" 2>&1 < /dev/null & echo $! > "$WORK/ampd.pid")
for _ in $(seq 1 60); do curl -fsS --max-time 2 "$ADMIN_URL/providers" > /dev/null 2>&1 && break; sleep 1; done

say "Deploying the raw dataset and Pricetag from block $START_BLOCK..."
env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" manifest generate --kind evm-rpc --network base-mainnet --start-block "$START_BLOCK" --out "$WORK/base_mainnet.json" > /dev/null
ampctl dataset register edgeandnode/base_mainnet "$WORK/base_mainnet.json" --tag 0.0.2
ampctl dataset deploy edgeandnode/base_mainnet@0.0.2
node "$REPO_DIR/dataset/local.ts" "$START_BLOCK" "$ANVIL_URL" > "$WORK/pricetag.json"
ampctl dataset register benface/pricetag "$WORK/pricetag.json" --tag 0.0.1
ampctl dataset deploy benface/pricetag@0.0.1

ANVIL_URL="$ANVIL_URL" FLIGHT_URL="http://127.0.0.1:$FLIGHT_PORT" START_BLOCK="$START_BLOCK" \
  node "$REPO_DIR/scripts/reorg-local.ts" "$@" | tee "$WORK/driver.log"
