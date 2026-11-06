# Testing the Mac app without interrupting anyone

Someone's working on this Mac. Don't run `pnpm mac`, open the app's window, activate it, or script clicks and keystrokes with `System Events`, which can steal focus and act on the wrong app. Use these, in this order.

## 1. Render it

```sh
macos/shot.sh list                       # every scene
macos/shot.sh main out.png               # one scene, in light
macos/shot.sh main out.png --dark        # one scene, in dark
macos/shot.sh all some-folder            # every scene, in both
macos/shot.sh main out.png --chart value # any scene, with the Overview chart on Value instead of PnL
```

This is the default for visual checks. It builds a debug copy, runs it from its own temporary folder, draws the real SwiftUI views from fixtures in a window that's never shown, and removes everything when it's done. Each scene takes about a second. It ends by saying whether focus moved, and fails if it was this that moved it.

In a Swift test, `OffscreenRenderer.png(of:)` does the same for anything in `PricetagKit`. See `RenderTests.swift`.

What rendering can't draw, so don't judge it from a render:

- The toolbar and title bar, which it leaves out.
- Materials, glass and vibrancy. The popover's background comes out flat, and vibrant text can come out in the wrong color. That's why the inspector (`main-details`) always uses a real window.
- Whether a window is active, focus rings, hover and anything else that needs an event.

### With real data

```sh
pnpm start   # or PORT=8749 node --env-file=<a .env.local> server/index.ts, so it can't clash with one already running
macos/shot.sh main out.png --live http://127.0.0.1:8749 0x…
macos/shot.sh main-details out.png --live http://127.0.0.1:8749 0x… --asset USDC --currency CAD
macos/shot.sh rule-comparison out.png --live http://127.0.0.1:8749 0x… --settle 30
```

Any scene that reads the wallet, in place of its fixtures, from a real server and the real node. A scene's state is whatever that wallet's is, so `main-reading` or `hot-wallet-over-cap` shows nothing special here. Only the scene's currency and sections still apply. It's read-only: the wallet in the scene is the address you gave, with no key behind it, and it reads the node but can't send. A wallet's first read can take minutes, and what a scene loads after it appears has `--settle` seconds, 6 by default.

A scene with a hot wallet makes the address you gave its Spending Money, so `main-watching` or `wallet-switcher` shows that address as yours. To see it only being watched, use a scene without one, like `main`, `main-small` or `popover`.

Never run a release build to look at something: it starts the real hot wallet, which can sweep by itself, and reads the real settings. Check one with `strings` and `nm` instead.

### What VoiceOver finds

```sh
macos/shot.sh send-waiting out.txt --accessibility   # one scene
macos/shot.sh all some-folder --accessibility        # every scene, one file each
```

This writes the tree macOS builds for VoiceOver, from the same offscreen render: each element's label, value and role, in reading order. It needs Accessibility in System Settings for whatever runs the script, because SwiftUI only builds the tree once an assistive app has asked. `AccessibilityTree` does the same in a Swift test, and those tests only run when it's allowed (see `AccessibilityTests.swift`).

It shows what's said and in what order, not how VoiceOver pronounces it or where its cursor goes. It also leaves out a table's rows, which an offscreen table doesn't make, and the route-* scenes, which need a real window. Both stay on benface's checklist.

macOS doesn't give other apps Dynamic Type: SwiftUI's text styles stay the same size whatever `dynamicTypeSize` says. Larger text on a Mac comes from the display's "Larger Text" setting, which makes the screen smaller, so the small-window scenes (`main-smallest`, `settings-small-display` and the like) are the check for it.

## 2. Capture a real window

```sh
macos/shot.sh main out.png --window
macos/shot.sh all some-folder --window
```

Only when rendering can't show it. This launches the debug copy with `open -g -j`, shows one real window with its toolbar and materials, captures it with `screencapture -l`, and quits it. It takes about 2 seconds a scene.

What macOS allows, found by trying it on macOS 27.2:

- `screencapture -l` refuses a window that's off every screen ("could not create image from window"), wherever it's placed. So the window sits behind the desktop picture instead, where it can be captured but not seen or clicked.
- A hidden app's windows aren't drawn, so the test mode unhides itself without activating.
- `setActivationPolicy(.prohibited)` means it can't become the active app. It has no Dock icon, no menu bar item and no menus, and it never calls `DockPresence`.
- The window is always inactive, so its toolbar text and traffic lights look dimmed, and a real one in front wouldn't.
- This needs Screen Recording for whatever's running the script. Rendering doesn't.

