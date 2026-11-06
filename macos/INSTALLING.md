**Patina needs macOS 27.** It won't open on anything older.

**This is an unreviewed hackathon build. Only put in what you could lose.** It holds real money in a wallet it created, and nobody outside the team has reviewed it. Keep it to small amounts, up to the cap you set, which can't go above $100.

# Patina

## What it is

Patina shows what a Base wallet is worth, what you paid for what's in it, and how it's done. It can also hold a little Spending Money, to send, to buy with and to use on sites.

## Installing it

1. Download the `.dmg` from the Slack message it came in, and open it.
2. Drag Patina to Applications.
3. Open it from Applications, and choose Open if macOS asks whether you're sure. It lives in the menu bar, and its window opens too. If your menu bar is full, look under its "show hidden items" control.

## The invite

Patina reads prices and history from its server, which only answers people it invited. The first time you open it, it asks for your invite, which comes separately, as a direct message on Slack. Paste it and press Continue. It's saved on this Mac, for that server alone. Please don't share it: it's yours, and it can be taken back. To change it later, go to Settings > General.

## Spending Money

Patina makes a new wallet on this Mac. Its key is locked to this Mac's Secure Enclave, so **it can't be exported, backed up or moved to another Mac. If this Mac is lost or wiped, what's in it is gone.** Patina never shows you a recovery phrase, because there isn't one. Use a hardware wallet for anything you'd want to keep: it's also where anything above your cap gets swept.

Double-check an address before you send to it. Sends on Base can't be undone.

## The browser extension (optional)

You only need this to use Spending Money on websites. It isn't in a store, so you add it by hand, in Chrome, Brave, Edge, Arc, Dia or Vivaldi:

1. Copy the **Browser Extension** folder from the `.dmg` to somewhere it can stay, like Documents. Your browser keeps reading it from there.
2. Open `chrome://extensions` and turn on Developer mode.
3. Press **Load unpacked** and choose that folder.
4. Keep Patina open while you use it. Patina has to have been opened from Applications at least once, which is how your browser learns where to find it. If the extension says it can't reach the app, quit your browser and open it again.

Every transaction a site asks for shows up in Patina for you to approve.

## What might not work yet

- **Buy** only works once it's been set up on the server. Until then, it says buying isn't set up. When it is, Coinbase may limit each purchase to about CA$7 for now.
- **Prices** cover ETH and a short list of tokens. Anything else shows as unknown, and history starts in November 2026.
- Answers you give about where something came from stay on this Mac. They're only sent to Patina's server to work out your numbers, and it keeps nothing.

## Problems

If the server's down, Patina says so, and it never shows you zero balances. Updates start again by themselves when it's back.

To report anything else, message the person who sent you this, with what you did, what you saw, and a screenshot if you can. Please leave your wallet address out of it unless you're happy to share it.
