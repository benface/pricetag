#!/bin/sh
# Runs a command that compiles Swift, one at a time across every worktree on this Mac, because several at once slow each other down.
# Usage: macos/swift-queue.sh <command> [arguments]. How to run it from an agent is in TESTING.md.
#
# The lock is held by a lockf, which frees it however it ends, and its children don't inherit it, so a stray can't keep it. But killing
# lockf leaves its command compiling, and swift test's helper outlives swift test, in its own process group. macOS hides the environment
# of Apple's binaries, so a marker there can't find them. So this keeps a list of everything descended from the command, by PID and start
# time, while it's still a family. It finds them that way with no parent left, and it never signals a process that isn't on the list.
set -u

# A check's own builds are already part of its turn.
[ -z "${SWIFT_QUEUE_TURN:-}" ] || exec "$@"

here=$(cd "$(dirname "$0")" && pwd)
self="$here/$(basename "$0")"
repo=$(dirname "$here")
dir=${SWIFT_QUEUE_DIR:-$HOME/Library/Caches/patina-swift-queue}

say() { echo "[swift-queue] $*" >&2; }

elapsed() { # seconds
  if [ "$1" -ge 60 ]; then echo "$(($1 / 60))m$(($1 % 60))s"; else echo "$1s"; fi
}

# Everything alive that's descended from the command or from something already on the list, which also goes in the list.
job_pids() {
  [ -r "$run/root" ] || return 0
  ps -axo pid=,ppid=,stat=,lstart= | awk -v root="$(cat "$run/root")" -v known="$run/pids" '
    BEGIN { while ((getline line < known) > 0) listed[line] = 1 }
    {
      pid[NR] = $1
      parent[$1] = $2
      key[$1] = $1 " " $4 " " $5 " " $6 " " $7 " " $8
      zombie[$1] = $3 ~ /^Z/
      if (key[$1] in listed) job[$1] = 1
    }
    END {
      job[root] = 1
      do {
        changed = 0
        for (i = 1; i <= NR; i++) if (!(pid[i] in job) && (parent[pid[i]] in job)) { job[pid[i]] = 1; changed = 1 }
      } while (changed)
      for (p in job) if ((p in key) && !zombie[p]) print key[p]
    }' >"$run/pids.$$" 2>/dev/null && mv "$run/pids.$$" "$run/pids" 2>/dev/null && cut -d ' ' -f 1 "$run/pids"
}

stop_job() {
  tries=0
  while pids=$(job_pids) && [ -n "$pids" ]; do
    # shellcheck disable=SC2086
    case $tries in
      0) kill -TERM $pids 2>/dev/null ;;
      50) kill -KILL $pids 2>/dev/null ;;
      70)
        say "Couldn't stop $pids."
        return
        ;;
    esac
    tries=$((tries + 1))
    sleep 0.1
  done
}

# What lockf runs once it has the lock. It stays until the job's processes are gone, so the next turn never starts alongside them.
if [ "${1:-}" = --turn ]; then
  run=$2
  label=$3
  queued_at=$4
  shift 4
  now=$(date +%s)
  printf '%s\n' "$PPID" "$now" "$label" "$repo" >"$run/holder"
  mv "$run/holder" "$dir/holder"
  echo "$now" >"$run/turn"
  [ $((now - queued_at)) -lt 2 ] || say "It's this run's turn, after waiting $(elapsed $((now - queued_at))): $label"
  trap 'stop_job; exit 143' TERM
  trap 'stop_job; exit 130' INT
  trap 'stop_job; exit 129' HUP
  SWIFT_QUEUE_TURN=1 "$@" &
  echo $! >"$run/root"
  wait $!
  status=$?
  stop_job
  exit "$status"
fi

[ $# -ge 1 ] || {
  echo "Usage: swift-queue.sh <command> [arguments]" >&2
  exit 64
}

label=${npm_lifecycle_event:+pnpm $npm_lifecycle_event}
label=${label:-$*}
queued_at=$(date +%s)
# Leaves time for the command itself inside an agent's 10-minute limit. Someone at a terminal can just press Ctrl-C.
if [ -t 0 ]; then default_wait=; else default_wait=240; fi
max_wait=${SWIFT_QUEUE_WAIT-$default_wait}

mkdir -p "$dir"
run=$(mktemp -d "$dir/job.XXXXXX") || exit 73

no_result() {
  if [ -e "$run/turn" ]; then
    echo "$label was stopped partway, so it has no result. It didn't pass or fail: run it again."
  else
    echo "$label was stopped while waiting, so it never ran and has no result. It didn't pass or fail: run it again."
  fi
}

waiting_message() {
  now=$(date +%s)
  if [ -r "$dir/holder" ] && { read -r pid && read -r since && read -r holder && read -r where; } <"$dir/holder"; then
    say "Waiting $(elapsed $((now - queued_at))) so far, not hung: $holder from $where has been running for $(elapsed $((now - since))) (lockf pid $pid)."
  else
    say "Waiting $(elapsed $((now - queued_at))) so far, not hung: another Swift build has the lock."
  fi
}

# Outlives this script, however it's killed, to clean up after it. So it's not this script's child, or in its process group, either of
# which would be killed along with it. It holds on to stderr to say what happened, so it's gone as soon as this script is done.
watch() {
  ticks=0
  while [ -e "$run" ]; do
    if ! kill -0 "$script" 2>/dev/null || { [ "$parent" -ne 1 ] && ! kill -0 "$parent" 2>/dev/null; }; then
      [ -e "$run" ] || return
      stop_job
      kill -TERM "$locker" 2>/dev/null
      kill -TERM "$script" 2>/dev/null
      say "$(no_result)"
      rm -rf "$run"
      return
    fi
    if [ -e "$run/turn" ]; then
      job_pids >/dev/null
    elif [ $((ticks % 30)) -eq 1 ]; then
      waiting_message
    fi
    ticks=$((ticks + 1))
    sleep 1 </dev/null >/dev/null 2>&1
  done
}

stopped() { # status
  stop_job
  kill -TERM "$locker" 2>/dev/null
  say "$(no_result)"
  finish "$1"
}

finish() { # status
  rm -rf "$run"
  [ -z "$watcher" ] || kill -TERM "$watcher" 2>/dev/null
  exit "$1"
}

watcher=
trap 'stopped 143' TERM
trap 'stopped 130' INT
trap 'stopped 129' HUP

# shellcheck disable=SC2086
lockf -k -s ${max_wait:+-t "$max_wait"} "$dir/lock" "$self" --turn "$run" "$label" "$queued_at" "$@" &
locker=$!
script=$$
parent=$PPID
(
  set -m
  watch </dev/null >/dev/null &
  echo $! >"$run/watcher"
)
watcher=$(cat "$run/watcher")

wait "$locker"
status=$?
now=$(date +%s)

if [ ! -e "$run/turn" ]; then
  case $status in
    75) say "$label did not run: it was still waiting after $(elapsed "$max_wait"). This isn't a failed check, and nothing is left behind. Run it again." ;;
    *) say "$label did not run: lockf couldn't take the lock at $dir/lock (exit $status)." ;;
  esac
  finish "$status"
fi

# lockf ended without its command finishing, so stop whatever's left of it.
stop_job
started=$(cat "$run/turn")
took=$(elapsed $((now - started)))
waited=
[ $((started - queued_at)) -lt 2 ] || waited=", after waiting $(elapsed $((started - queued_at)))"
case $status in
  0) say "$label passed in $took$waited." ;;
  70 | 129 | 130 | 137 | 143) say "$(no_result)" ;;
  *) say "$label failed with exit $status in $took$waited." ;;
esac
finish "$status"