Not tried, because it would have interrupted: running this while a full-screen app or another Space is in front.

The `route-*` scenes check more than looks: they press what the menu bar's buttons press, with the window closed and with it open on another section, and fail unless they get where they promise and stay there.

Scenes for the main window and Settings always use a real window, because their sidebar, toolbar and tabs are drawn by the window server. So do the scenes that go through the site window (`site-connect`, `site-transaction` and the like), whose top spacing is the title bar. The other `site-*` scenes only draw what's in it. A window can't be larger than the display, so `main-huge` shows as much as this display allows. A test window's toolbar has no room for Settings' tabs, which show properly in the real one. Sheets, including the details in a narrow window, don't appear in a capture.

## Watching motion

A screenshot can't show animation, so the `motion-*` scenes play something after their real window appears, and this captures it frame by frame, behind the desktop like any other window:

```sh
macos/shot.sh motion-chart-draw some-folder --frames 24 --slowdown 4
macos/shot.sh motion-cost-known some-folder --frames 30 --slowdown 3 --dark
```

Capturing takes about 100 ms a frame, so `--slowdown` plays the app's animations more slowly (everything in `Motion` follows it). What this shows is where things go and what's on screen at each moment. It can't show how it feels at full speed, a hover from a real pointer, or a haptic, so those go on the checklist for benface. Every other scene has `Motion.playsEntrances` off and shows the finished view.

## 3. Test behavior with logic tests

Don't drive the UI. Anything that decides what happens belongs in `PricetagKit` or another package, with a test next to `FeedTests.swift`. Scenes set up the state you want to see, so you don't need to click your way to it.

## When it truly needs a visible window

Don't do it yourself. Finish, and put a short checklist for benface in your hand-off comment, with what to do and what they should see. For example:

- The green button enters full screen: at launch, after opening from the menu bar, and after closing the window and reopening it. Closing the last window still takes away the Dock icon.
- Dragging the window down to its smallest size and back, with the details open.
- The menu bar item's text, including its warning.
- Right-clicking and Control-clicking the menu bar item opens its menu directly under the menu bar with every row showing and no scroll arrow, on a display with a notch, one without and a second display, and closes the panel if it's open. Open, Settings and Quit all work from it, with the app in the background and with its window closed. A plain click still opens the panel.
- Settings' window grows and shrinks smoothly between tabs and when a warning appears, with its top edge staying put. Test scenes draw each tab at its final height, and Settings' own window can't be opened from the background.
- The real popover under the menu bar, and that clicking outside it closes it.
- Opening the window from the popover brings it to the front, and adds the Dock icon and menus. Closing it takes them away.
- Keyboard shortcuts, keyboard focus, and sheets opening over the window.
- The spending money window's confirmation dialogs, and Touch ID, which asks inside the window. Its sheets are scenes, without the window behind them.
- The app's look when it's active and in front.

## The hosted build

`pnpm check:hosted [--no-launch] [dmg]` tests the full build colleagues get. It reads the signature, profile, entitlements and what's in the image. Without `--no-launch` it also launches a release copy against a local server in hosted mode, under its own test ID with no profile, Keychain group or app group, and signed without the paths of any browser's manifest that's already there, so it can't reach an installed copy's wallet or break its extension. It stops before launching if that doesn't hold, so the release app under its real ID first launches on someone's Mac. It also launches a debug copy signed the same way that makes a key in the real Keychain, sweeps and approves a site's transaction on a local fork. `PATINA_TEST_ENV_FILE=<a .env.local>` adds a first read and a question with real data. `PATINA_HOSTED=1 macos/shot.sh <scene> out.png` draws any scene as this build shows it, like `main-welcome-checking`, which a normal build never shows.

Nothing takes focus, but each launch puts an icon in the menu bar for a moment, so use `--no-launch` while someone's presenting from this Mac.

**Never launch a quarantined copy here.** Even a notarized one puts macOS's first-launch dialog on the screen of whoever's using this Mac, and a script can't close it. Check Gatekeeper with `spctl --assess --type execute`, as this does. Each launched copy also has its `patina://` scheme taken out and is signed again, so it can't take that link from the normal build.

## The watch-only build

