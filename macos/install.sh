#!/bin/sh
# `pnpm mac:install`: what `pnpm mac` runs, but to keep. It puts the app in ~/Applications, where its place doesn't change with each build,
# and has launchd run the server it reads from this folder: from now on, at login, and again if it stops. Settings > General >
# "Open at login" then brings the whole thing back after a restart.
#
#   --uninstall  Stops the server and takes it out of launchd. The app stays in ~/Applications, and is yours to delete.
#
# The server runs this folder's code as it is, so after pulling, run this again, or restart it with
# `launchctl kickstart -k gui/$(id -u)/com.benface.pricetag.server`. Its output goes to ~/Library/Logs/Patina/server.log.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(dirname "$here")
port=${PORT:-8787}
label=com.benface.pricetag.server
agent="$HOME/Library/LaunchAgents/$label.plist"
domain="gui/$(id -u)"
logs="$HOME/Library/Logs/Patina"
name=$(sed -n 's/^APP_NAME = //p' "$here/Config/App.xcconfig")
installed="$HOME/Applications/$name.app"

# The pid launchd gives this server while it runs, if it does.
job_pid() { launchctl print "$domain/$label" 2>/dev/null | sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p' | head -n 1; }
# Whatever's listening on the port, except this server.
others_on_port() {
  ours=$(job_pid)
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | sort -u | while read -r pid; do
    [ "$pid" = "$ours" ] || echo "$pid"
  done
}
port_taken() { # pids
  echo "Something else is listening on port $port (pid $(echo "$1" | tr '\n' ' ' | sed 's/ $//')), like pnpm mac's server. Stop it, then run this again." >&2
}

stop_server() {
  launchctl bootout "$domain/$label" 2>/dev/null || true
  # bootout returns before the server has let go of its port.
  tries=0
  while launchctl print "$domain/$label" >/dev/null 2>&1 && [ "$tries" -lt 50 ]; do
    sleep 0.2
    tries=$((tries + 1))
  done
}

case "${1:-}" in
  --uninstall)
    stop_server
    rm -f "$agent"
    echo "The server's stopped and won't start again. $name is still in ~/Applications."
    exit 0
    ;;
  "") ;;
  *)
    echo "Usage: install.sh [--uninstall]" >&2
    exit 64
    ;;
esac

# A worktree goes away, and the server would go with it.
if [ "$(git -C "$repo" rev-parse --git-common-dir)" != "$(git -C "$repo" rev-parse --git-dir)" ]; then
  echo "This is a worktree, which can be removed from under the server. Run this from the repo's own folder." >&2
  exit 1
fi

# launchd starts it with almost no PATH, so it gets the node this shell has, by its full path.
node=$(command -v node) || { echo "No node on PATH." >&2; exit 1; }
case "$repo$node$logs" in *[\<\>\&]*) echo "Can't write a path with <, > or & into the launchd file." >&2; exit 1 ;; esac

# Before anything changes: launchd would keep restarting a server that can't have its port, while that other one answers for it.
others=$(others_on_port)
[ -z "$others" ] || { port_taken "$others"; exit 1; }

# Always Release, whatever CONFIGURATION says, since that's the folder it copies from.
CONFIGURATION=Release "$here/run.sh" --build-only
app="$here/build/Build/Products/Release/$name.app"
[ -x "$app/Contents/MacOS/$name" ] && codesign --verify --strict "$app" ||
  { echo "The build didn't leave a signed app at $app, so the installed one stays as it was." >&2; exit 1; }

cd "$repo"
# The Top Up and Publish buttons open the web app's hardware wallet flow, which this server serves from the build.
{ pnpm install --frozen-lockfile && pnpm build; } || echo "Couldn't build the web app, so Top Up and Publish from a device won't open." >&2

# The copy that's running holds its files open, and a copy over it would be half old and half new.
pkill -f "$installed/Contents/MacOS/" 2>/dev/null || true
while pgrep -f "$installed/Contents/MacOS/" >/dev/null; do sleep 0.2; done
# The build's copy too, so only one of the two is running.
pkill -f "$app/Contents/MacOS/" 2>/dev/null || true
mkdir -p "$HOME/Applications"
# Copied next to it first, so a copy that fails leaves the installed app as it was. ditto keeps the signature and the provisioning profile as they are.
staged="$HOME/Applications/.$name.app.new"
old="$HOME/Applications/.$name.app.old"
rm -rf "$staged" "$old"
ditto "$app" "$staged" && codesign --verify --strict "$staged" ||
  { rm -rf "$staged"; echo "Couldn't copy $app to ~/Applications, so the installed one stays as it was." >&2; exit 1; }
[ ! -e "$installed" ] || mv "$installed" "$old"
mv "$staged" "$installed"
rm -rf "$old"
# The browser extension now finds this copy.
"$here/install-bridge.sh" "$installed"

stop_server
mkdir -p "$logs" "$(dirname "$agent")"
cat >"$agent" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>$label</string>
	<key>ProgramArguments</key>
	<array>
		<string>$node</string>
		<string>--env-file-if-exists=.env.local</string>
		<string>server/index.ts</string>
	</array>
	<key>WorkingDirectory</key>
	<string>$repo</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PORT</key>
		<string>$port</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<!-- So a server that can't start, like one whose port is taken, doesn't try again several times a second. -->
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>StandardOutPath</key>
	<string>$logs/server.log</string>
	<key>StandardErrorPath</key>
	<string>$logs/server.log</string>
</dict>
</plist>
PLIST
plutil -lint -s "$agent"
launchctl bootstrap "$domain" "$agent"

# An answer only counts if it's this server's: something that took the port since the check above could answer for it.
is_serving() {
  pid=$(job_pid)
  [ -n "$pid" ] && lsof -nP -a -p "$pid" -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1 &&
    curl -fs -o /dev/null --max-time 2 "http://127.0.0.1:$port/api/portfolio/demo"
}
tries=0
until is_serving || [ "$tries" -ge 50 ]; do
  sleep 0.2
  tries=$((tries + 1))
done
if ! is_serving; then
  others=$(others_on_port)
  if [ -n "$others" ]; then port_taken "$others"; else echo "The server didn't answer on port $port. What it said is in $logs/server.log." >&2; fi
  # So it doesn't try again at every login either.
  stop_server
  rm -f "$agent"
  exit 1
fi

echo "$name is in ~/Applications, and its server runs on port $port, now and at every login. Open $name from there,"
echo "and turn on Settings > General > Open at login to have it come back after a restart too."
