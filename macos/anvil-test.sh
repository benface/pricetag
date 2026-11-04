#!/bin/sh
# `pnpm check:anvil`: runs the hot wallet's real signing and RPC code against a local fork of Base, with no funds anywhere.
# Each key in the test comes from the vault and is gone when it ends. Nothing touches the real chain except reading from it.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
port=${ANVIL_PORT:-18545}
fork_url=${BASE_RPC_URL:-https://mainnet.base.org}

command -v anvil >/dev/null || { echo "This needs Foundry's anvil: https://getfoundry.sh" >&2; exit 1; }

log=$(mktemp -t patina-anvil)
anvil --fork-url "$fork_url" --port "$port" --silent >"$log" 2>&1 &
anvil_pid=$!
trap 'kill "$anvil_pid" 2>/dev/null || true; rm -f "$log"' EXIT INT TERM

tries=0
until curl -fs -o /dev/null -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "http://127.0.0.1:$port"; do
  tries=$((tries + 1))
  [ "$tries" -lt 100 ] || { echo "anvil didn't start" >&2; cat "$log" >&2; exit 1; }
  sleep 0.3
done

ANVIL_RPC_URL="http://127.0.0.1:$port" BASE_READ_RPC_URL="$fork_url" swift test --package-path "$here/HotWalletKit" --filter 'AnvilTests|LiveBaseTests'