`pnpm check:watch-only [dmg]` tests a built copy from a clean temporary folder, without opening a window or taking focus: its signature and entitlements, that the key code isn't in its binary, that the Keychain refuses what it's signed with, and that it reaches a local server in hosted mode and gets the 401 that opens the invite prompt. It launches a copy under its own test ID, so an installed copy's saved data is never touched, which also means the installed ID itself first launches on someone's Mac. It can't check Gatekeeper on another Mac, or HTTPS to the real host. `PATINA_WATCH_ONLY=1 macos/shot.sh <scene> out.png` draws any scene as that build shows it, like `invite-prompt`.

## How it's kept apart from the real app

- All of it is in `App/TestMode/` and `OffscreenRenderer.swift`, inside `#if DEBUG`. The fixtures are left out of release builds in `App.xcconfig`.
- Debug builds have their own bundle ID, and the test mode's settings are only registered in memory, so it never reads or writes anyone's settings.
- It never touches a key. Its hot wallet (`HotWalletFixture.swift`) reads once from a fake node and the fixtures and is never started, keeps nothing, and has a signer with no key behind it, so it never reaches the Keychain or the Secure Enclave. A scene that gets as far as making a key, signing, sending a transaction or asking for Touch ID fails instead of drawing it. The approval scenes (`site-*`, `send-waiting`, `sweep`) only draw what's around Touch ID: they're given a state, never ask, and show a stand-in for the system's glyph, which draws nothing until it's really asking. The `site-connect`, `site-transaction`, `site-transaction-cad`, `site-preview`, `site-preview-unknown`, `site-preview-long`, `site-unlimited-approval` and `site-typed-permit` scenes send a real request through `SiteBridge`, with a fake node that can say what a transaction would cost and do, and stop at the approval window, which is never in front, so it never asks. Approving them would reach that same signer and fail.
- `shot.sh` builds without the sandbox. A sandboxed build's container is tied to its signature, and macOS stops the launch to ask about it when that changes.
- A real window quits itself after 60 seconds if `shot.sh` is gone by then.

## Compiling Swift takes turns

Only one thing compiles Swift or runs its tests at a time, across every worktree on this Mac. `pnpm check:mac`, `pnpm check:mac:quick`, `pnpm mac:build`, `pnpm check:keychain`, `pnpm check:extension`, `pnpm check:device-pages`, `pnpm check:anvil` and the build in `shot.sh` all queue by themselves, in the order they started, and only hold the lock while compiling or testing. `pnpm mac` never waits. Run anything else through the queue, like one test, with `--scratch-path` so it reuses what `check:mac` compiled:

```sh
macos/swift-queue.sh swift test --package-path macos/PricetagKit --scratch-path macos/.build --filter FeedTests
```

From an agent, a foreground command can hit the tool's time limit while it queues, so:

- Use the tool's longest limit (10 minutes for Claude Code's Bash tool, `timeout: 600000`), not its default of 2 minutes.
- Write the output to a file and filter it afterward, because a pipe to `grep` hides the queue's messages until it's over. Use a path in your own task folder, and take the exit code from the command, not the filter.

```sh
pnpm check:mac > ../check-mac.log 2>&1; echo "exit $?"; grep -E '^\[(swift-queue|check:mac)\]|error:|Test run with' ../check-mac.log | tail -n 20
```

- If the tool moves the command to the background when its limit runs out, as Claude Code's does, it's still queued or running, and it isn't a failure. Don't start a second copy. If your turn can wait, read its output file until the final `[swift-queue]` line appears. Multica ends a run's background work with the turn, so never finish a turn on one of these. If the tool kills it instead, there's no result, so run it again.

What you'll see, on lines starting with `[swift-queue]`:

- **`Waiting … not hung: pnpm check:mac from <worktree> has been running for 2m3s`**, every 30 seconds. It's in the queue, behind that.
- **`… passed in 3m12s`** or **`… failed with exit 1 in 3m12s`**: the result. A failing check still fails with its own exit code.
- **Exit 75 and `… did not run: it was still waiting`**: the queue was too long, so it gave up after 4 minutes to leave time for the run itself. This isn't a failed check, and nothing's left behind. Run it again. At a terminal it waits as long as it takes, and `SWIFT_QUEUE_WAIT=<seconds>` sets another limit (empty for none).
- **Exit 69 and `… isn't a pass` or `… did not run: an earlier run's processes can't be verified gone`**: see below. Don't report either as a pass or a failed check.
- **`… was stopped while waiting`** or **`… was stopped partway`**: there's no result. It didn't pass or fail, so don't report it as either. Run it again. Whatever it had compiled is kept, so the next run goes faster.

