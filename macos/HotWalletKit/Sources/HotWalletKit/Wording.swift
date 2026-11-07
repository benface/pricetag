import Foundation
import KeyVault
import PricetagKit

/// The hot wallet's sentences. It's "this device's spending money" and the cold wallet is "your savings", everywhere.
public enum HotWalletWording {
    /// For someone about to delete an old key, and what's on it for good.
    public static func leavingOldKey(isMissing: Bool, hold: HotWallet.RotationHold?) -> String {
        let lost = "What's still on the old address can never be moved again."
        if isMissing { return "This device no longer has it. \(lost)" }
        return switch hold {
        case .otherTokens(let count): "It holds \(count) \(count == 1 ? "token" : "tokens") this app doesn't track. \(lost)"
        case .cantCheckOtherTokens: "This app can't check right now whether it holds other tokens. \(lost)"
        case .notWorthTheGas(let symbols): "It holds \(tooCostlyToMove(symbols)). \(lost)"
        case .notEnoughGas, nil: "It holds tokens with no ETH to move them. \(lost)"
        }
    }

    public static let title = "Spending Money"
    public static let summary = "A small balance for everyday use, with no recovery phrase to write down."
    public static let cannotBeRestored = "This money lives only on this device. There's no recovery phrase and no backup: if this device is lost or erased, what's on it is gone."
    public static let newDevice = "Getting a new device? Sweep everything to your savings first."
    public static func addSavings(in display: MoneyDisplay) -> String {
        "Add a savings wallet. Without one, this is all you have, so the cap stays at \(display.whole(WalletSettings.capCeilingWithoutCold)) and nothing can be swept."
    }

    /// Why removing a savings wallet is more than a list entry: where sweeps go next, and what's kept.
    public static func removingFromSavings(sweepsNowGoTo next: String?, wasDestination: Bool, cap: String) -> String {
        let kept = "It stays in Yours, with what's on it."
        guard wasDestination else { return kept }
        if let next { return "Sweeps go to \(next) from now on. \(kept)" }
        return "Sweeps stop, and the cap can't be more than \(cap) until you add another. \(kept)"
    }

    public static let addSavingsButton = "Add a Savings Wallet…"

    /// Without a savings wallet, the money can still come from a hardware wallet that hasn't been added, but nothing goes back to it.
    public static func topUpTitle(hasDestination: Bool) -> String {
        hasDestination ? "Top Up from Savings" : "Top Up"
    }

    public static func topUpRoom(_ room: String, hasDestination: Bool) -> String {
        "There's room for \(room) under your cap. " + (hasDestination ? "Anything above that gets swept back to your savings." : "Anything above that stays here, over the cap, until you add a savings wallet.")
    }

    public static func topUpAtCap(_ cap: String, hasDestination: Bool) -> String {
        "This wallet is already at its cap of \(cap). " + (hasDestination ? "Anything more would be swept straight back." : "Anything more would stay here, over the cap, until you add a savings wallet.")
    }

    public static func topUpNeedsGas(hasDestination: Bool) -> String {
        "Send some of it as ETH. This wallet needs a little to pay for its \(hasDestination ? "sweeps" : "transactions")."
    }

    /// Receive's one line. An address can't turn money away, so it says what happens to anything over the cap.
    public static func receiveNote(cap: String, hasDestination: Bool) -> String {
        "Send only on Base. Anything above your \(cap) cap " + (hasDestination ? "gets swept to your savings." : "stays here until you add a savings wallet.")
    }

    /// Buy's warning without savings. The provider's page can raise the amount, so it says what happens to the rest, whatever's typed.
    public static func buyWithoutSavings(cap: String, provider: String) -> String {
        "You don't have a savings wallet, so anything above your \(cap) cap stays here, with no backup, until you add one. \(provider)'s page can change the amount."
    }

    /// Where a purchase ends up. `fits` and `aboveCap` are already formatted, and nil when there's none.
    public static func buyLands(fits: String?, aboveCap: String?, savings: String?) -> String {
        guard let aboveCap else { return "It all stays in Spending Money." }
        guard let savings else {
            guard let fits else { return "Spending Money is already at its cap, so all of it stays here, above it." }
            return "\(fits) fits under your cap. The other \(aboveCap) stays here too, above it."
        }
        guard let fits else { return "Spending Money is full, so it all goes to \(savings)." }
        return "\(fits) stays in Spending Money, the rest goes to \(savings)."
    }

