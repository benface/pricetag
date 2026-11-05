import Foundation
import PricetagKit

/// The hot wallet's sentences. It's "this device's spending money" and the cold wallet is "your savings", everywhere.
public enum HotWalletWording {
    public static let title = "Spending Money"
    public static let label = "Hackathon, small funds only"
    public static let cannotBeRestored = "This money lives only on this device. There's no recovery phrase and no backup: if this device is lost or erased, what's on it is gone."
    public static let newDevice = "Getting a new device? Sweep everything to your savings first."
    public static func addSavings(beside main: CurrencyCode) -> String {
        "Add a savings wallet. Without one, this is all you have, so the cap stays at \(usd(dollars: 25, beside: main)) and nothing can be swept."
    }

    public static let sweepsOnlyWhileOpen = "Sweeps only run while the app is open. If it's closed, whatever arrives stays here until it opens again."

    /// The cap, and everything measured against it, stays in USD.
    public static func usd(_ micros: UInt128, beside main: CurrencyCode) -> String {
        Format.usd(Format.money(String(micros), .USD), beside: main)
    }

    /// For the whole dollars a slider moves in.
    public static func usd(dollars: Int, beside main: CurrencyCode) -> String {
        Format.usd("$\(dollars)", beside: main)
    }

    public static func overCap(by excess: UInt128, hasDestination: Bool, beside main: CurrencyCode) -> String {
        hasDestination
            ? "\(usd(excess, beside: main)) over the cap. It's being moved to your savings."
            : "\(usd(excess, beside: main)) over the cap, with nowhere to sweep it. Add a savings wallet."
    }

    public static func shortOverCap(by excess: UInt128, beside main: CurrencyCode) -> String {
        "\(usd(excess, beside: main)) over the cap"
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
    public static let cantCheckAmp = "Can't read this wallet's history from Amp right now, so it isn't being compared with what this app signed. It still checks how many transactions this key has sent."
    public static let feesLookWrong = "The network is quoting far higher fees than Base ever charges, so nothing was signed. Check the network address in Settings."
    public static let keyMissing = "This device no longer has this wallet's key, so nothing here can be moved. This can happen after restoring onto a different device."
    public static let rotating = "Moving everything off the old key. It's deleted once there's nothing left on it."

    public static func rotationHeldByOtherTokens(_ count: Int) -> String {
        "The old key still holds \(count) \(count == 1 ? "token" : "tokens") this app doesn't track, and it won't touch them. It keeps the old key until you choose to leave \(count == 1 ? "it" : "them") behind."
    }

    /// Not "worth less than the gas": ETH is held at up to twice the gas to send it, whether or not it has a price.
    public static func tooCostlyToMove(_ symbols: [String]) -> String {
        "some \(symbols.joined(separator: ", ")) that gas makes too costly to move right now"
    }

    public static func rotationHeldByGas(_ symbols: [String]) -> String {
        "The old key still holds \(tooCostlyToMove(symbols)). It keeps the old key, and moves \(symbols.count == 1 ? "it" : "them") if that changes, until you choose to leave \(symbols.count == 1 ? "it" : "them") behind."
    }

    public static let rotationCantCheck = "Everything this app tracks has moved, but it can't check the old key for other tokens right now. It keeps the old key until it can, or until you choose to delete it."

    public static let notEnoughToSend = "That's more than this wallet holds."
    public static func keptForGas(_ reserve: UInt128) -> String {
        "That would use the \(Format.amount(String(reserve), decimals: 18)) ETH this wallet keeps for gas."
    }

    public static let noGasToSend = "This wallet doesn't have enough ETH to pay the network fee."
    public static let sendingToItself = "That's this wallet."
    public static let sendingToARetiredKey = "That's an old key from this Mac, whose private key is gone. Nothing could ever move what's sent there."
    public static let sendingToNobody = "Nobody can use that address. What's sent there is gone."
    public static let sendingToAToken = "That's a token's contract, not a wallet. What's sent there is usually gone for good."
    public static let lastOneStillShowingUp = "The last transaction is still showing up. Try again in a moment."
    public static let lastOneOnItsWay = "The last transaction is still on its way. Try again in a moment."
    public static let networkBusy = "The network is limiting how often this app can ask it things. Try again in a moment, or set a dedicated network address in Settings."
    static let wouldFail = "This transaction would fail: "
    public static let feesRoseAfterApproval = "Fees rose a lot since you approved this, so nothing was signed. Try again."
    public static let unreadableAnswer = "The network sent an answer this app can't read, so nothing was signed. Try again in a moment."
    public static let changedWhileWaiting = "This wallet changed while that was waiting, so nothing was signed."

    public static func failedOnchain(_ record: SignedRecord) -> String {
        record.reason == .note
            ? "Publishing the cost of \(record.symbol) failed onchain. Nothing was published, but its gas was spent."
            : "Sending \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
    }

    public static func alarm(_ alarm: StolenKeyAlarm) -> String {
        alarm.findings.map {
            switch $0 {
            case .unknownTransaction(let hash): "A transaction this app didn't sign took funds from this wallet: \(hash)."
            case .nonceAhead(let signed, let onchain): "This key has sent \(onchain) \(onchain == 1 ? "transaction" : "transactions"), and this app only signed \(signed)."
            case .nonceTaken(_, let ours): "Another transaction from this key took the place of one this app signed: \(ours)."
            }
        }.joined(separator: " ")
    }

    /// For places with room for only a few words, like the menu bar.
    public static let alarmShort = "Key may be stolen"
    public static let alarmHeadline = "This wallet's key may be stolen"
    public static let alarmAdvice = "Top-ups and sends are stopped. Move what's left and replace the key now. Anything sent here can be taken."
}
