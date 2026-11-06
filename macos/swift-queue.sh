#!/bin/sh
# Runs a command that compiles Swift, one at a time across every worktree on this Mac, because several at once slow each other down.
# Usage: macos/swift-queue.sh <command> [arguments]. How to run it from an agent is in TESTING.md.
#
# The lock is held by a lockf, which frees it however it ends, and its children don't inherit it, so a stray can't keep it. But killing
# lockf frees the lock and leaves its command compiling, and swift test's helper outlives swift test, in its own process group. macOS
# hides the environment of Apple's binaries, so a marker there can't find them. So the command gets its own session, which its descendants
# stay in with no parent left, and a list of what's descended from it, by PID and start time, finds any that start their own session. It
# never signals a process that's in neither.
#
# Each run has a job folder and a watcher, which is the one thing that updates the list and stops the job while it's alive. Everything
# else asks it to (the stop file) and waits for it to finish (the clean file). A run that gets the lock doesn't start until every earlier
# run that started is clean, and if one's watcher is gone too, it finishes that run's cleanup itself.
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

# Lists everything alive that's in the job, which also goes in its list: in the command's session, descended from the command, or already
# on the list. Fails if it couldn't find out, which isn't the same as finding nothing. A session's ID stays taken while anything's in it,
# so if the root's PID belongs to something else now, the session is over and only the list counts.
job_pids() { # root, by PID and start time
  [ -d "$run" ] || return 0
  list=$(mktemp "$run/pids.XXXXXX") || return 1
  # 310 is getsid, which Perl doesn't wrap. ps doesn't show sessions on macOS.
  if perl -e '
    my ($known, $root_key) = @ARGV;
    my ($root) = split " ", $root_key;
    my @rows = `ps -axo pid=,ppid=,stat=,lstart=`;
    exit 1 if $? or !@rows;
    my (%listed, %parent, %key, %zombie, %job);
    if (open my $file, "<", $known) { chomp(my @lines = <$file>); @listed{@lines} = (); }
    for (@rows) {
      my ($pid, $ppid, $stat, @start) = split;
      $parent{$pid} = $ppid;
      $key{$pid} = "$pid @start";
      $zombie{$pid} = $stat =~ /^Z/;
      $job{$pid} = 1 if exists $listed{$key{$pid}};
    }
    if ($root and (!exists $key{$root} or $key{$root} eq $root_key)) {
      for (keys %key) { $job{$_} = 1 if $_ == $root or syscall(310, 0 + $_) == $root }
    }
    for (my $changed = 1; $changed;) {
      $changed = 0;
      for (keys %parent) { if (!$job{$_} && $job{$parent{$_}}) { $job{$_} = $changed = 1 } }
    }
    print "$key{$_}\n" for grep { !$zombie{$_} } keys %job;
  ' "$run/pids" "${1:-}" >"$list" 2>/dev/null; then
    cut -d ' ' -f 1 "$list"
    mv "$list" "$run/pids" 2>/dev/null
    return 0
  fi
  rm -f "$list"
  return 1
}

# Returns once the job's empty, or says so if it can't get it there. The next turn has to go ahead then, or one stuck process stops every
# build on this Mac.
stop_job() { # root
  tries=0
  told=
  while :; do
    if pids=$(job_pids "${1:-}"); then
      [ -n "$pids" ] || return 0
      # shellcheck disable=SC2086
      if [ "$tries" -ge 50 ]; then
        kill -KILL $pids 2>/dev/null
      elif [ -z "$told" ]; then
        kill -TERM $pids 2>/dev/null
        told=1
      fi
    else
      pids="what's left, because ps failed"
    fi
    if [ "$tries" -ge 70 ]; then
      say "Couldn't stop $pids."
      return 1
    fi
    tries=$((tries + 1))
    sleep 0.1
  done
}

root_key() {
  [ ! -r "$run/root" ] || cat "$run/root"
}

# Asks the watcher to stop the job. The command hears right away, because on a Mac this busy, ps can take minutes.
abort() {
  [ -d "$run" ] || return 0
  touch "$run/stop" 2>/dev/null
  root=$(root_key)
  [ -z "$root" ] || kill -TERM "${root%% *}" 2>/dev/null
}

watcher_alive() { # job folder
  read -r pid _ 2>/dev/null <"$1/watcher" || return 1
  [ "$(ps -o pid=,lstart= -p "$pid" 2>/dev/null)" = "$(cat "$1/watcher" 2>/dev/null)" ]
}

# Waits for the watcher to finish stopping the job, or does it if the watcher's gone.
await_clean() {
  until [ -e "$run/clean" ] || [ ! -d "$run" ]; do
    if ! watcher_alive "$run"; then
      stop_job "$(root_key)"
      touch "$run/clean" 2>/dev/null
      return
    fi
    sleep 0.1
  done
}