    /// A purchase above what Spending Money has room for, through an address made just for it.
    public static func buyThroughOneUseKey(savings: String) -> String {
        "It all goes to \(savings), through a new address made just for this purchase, so nothing Spending Money has approved can touch it."
    }

    public static func buyNoGasThroughOneUseKey(_ symbol: String, savings: String) -> String {
        "Spending Money needs a little ETH to pay the fee to move \(symbol) on to \(savings). Add some, or buy ETH this time."
    }

    public static func buyNoGas(_ symbol: String, savings: String?) -> String {
        "This wallet doesn't have enough ETH to move \(symbol)\(savings.map { " to \($0)" } ?? ""), so it could get stuck here. Buy ETH this time."
    }

    public static let sweepsOnlyWhileOpen = "Sweeps only run while the app is open. If it's closed, whatever arrives stays here until it opens again."

    /// The cap's held in USD, so its number here moves with the rate, and what it does doesn't.
    public static func capFollowsRate(_ main: CurrencyCode) -> String {
        "It's kept in USD, so in \(main.rawValue) it moves a little with the exchange rate."
    }

    public static func overCap(by excess: UInt128, hasDestination: Bool, in display: MoneyDisplay) -> String {
        hasDestination
            ? "\(display.money(excess)) over the cap. It's being moved to your savings, so keep this app open until it lands."
            : "\(display.money(excess)) over the cap, with nowhere to sweep it. Add a savings wallet."
    }

    public static func shortOverCap(by excess: UInt128, in display: MoneyDisplay) -> String {
        "\(display.money(excess)) over the cap"
    }

    public static func shortNoPrice(_ symbols: [String]) -> String {
        "No price for \(symbols.joined(separator: ", "))"
    }

    public static let shortKeyMissing = "Key missing"
    public static let shortOldKeyHolds = "Old key still holds tokens"
    public static let shortOldKeyUnchecked = "Can't check the old key"
    public static let shortNetworkBusy = "Network busy"
    public static let shortCantReachChain = "Can't reach the network"
    public static let shortWrongChain = "Wrong network"
    public static let shortLastActionFailed = "Last action failed"
    public static let shortNoGas = "Needs ETH for gas"
    public static let shortNoEthPrice = "No ETH price"
    public static let shortNoSavings = "No savings wallet"

    public static let noGas = "This wallet can't pay for a sweep, because it doesn't have enough ETH. Send it a little ETH so it can move its tokens."
    public static let excessIsDust = "A little over the cap, by less than it makes sense to spend gas on."

    public static func noPrice(_ symbols: [String]) -> String {
        "\(symbols.joined(separator: ", ")) \(symbols.count == 1 ? "has" : "have") no trusted price right now, so \(symbols.count == 1 ? "it isn't" : "they aren't") counted toward the cap or swept automatically. Sweep Everything still moves \(symbols.count == 1 ? "it" : "them")."
    }

    public static let noEthPrice = "ETH's price can't be read right now, so gas can't be valued and nothing is swept automatically."
    public static let wrongChain = "The network address in Settings isn't on Base, so nothing will be signed."
    public static let cantReachChain = "Can't reach the network, so balances may be old and nothing is being swept."
    public static let cantCheckAmp = "Can't read this wallet's history right now, so it isn't being compared with what this app signed. It still checks how many transactions this key has sent."
    public static let feesLookWrong = "The network is quoting far higher fees than Base ever charges, so nothing was signed. Check the network address in Settings."
    public static let keyMissing = "This device no longer has this wallet's key, so nothing here can be moved. This can happen after restoring onto a different device."
    public static let keyCameBack = "This device still had another key that's been used, so it's your wallet now rather than being lost. You can delete it too if you don't want it."
    public static let rotating = "Moving everything off the old key. It's deleted once there's nothing left on it."
    public static let deleteWaitsForRotation = "This wallet's key is being replaced, and some of its money may already be on the new key. You can delete it once that's finished."

    public static func rotationHeldByOtherTokens(_ count: Int) -> String {
        "The old key still holds \(count) \(count == 1 ? "token" : "tokens") this app doesn't track, and it won't touch them. It keeps the old key until you choose to leave \(count == 1 ? "it" : "them") behind."
    }