When a run ends or is killed, even with `kill -9` on its whole process group, it stops everything it started, and the next run doesn't start until that's done. That usually takes under a second, and about 5 for something that ignores SIGTERM. Nothing else is touched, including other worktrees' runs.

A process that starts its own session and whose parent exits within a second, before the run lists it, isn't found, and none of the Swift tools do that. And a run's cleanup comes from a watcher outside its process group, so if that's killed along with the run, what's left keeps running until the next run stops it.

If what a run started can't be verified gone after about 7 seconds, because something can't be killed or `ps` keeps failing, the run says `Couldn't stop …` and `… isn't a pass`, and exits with 69 unless the command had already failed with its own code. It keeps its job folder in the queue folder, with the list of what's left in `pids`. Each later run tries again for about 7 seconds, and starts once they're gone. Until then it exits with 69 and `… did not run`, without running anything, so waiting runs don't hang and nothing overlaps. Run it again once `ps` works. If a process really can't be killed, restart the Mac, which clears it. Only delete that job folder once you've checked its processes are gone, because the queue forgets them when you do.

The lock is at `~/Library/Caches/patina-swift-queue/`, outside the repo so that every worktree shares it. Don't delete it: a run waiting on the old file wouldn't see the new one.

The queue has its own tests, in `macos/swift-queue.test.ts`, because they take about a minute and only protect the Mac's builds, so they're not in `pnpm test`. `pnpm check:swift-queue` runs them, and a full `pnpm check:mac` runs them first, before its turn, because they use their own queue and compile nothing. `--quick` and a run that finds its code already passed skip them. They're in `macos/`, so changing them runs everything again. Run them whenever you change `swift-queue.sh`: this lock protects every run on this Mac. A failure names its test, and so does a signal: `Its tests got SIGTERM during "…"` came from outside them, so it has no result, like `… was stopped partway`.

A test that waits for something needs a deadline. If it spins forever and `swift test` is killed outside the queue, its `swiftpm-testing-helper` keeps using a whole core with nobody to stop it.

## Which check to run

- **While working: `pnpm check:mac:quick`.** Only the tests of both packages. It always runs them, and never counts as a pass, though failing forgets one.
- **Before review or a merge: `pnpm check:mac`.** Everything: all the tests, the signed Release app, the watch-only app, the hosted app and both iOS builds. It says how long each step took on `[check:mac]` lines.

`check:mac` remembers a full pass for what's in `macos/`, committed or not, with this Xcode, Swift and macOS. If all of that is the same, it says `Nothing ran: this exact code already passed …` and exits 0 straight away, even from another worktree, or after merging a `main` that didn't touch `macos/`. Say so if you report it, because you didn't run it. A pass that's recorded is only ever a full one, recorded after the queue has verified its turn is over, and any change in `macos/`, even one character, runs everything. Any run of that same code that fails forgets the pass, including `--quick`, and `--force` forgets it as soon as its turn starts, so it's only back if that run passes. Only a pass from the latest run to start on that code counts, and one that's reported as stopped leaves none. To run it anyway, for example when chasing a flaky test, use `macos/check-mac.sh --force`. The records are in `~/Library/Caches/patina-check-mac/`, hold only a run's ID, a date and a path, and are safe to delete. A run with `ANVIL_RPC_URL`, `BASE_READ_RPC_URL` or another `CONFIGURATION` is never skipped or recorded.

Build products stay in each worktree on purpose, so one branch's can't pass as another's, and nothing signed or cryptographic is shared. Seeding a new worktree from another's would save about a third of a package's first build, not skip it, because the paths in them are absolute. So a new worktree's first `check:mac` compiles everything, and the largest part of that is the Release build, at over a minute.

`RenderTests` and `ContrastTests` really draw, on the main actor, and other tests on the main actor wait behind them. So a test's reported time can say more about what ran beside it than about the test: run it alone with `--filter` before calling it slow.

## Adding a scene

Add a case to `TestScene` in `App/TestMode/TestMode.swift`, give it a feed and a view, and it's in `shot.sh list` and `all`. Set `needsRealWindow` only if a render gets it wrong. A hot wallet state goes in `HotWalletFixture`, and another currency needs its `demo-portfolio-xyz.json` and `demo-explanation-xyz.json`: put them in `PricetagKit/Tests/PricetagKitTests/Resources`, with a symlink in `App/TestMode` like the others, so the tests read the same files the app does.