# Waits until an earlier run that started has finished stopping, because killing its lockf freed the lock before that happened.
settle() { # job folder
  while [ -d "$1" ] && [ ! -e "$1/clean" ]; do
    if ! watcher_alive "$1"; then
      (
        run=$1
        stop_job "$(root_key)"
      )
      rm -rf "$1"
      return
    fi
    [ -n "${settling:-}" ] || say "The last run is still stopping, so this one starts once it has."
    settling=1
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
  [ -d "$run" ] || exit 70
  echo "$now" >"$run/turn"
  # If lockf is alive after that, a later run can only get the lock once this one's marked as started, so it'll wait for this one. If it's
  # not, the lock may already be someone else's. And without a watcher, nothing would clean up after the command.
  if [ "$PPID" -eq 1 ] || [ "$(ps -o ppid= -p $$ | tr -d ' ')" != "$PPID" ] || ! watcher_alive "$run"; then
    exit 70
  fi
  printf '%s\n' "$PPID" "$now" "$label" "$repo" >"$run/holder"
  mv "$run/holder" "$dir/holder"
  [ $((now - queued_at)) -lt 2 ] || say "It's this run's turn, after waiting $(elapsed $((now - queued_at))): $label"
  trap 'abort; await_clean; exit 143' TERM
  trap 'abort; await_clean; exit 130' INT
  trap 'abort; await_clean; exit 129' HUP
  for job in "$dir"/job.*; do
    if [ "$job" != "$run" ] && [ -e "$job/turn" ]; then settle "$job"; fi
  done
  # The command says who it is before it starts, then checks it wasn't stopped. The watcher does the opposite, so one of them finds out.
  SWIFT_QUEUE_TURN=1 perl -MPOSIX -e '
    my ($root, $stop) = splice(@ARGV, 0, 2);
    my @start = split " ", `ps -o lstart= -p $$`;
    @start or exit 70;
    open(my $file, ">", "$root.new") or exit 70;
    print $file "$$ @start\n";
    close $file;
    rename("$root.new", $root) or exit 70;
    exit 70 if -e $stop;
    POSIX::setsid() != -1 or die "Could not start a session: $!\n";
    exec { $ARGV[0] } @ARGV or die "Could not run $ARGV[0]: $!\n";
  ' "$run/root" "$run/stop" "$@" &
  wait $!
  status=$?
  touch "$run/stop" 2>/dev/null
  await_clean
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
  # Closing the terminal or the pipe reading stderr is no reason to leave a job running.
  trap '' HUP PIPE
  ticks=0
  while [ -d "$run" ] && [ ! -e "$run/stop" ]; do
    kill -0 "$script" 2>/dev/null || break
    if [ "$parent" -ne 1 ] && ! kill -0 "$parent" 2>/dev/null; then
      # With only its parent gone, the script can say what happened itself.
      kill -TERM "$script" 2>/dev/null
      parent=1
    fi
    if [ -e "$run/turn" ]; then
      [ $((ticks % 10)) -ne 0 ] || job_pids "$(root_key)" >/dev/null
    elif [ $((ticks % 300)) -eq 10 ]; then
      waiting_message
    fi
    ticks=$((ticks + 1))
    sleep 0.1 </dev/null >/dev/null 2>&1
  done
  [ -d "$run" ] || return
  [ -e "$run/stop" ] || abort
  stop_job "$(root_key)"
  touch "$run/clean" 2>/dev/null
  while [ -d "$run" ] && kill -0 "$script" 2>/dev/null; do sleep 0.1 </dev/null >/dev/null 2>&1; done
  [ -d "$run" ] || return
  # The script was killed before it could say what happened.
  [ ! -r "$run/locker" ] || kill -TERM "$(cat "$run/locker")" 2>/dev/null
  say "$(no_result)"
  rm -rf "$run"
}

stopped() { # status
  abort
  await_clean
  [ ! -r "$run/locker" ] || kill -TERM "$(cat "$run/locker")" 2>/dev/null
  say "$(no_result)"
  finish "$1"
}

finish() { # status
  rm -rf "$run"
  exit "$1"
}

trap 'stopped 143' TERM
trap 'stopped 130' INT
trap 'stopped 129' HUP

script=$$
parent=$PPID
(
  set -m
  watch </dev/null >/dev/null &
  ps -o pid=,lstart= -p $! >"$run/watcher"
)

# shellcheck disable=SC2086
lockf -k -s ${max_wait:+-t "$max_wait"} "$dir/lock" "$self" --turn "$run" "$label" "$queued_at" "$@" &
echo $! >"$run/locker"

wait $!
status=$?
now=$(date +%s)

if [ ! -e "$run/turn" ]; then
  touch "$run/stop" 2>/dev/null
  await_clean
  case $status in
    75) say "$label did not run: it was still waiting after $(elapsed "$max_wait"). This isn't a failed check, and nothing is left behind. Run it again." ;;
    *) say "$label did not run: lockf couldn't take the lock at $dir/lock (exit $status)." ;;
  esac
  finish "$status"
fi

# If lockf ended without its command finishing, stop whatever's left of it.
[ -e "$run/clean" ] || abort
await_clean
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