    /// Not "worth less than the gas": ETH is held at up to twice the gas to send it, whether or not it has a price.
    public static func tooCostlyToMove(_ symbols: [String]) -> String {
        "some \(symbols.joined(separator: ", ")) that gas makes too costly to move right now"
    }

    public static func nothingToSweep(tooCostly symbols: [String]) -> String {
        symbols.isEmpty ? "There's nothing on this wallet to sweep." : "There's nothing to sweep except \(tooCostlyToMove(symbols))."
    }

    /// Why moving everything wouldn't move anything, if it wouldn't.
    public static func whyNothingSweeps(_ plan: SweepPlan) -> String? {
        guard plan.transfers.isEmpty else { return nil }
        return plan.blockers.contains(.notEnoughGas) ? noGas : nothingToSweep(tooCostly: plan.notWorthTheGas.map(\.symbol))
    }

    /// A sweep that stopped partway. The rest stays on this wallet, and sweeping again moves it once this has landed.
    public static func sweptOnlySome(onItsWay: [String], left: [String], because reason: String) -> String {
        let going = onItsWay.formatted(.list(type: .and))
        let staying = left.formatted(.list(type: .and))
        return "\(going) \(onItsWay.count == 1 ? "is on its way" : "are on their way"), but \(staying) \(left.count == 1 ? "isn't" : "aren't"). \(reason)"
    }

    /// Why a sweep stopped after something already went, so it can't say nothing is being swept.
    static func whatStoppedASweep(_ error: ChainError) -> String {
        switch error {
        case .rejected(let message): message
        case .rateLimited: networkBusy
        case .unreachable, .unreadable: "The network stopped answering. Try again in a moment."
        }
    }

    public static func rotationHeldByGas(_ symbols: [String]) -> String {
        "The old key still holds \(tooCostlyToMove(symbols)). It keeps the old key, and moves \(symbols.count == 1 ? "it" : "them") if that changes, until you choose to leave \(symbols.count == 1 ? "it" : "them") behind."
    }

    public static let rotationCantCheck = "Everything this app tracks has moved, but it can't check the old key for other tokens right now. It keeps the old key until it can, or until you choose to delete it."

    public static let notEnoughToSend = "That's more than this wallet holds."
    public static func keptForGas(_ reserve: UInt128) -> String {
        "That would use the \(Format.amount(String(reserve), decimals: 18)) ETH this wallet keeps for gas."
    }

    /// Why the total against the cap is less than the holdings add up to.
    public static func keptOutOfCap(_ kept: UInt128) -> String {
        "\(Format.amount(String(kept), decimals: 18)) ETH is kept for gas, and doesn't count toward the cap."
    }

    public static let noGasToSend = "This wallet doesn't have enough ETH to pay the network fee."
    public static let sendingToItself = "That's this wallet."
    public static let sendingToARetiredKey = "That's an old key from this Mac, whose private key is gone. Nothing could ever move what's sent there."
    public static let sendingToNobody = "Nobody can use that address. What's sent there is gone."
    public static let sendingToAToken = "That's a token's contract, not a wallet. What's sent there is usually gone for good."
    public static let cantReadRecords = "This wallet's records can't be read on this device, so it's stopped rather than starting over without them."
    public static let cantSaveRecords = "This wallet's records can't be saved on this device right now. Check that it has free disk space."
    public static let cantSaveRecordsYet = cantSaveRecords + " A restart could lose what's changed since, so this keeps trying."
    public static let shortCantSaveRecords = "Can't save records"
    public static let problemOnThisDevice = "A problem on this device stopped this. Try again."

    /// For anything this app didn't word itself. An error's own description can say things like a local file path, so it's never shown, or told to a site.
    public static func problem(_ error: any Error) -> String {
        switch error {
        case is RecordsNotSaved: cantSaveRecords
        #if !PATINA_WATCH_ONLY
        case KeyVault.Failure.noSuchKey: keyMissing
        #endif
        default: problemOnThisDevice
        }
    }

