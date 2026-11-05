# Hardware wallets

The web app can reach a Ledger or a Keystone directly, or a browser wallet with one behind it. Keys stay on the device. This code only ever sees addresses and signatures, and there's nothing in it that can take a recovery phrase or a private key. Run the app and press **Hardware wallet**, or get here from the Mac app's Add, Top Up and Publish buttons.

**Nothing here has run against a real device yet.** See the [checklist](#checklist-for-a-real-device).

## What a cold wallet can sign

Only these, whatever asks. `readColdRequest` in `src/core/cold.ts` decides, right before a device is asked, and anything it doesn't recognize is refused:

- ETH to one of your own wallets.
- A token on the app's list to one of your own wallets, as a plain `transfer`.
- A note: a zero-value send to itself, with a cost in its data.

So no swaps, approvals, permits, messages or typed data, on any route. Swaps happen from the hot wallet.

"Your own" means an account from the device, a wallet you answered "My wallet" for, or one you just said was yours. A link can fill in a destination, but it can't make it yours: anyone can make a link, so you have to say so on the page.

## The routes

| | Reaches the device | Puts the address on its screen | Needs |
| --- | --- | --- | --- |
| **Ledger** | USB, with WebHID | Yes, and it has to be approved there | Chromium, a secure page (`localhost` counts), the Ethereum app, and Ledger Wallet closed. Bluetooth doesn't work here |
| **Keystone** | QR codes and the webcam, so it's never connected | No: you find it on the device's receive screen | A webcam |
| **Browser wallet** | Through the wallet, like Rabby | No: you check it on the device | The wallet set up with your device |

The browser wallet is the fallback if a direct route misbehaves on demo day. Our own extension isn't offered there, because it's the hot wallet.

Either way, the page shows an address as checked only after you say every character matched your device's screen. The accounts you choose between aren't checked yet, and the page says so.

Accounts in use on the device, plus the one you pick, are linked: they go in the book as `mine` with no question, so costs follow what moves between them (`linkDeviceAccounts` in `src/core/book.ts`). A new account you've never used stays out until you pick it. **Add to the Mac app as savings** opens a `patina://` link with the account and the others in use, and a Ledger shows the address again at the same moment, so there's something to compare with. Anyone can make that link too, so the Mac app can't take its word for any of it. It shows its check step, where you compare the address with the device, and lists the others for you to tick the ones you know are yours. Those only link costs, and nothing's ever swept to them. A new link takes back any answers you'd given.

## Adding a savings wallet from the Mac app

**Add a Savings Wallet…** asks which device it is, then goes one step at a time, with what to do if a step doesn't match. The address only ever gets added after you say every character matches the device's screen, however it got there.

- **Ledger:** plug in, open the Ethereum app, and quit Ledger Wallet, which the app can see and says so. Then it opens a browser that can reach a Ledger: your default if it's Chromium, or another one you have if it isn't. The page goes straight to the Ledger's steps, then sends the address back and shows it on the device for the check. With no Chromium browser, it says so and links to Chrome. You can also paste from Ledger Wallet's Receive screen instead. Native access is WORK-447.
- **Keystone:** tap ETH, then show the code under Receive ETH to the Mac's camera. No browser. The picture stays in memory only for as long as it takes to read, and only a plain address counts: anything else is dropped without being shown, including the code from Connect Software Wallet. With no camera, or if it isn't allowed, you type the address.
- **Another wallet:** paste its address.

## Where an address shows on each device

The Mac app used to say "its receive screen for Base", and the web page "for Ethereum". Neither device has a receive screen for Base. Base shares Ethereum's address.

| | What it really does | Source |
| --- | --- | --- |
| **Ledger Nano X** | It has no receive screen of its own. It shows an address only when software asks. With the Base chain ID, which is what the page sends, the Ethereum app says **Verify Base address**, then the address, then **Confirm** or **Reject**, then "Address verified". An older Ethereum app says less. Base has no app of its own | [`ui_get_public_key.c`](https://github.com/LedgerHQ/app-ethereum/blob/develop/src/nbgl/ui_get_public_key.c), [`network.c`](https://github.com/LedgerHQ/app-ethereum/blob/develop/src/network.c), [the Nano UI](https://github.com/LedgerHQ/ledger-secure-sdk/blob/master/lib_nbgl/src/nbgl_use_case_nanos.c), [Ledger on Base](https://www.ledger.com/blog/base-the-new-l2-incubated-by-coinbase-joins-the-ledger-live-ecosystem) |
| **Keystone 3 Pro** | Tap **ETH** on the home screen. **Receive ETH** shows a code with just the address in it, and the address itself. It doesn't mention Base. **Switch Account** changes the account, and **⋯ > Change Derivation Path** changes the path, where **BIP 44 Standard** is the one this page's Top Up reaches | [`gui_multi_path_coin_receive_widgets.c`](https://github.com/KeystoneHQ/keystone3-firmware/blob/master/src/ui/gui_widgets/multi/web3/gui_multi_path_coin_receive_widgets.c), [its wording](https://github.com/KeystoneHQ/keystone3-firmware/blob/master/src/ui/lv_i18n/data.csv), [Receiving](https://guide.keyst.one/docs/receiving-cryptocurrency), [Connect Software Wallet](https://guide.keyst.one/docs/connecting-software-wallets-to-keystone) |

Installing the Ethereum app is My Ledger in Ledger Wallet, and closing Ledger Wallet first comes from [MetaMask's Ledger guide](https://support.metamask.io/more-web3/even-more/having-issues-with-your-ledger/), since Ledger's own support pages don't say it plainly. All of this is read from source and docs, and not one word has been checked on a device yet. The checklist below does that.

## What each device shows

This is from Ledger's and Keystone's docs, not from trying it. The checklist below confirms it.

| | Ledger Nano X | Keystone |
| --- | --- | --- |
| **ETH transfer** | Clear: amount, address, network | Clear: amount, address |
| **USDC or another listed token** | Clear when Ledger's token list recognizes it. The page asks Ledger's servers for that. If it can't reach them, it's treated like a note | Clear for `transfer`, as far as its docs say |
| **A note** | **Needs blind signing.** The device can't read it, so it shows a warning and a hash. With the setting off, it refuses, and the page says what to change | No setting that its docs mention. It should show the raw data as hex. Not confirmed |
| **A swap, if one were ever allowed** | Needs blind signing, unless Ledger has a descriptor for that contract | Decoded only with the contract's ABI on a microSD card, per its docs |

**The Ledger's setting:** on the device, open the Ethereum app, then Settings, then **Blind signing**. It's off by default. Turn it on to publish a note, and back off after. Plain transfers don't need it. Leaving it on means a compromised computer could get something unreadable signed.

## What leaves the page

Base's public RPC gets reads and the signed transaction. On a Ledger, Ledger's servers get asked about the token being sent, so its name can be shown. Ledger's kit can also report what's signed and have transactions checked by Ledger, and those are off, in the code and in the server's `connect-src`. The webcam's picture never leaves the page. This browser keeps checked accounts' addresses and where they are on the device, and nothing else.

## Testing without a device

`test/support/mock-signer.ts` stands in for one. It holds no key: its signature is two fixed numbers, and the test uses the account those recover to, so a local chain can run the real path with nobody having a key. It lives outside `src`, and a test checks that the app can't reach it. `test/devices.test.ts` also covers a Keystone's real QR formats.

To look at the panel, run `pnpm dev` and open `/test/support/device-harness.html?scene=accounts`. Add a `?publish=` link and `&many=1` to try a wallet past the first page. The scenes are `route`, `ledger`, `accounts`, `check`, `handoff`, `ready`, `send`, `publish` and `code`, the code a Keystone scans, `&look=1` shows the wording for a device the page can't reach, and `&addsavings=ledger` is the Mac app's way in. The Mac app's steps are `add-savings-*` scenes in `macos/shot.sh`. The build doesn't include it.

## Checklist for a real device

Start with **Adding from the Mac app**. Use a fresh account with a few dollars after that. **Stop at the first thing that doesn't match, and don't send anything.** Never type a recovery phrase into anything.

**Adding from the Mac app,** with `pnpm mac`. Press **Add a Savings Wallet…**. For each step, note any words that differ from what the device says.

**This only moves no money if you stop before adding, or the spending wallet is empty.** The first savings wallet you add becomes where sweeps go, and the next check sends anything above the cap, and any realized gains, there by itself, with no prompt. So if your spending wallet holds money and you have no savings wallet yet, press **Cancel** instead of **Add Wallet**, at the steps marked below. The check step warns about this when it applies. A second savings wallet changes nothing, unless you press **Send It Here Instead**.

Ledger Nano X:

1. Pick **Ledger**. Check the steps against the device: the PIN, then the right button until **Ethereum**, then both buttons, and "app is ready".
2. On **Quit Ledger Wallet**, with it open, it should say it's still open, and change by itself when you quit it. Its bundle ID, `com.ledger.live`, comes from its source.
3. With Chrome as your default, **Open Google Chrome** should open the page on the Ledger's steps. With Safari as your default, it should say Safari can't, and open Chrome anyway.
4. Press **Connect my Ledger**, pick it in the list, and pick an account. Press **Add to the Mac app**, and allow it to open.
5. The Mac app should come forward at **Does your Ledger show this?**, while the device says **Verify Base address** and shows the same address. Compare every group, tick the box, and choose **Confirm** on the device. The page should say it's confirmed. Note the words the device really uses.
6. On the page, press **Open the Mac app again**. The device should show the address again, and the box in the Mac app should be unticked. Choose **Reject** on the device: the page should say so, and offer to try again.
7. **If the warning above allows it,** try again, confirm, and press **Add Wallet**. It should say where sweeps go.

Keystone:

1. Pick **Keystone**. Check the steps against the device: **ETH** on the home screen, then **Receive ETH**. Note if **Attention** comes up.
2. Allow the camera, and hold up the code. It should read it and show the same address. Compare every group, and press **Back**.
3. Show it **Connect Software Wallet**'s code instead. It should say that's the wrong code, and show nothing of what's in it.
4. Refuse the camera in System Settings, and try again. It should offer to open the setting, or let you type the address.
5. Allow it again. **If the warning above allows it,** read the code once more and press **Add Wallet**.

Once one's added, send a few dollars to it, and see them arrive. That's the first thing here that moves money on purpose.

**Ledger, in Chrome:** close Ledger Wallet, then plug in and unlock. Have the Ethereum app installed.

1. Press **Hardware wallet**, then **Ledger**. Pick it in the browser's list. It may ask to open the Ethereum app. You should see 5 accounts, with the first fresh one selected.
2. **Addresses first, before any funds move.** Press **Check it on the device**. Every character on the device's screen should match the page. Approve there, tick the box, and press **It matches**.
3. Press **Check it on the device** on another account and refuse on the device. The page should say it was refused and offer to try again.
4. Fund that account with a few dollars of ETH on Base, sent to the address you checked.
5. Press **Send to another of my wallets**, send a little ETH to another account you've checked, and compare the device's screen with the page. It should show Base.
6. Send a little USDC the same way, if it holds some. Note whether the device shows the token's name and amount, or asks for blind signing.
7. With **Blind signing off**, publish a cost from Resolve or the Mac app. The page should say to turn the setting on. Turn it on, try again, note what the device shows, and turn it back off.
8. Check that a note you published reads as `self-reported` once Amp has it.

**Keystone:** the same steps, with these differences.

1. Press **Keystone**, allow the webcam, and show it **Connect Software Wallet**, then **MetaMask**, on its standard accounts. Check that the accounts match what the device lists.
2. To check an address, find it on the device's receive screen yourself.
3. Each send shows a moving code. Scan it with the device, check what it says, approve it, and show the device's answer to the webcam.
4. For a note, write down what the screen shows and whether anything had to be turned on. The table above isn't sure.

**Browser wallet:** with Rabby and either device, connect from **Hardware wallet**, then send a little ETH and publish a note. Rabby asks the device. The page should refuse anything else.

**Mac app:** with `pnpm mac`:

1. **Top Up from Savings**, then **Continue in Browser**. The page should open with the amount and hot wallet filled in, and ask you to say the address is yours. Compare it with the Mac app first. If your default browser is Safari, Ledger is disabled there, so open the link in Chrome.
2. The extension's **Top Up…** button should get to the same sheet.
3. On the web page, press **Add to the Mac app as savings**. The Mac app should show its check step, filled in, and shouldn't add anything until you tick the box. Any other accounts should be listed with their own boxes, unticked.
4. In Resolve, on a savings wallet's cost, **Publish from Your Device…** should open the page with the cost filled in. Connect a device or account that doesn't hold that wallet: **Continue** should stay off, and it should offer **Show more** and **Use another device**.
5. In the web app, with CAD as your main currency, type a cost in Resolve and press **Publish from your device…**. The form should ask for USD, not carry over what you typed.
