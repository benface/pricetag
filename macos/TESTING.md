# Testing the Mac app without interrupting anyone

Someone's working on this Mac. Don't run `pnpm mac`, open the app's window, activate it, or script clicks and keystrokes with `System Events`, which can steal focus and act on the wrong app. Use these, in this order.

## 1. Render it

```sh
macos/shot.sh list                       # every scene
macos/shot.sh main out.png               # one scene, in light
macos/shot.sh main out.png --dark        # one scene, in dark
macos/shot.sh all some-folder            # every scene, in both
```

This is the default for visual checks. It builds a debug copy, runs it from its own temporary folder, draws the real SwiftUI views from fixtures in a window that's never shown, and removes everything when it's done. Each scene takes about a second. It ends by saying whether focus moved, and fails if it was this that moved it.

In a Swift test, `OffscreenRenderer.png(of:)` does the same for anything in `PricetagKit`. See `RenderTests.swift`.

What rendering can't draw, so don't judge it from a render:

- The toolbar and title bar, which it leaves out.
- Materials, glass and vibrancy. The popover's background comes out flat, and vibrant text can come out in the wrong color. That's why the inspector (`main-details`) always uses a real window.
- Whether a window is active, focus rings, hover and anything else that needs an event.

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

Scenes for the main window and Settings always use a real window, because their sidebar, toolbar and tabs are drawn by the window server. A window can't be larger than the display, so `main-huge` shows as much as this display allows. A test window's toolbar has no room for Settings' tabs, which show properly in the real one. Sheets, including the details in a narrow window, don't appear in a capture.

## 3. Test behavior with logic tests

Don't drive the UI. Anything that decides what happens belongs in `PricetagKit` or another package, with a test next to `FeedTests.swift`. Scenes set up the state you want to see, so you don't need to click your way to it.

## When it truly needs a visible window

Don't do it yourself. Finish, and put a short checklist for benface in your hand-off comment, with what to do and what they should see. For example:

- The green button enters full screen: at launch, after opening from the menu bar, and after closing the window and reopening it. Closing the last window still takes away the Dock icon.
- Dragging the window down to its smallest size and back, with the details open.
- The menu bar item's text, including its warning.
- The real popover under the menu bar, and that clicking outside it closes it.
- Opening the window from the popover brings it to the front, and adds the Dock icon and menus. Closing it takes them away.
- Keyboard shortcuts, keyboard focus, and sheets opening over the window.
- The spending money window's confirmation dialogs, and Touch ID. Its sheets are scenes, without the window behind them.
- The app's look when it's active and in front.

## How it's kept apart from the real app

- All of it is in `App/TestMode/` and `OffscreenRenderer.swift`, inside `#if DEBUG`. The fixtures are left out of release builds in `App.xcconfig`.
- Debug builds have their own bundle ID, and the test mode's settings are only registered in memory, so it never reads or writes anyone's settings.
- It never touches a key. Its hot wallet (`HotWalletFixture.swift`) reads once from a fake node and the fixtures and is never started, keeps nothing, and has a signer with no key behind it, so it never reaches the Keychain or the Secure Enclave. A scene that gets as far as making a key, signing, sending a transaction or asking for Touch ID fails instead of drawing it. `send-waiting` is the one that asks, and its prompt never answers, to show the sheet in the meantime.
- `shot.sh` builds without the sandbox. A sandboxed build's container is tied to its signature, and macOS stops the launch to ask about it when that changes.
- A real window quits itself after 60 seconds if `shot.sh` is gone by then.

## Adding a scene

Add a case to `TestScene` in `App/TestMode/TestMode.swift`, give it a feed and a view, and it's in `shot.sh list` and `all`. Set `needsRealWindow` only if a render gets it wrong. A hot wallet state goes in `HotWalletFixture`, and another currency needs its `demo-portfolio-xyz.json` and `demo-explanation-xyz.json`: put them in `PricetagKit/Tests/PricetagKitTests/Resources`, with a symlink in `App/TestMode` like the others, so the tests read the same files the app does.