    public static let touchIDDidNotConfirm = "Touch ID didn't confirm this, so nothing happened."
    public static let lastOneStillShowingUp = "The last transaction is still showing up. Try again in a moment."
    public static let lastOneOnItsWay = "The last transaction is still on its way. Try again in a moment."
    public static let networkBusy = "The network is limiting how often this app can ask it things. Try again in a moment, or set a dedicated network address in Settings."
    static let wouldFail = "This transaction would fail: "
    public static let feesRoseAfterApproval = "Fees rose a lot since you approved this, so nothing was signed. Try again."
    public static let unreadableAnswer = "The network sent an answer this app can't read, so nothing was signed. Try again in a moment."
    public static let changedWhileWaiting = "This wallet changed while that was waiting, so nothing was signed."

    /// What a node's refusal means, and what to do about it. Nodes word these differently, so one this doesn't know keeps the node's own words.
    public static func refusal(_ message: String) -> String {
        let lower = message.lowercased()
        if lower.contains("insufficient funds") { return "There isn't enough ETH for this and its network fee. Add some ETH, then try again." }
        if lower.contains("revert") { return "The token's contract refused it. Check the amount and the address." }
        if lower.contains("nonce") || lower.contains("already known") || lower.contains("replacement transaction") {
            return "Another transaction from this wallet went first. Try again in a moment."
        }
        if lower.contains("underpriced") || lower.contains("fee cap") || lower.contains("base fee") { return "Network fees went up. Try again." }
        return "The network refused it, saying \u{201C}\(message)\u{201D}. Try again in a moment."
    }

    /// A send or a note the node refused, before or after it was signed. Either way, nothing left this wallet.
    public static func notSent(_ message: String) -> String {
        "Nothing was sent. \(refusal(message))"
    }

    /// What stopped a send, said for a send. The wallet's own wording is for everything it does, like sweeping.
    public static func sendFailure(_ problem: String) -> String {
        switch problem {
        case cantReachChain: "Nothing was sent, because the network can't be reached. Check your internet connection, then try again."
        case touchIDDidNotConfirm: "Nothing was sent, because Touch ID didn't confirm it. Try again."
        default: problem
        }
    }

    public static func failedOnchain(_ record: SignedRecord) -> String {
        switch record.reason {
        case .note: "Publishing the cost of \(record.symbol) failed onchain. Nothing was published, but its gas was spent."
        case .revoke: "Revoking an approval for \(record.symbol) failed onchain. It may still be there, and its gas was spent."
        default: "Sending \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
        }
    }

    public static func alarm(_ alarm: StolenKeyAlarm) -> String {
        alarm.findings.map {
            switch $0 {
            case .unknownTransaction(let hash): "A transaction this app didn't sign took funds from this wallet: \(hash)."
            case .nonceAhead(let signed, let onchain): "This key has sent \(onchain) \(onchain == 1 ? "transaction" : "transactions"), and this app only signed \(signed)."
            case .nonceTaken(_, let ours): "Another transaction from this key took the place of one this app signed: \(ours)."
            case .oneUseKeySpent(let address): "The address a purchase went to, \(address.checksummed), sent something this app didn't sign. Only this Mac had its key."
            }
        }.joined(separator: " ")
    }

    // MARK: - Purchases through a one-use address

    public static let purchaseNeedsGas = "A purchase is waiting to move to savings, and needs a little ETH in Spending Money to pay the fee. Add some, and it moves by itself."
    public static func purchaseHeldByGas(_ symbols: [String]) -> String {
        "A purchase's \(symbols.formatted(.list(type: .and))) would cost more in fees than it's worth to move to savings right now. It moves once fees come down."
    }
    public static func purchaseKeyHoldsOtherTokens(_ count: Int) -> String {
        "The address a purchase went to also holds \(count == 1 ? "a token" : "\(count) tokens") this app doesn't move. Its key stays on this Mac until they're gone."
    }
    public static let purchaseKeyCantCheck = "A purchase has moved to savings. Its address is kept until Amp can confirm nothing else is on it."
    public static let purchaseKeyMissing = "The key for the address a purchase went to is missing from this Mac, so what's there can't move to savings from here."
    public static let shortPurchaseHeld = "Purchase not moved"

    /// For places with room for only a few words, like the menu bar.
    public static let alarmShort = "Key may be stolen"
    public static let alarmHeadline = "This wallet's key may be stolen"
    public static let alarmAdvice = "Top-ups and sends are stopped. Move what's left and replace the key now. Anything sent here can be taken."
}
