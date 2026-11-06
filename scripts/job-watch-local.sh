#!/usr/bin/env bash
# Kills real jobs on a real local Amp and checks that the job watch brings them back (WORK-577). See scripts/job-watch-local.ts.
#   scripts/job-watch-local.sh   Takes about 5 minutes. KEEP_LOGS=<dir> keeps the logs there.
# Everything it starts is in a temporary folder and its own Postgres container, and it all goes when it exits. It uses other
# ports than scripts/amp and scripts/reorg-local.sh, so they can keep running. It never talks to staging.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AMP_BIN="$HOME/.amp/bin"
ANVIL_PORT=18577
MAIN_RPC_PORT=18578
FORK_RPC_PORT=18579
FLIGHT_PORT=12602
ADMIN_PORT=12610
HEALTH_PORT=12620
POSTGRES_IMAGE="postgres:18.6-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5"

WORK="$(mktemp -d /tmp/pricetag-job-watch.XXXX)"
# Its own name, so another run's container is never this one's.
CONTAINER="pricetag-job-watch-${WORK##*.}"
ADMIN_URL="http://127.0.0.1:$ADMIN_PORT"
say() { printf '%s\n' "$*" >&2; }

cleanup() {
  local pid
  for pid in "$(cat "$WORK/ampd.pid" 2> /dev/null)" "$(cat "$WORK/anvil.pid" 2> /dev/null)"; do
    [ -n "$pid" ] && kill "$pid" 2> /dev/null || true
  done
  # Only the container this run created, by the ID it got back.
  if [ -s "$WORK/metadb.id" ]; then docker rm -f -v "$(cat "$WORK/metadb.id")" > /dev/null 2>&1 || true; fi
  # The logs are kept when asked, for evidence.
  if [ -n "${KEEP_LOGS:-}" ]; then
    mkdir -p "$KEEP_LOGS" && cp "$WORK"/*.log "$KEEP_LOGS"/ 2> /dev/null || true
  fi
  rm -rf "${WORK:?}"
}
trap cleanup EXIT

for port in "$ANVIL_PORT" "$MAIN_RPC_PORT" "$FORK_RPC_PORT" "$FLIGHT_PORT" "$ADMIN_PORT" "$HEALTH_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then say "error: port $port is in use."; exit 1; fi
done

say "Starting Anvil, a throwaway Postgres and ampd..."
(cd "$WORK"; nohup anvil --port "$ANVIL_PORT" --chain-id 8453 --block-time 1 --silent > "$WORK/anvil.log" 2>&1 < /dev/null & echo $! > "$WORK/anvil.pid")
metadb_id="$(docker run -d --rm --name "$CONTAINER" -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1::5432 "$POSTGRES_IMAGE")"
printf '%s' "$metadb_id" > "$WORK/metadb.id"
for _ in $(seq 1 60); do docker exec "$metadb_id" pg_isready -q -h 127.0.0.1 -U postgres && break; sleep 1; done
metadb_port="$(docker port "$metadb_id" 5432/tcp | sed 's/.*://' | head -n 1)"
mkdir -p "$WORK/amp/providers"
cat > "$WORK/amp/config.toml" <<EOF
[metadb]
url = "postgresql://postgres@127.0.0.1:$metadb_port/postgres"

[server]
flight_addr = "127.0.0.1:$FLIGHT_PORT"

[worker]
health_addr = "127.0.0.1:$HEALTH_PORT"
microbatch_max_interval = 50
segment_flush_interval_secs = 5

[controller]
admin_api_addr = "127.0.0.1:$ADMIN_PORT"
EOF
# A provider per dataset, each behind its own switchable proxy in the driver, so one job can die while the other runs.
for side in main fork; do
  port="$MAIN_RPC_PORT"
  [ "$side" = fork ] && port="$FORK_RPC_PORT"
  cat > "$WORK/amp/providers/$side.toml" <<EOF
kind = "evm-rpc"
network = "base-mainnet"
url = "http://127.0.0.1:$port"
concurrent_request_limit = 2
EOF
done
(cd "$WORK/amp"; set -m; env -u AMP_AUTH_TOKEN nohup "$AMP_BIN/ampd" solo --amp-dir "$WORK/amp" > "$WORK/ampd.log" 2>&1 < /dev/null & echo $! > "$WORK/ampd.pid")
for _ in $(seq 1 60); do curl -fsS --max-time 2 "$ADMIN_URL/providers" > /dev/null 2>&1 && break; sleep 1; done

# A new dataset name needs a new manifest hash, so they start at different blocks.
env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" manifest generate --kind evm-rpc --network base-mainnet --start-block 0 --out "$WORK/main.json" > /dev/null
env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" manifest generate --kind evm-rpc --network base-mainnet --start-block 1 --out "$WORK/fork.json" > /dev/null
env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" dataset register benface/watch_main "$WORK/main.json" --tag 0.0.1 > /dev/null
env -u AMP_AUTH_TOKEN AMP_ADMIN_URL="$ADMIN_URL" "$AMP_BIN/ampctl" dataset register benface/watch_fork "$WORK/fork.json" --tag 0.0.1 > /dev/null

ADMIN_URL="$ADMIN_URL" ANVIL_URL="http://127.0.0.1:$ANVIL_PORT" MAIN_RPC_PORT="$MAIN_RPC_PORT" FORK_RPC_PORT="$FORK_RPC_PORT" \
  node "$REPO_DIR/scripts/job-watch-local.ts" | tee "$WORK/driver.log"
