import Foundation
import PricetagKit

/// The hot wallet's sentences. It's "this device's spending money" and the cold wallet is "your savings", everywhere.
public enum HotWalletWording {
    public static let title = "Spending Money"
    public static let label = "Hackathon, small funds only"
    public static let cannotBeRestored = "This money lives only on this device. There's no recovery phrase and no backup: if this device is lost or erased, what's on it is gone."
    public static let newDevice = "Getting a new device? Sweep everything to your savings first."
    public static let addSavings = "Add a savings wallet. Without one, this is all you have, so the cap stays at $25 and nothing can be swept."
    public static let sweepsOnlyWhileOpen = "Sweeps only run while the app is open. If it's closed, whatever arrives stays here until it opens again."

    public static func usd(_ micros: UInt128) -> String {
        Format.usd(String(micros))
    }

    public static func overCap(by excess: UInt128, hasDestination: Bool) -> String {
        hasDestination
            ? "\(usd(excess)) over the cap. It's being moved to your savings."
            : "\(usd(excess)) over the cap, with nowhere to sweep it. Add a savings wallet."
    }

    public static let noGas = "This wallet can't pay for a sweep, because it doesn't have enough ETH. Send it a little ETH so it can move its tokens."
    public static let excessIsDust = "A little over the cap, by less than it makes sense to spend gas on."

    public static func noPrice(_ symbols: [String]) -> String {
        "\(symbols.joined(separator: ", ")) \(symbols.count == 1 ? "has" : "have") no trusted price right now, so \(symbols.count == 1 ? "it isn't" : "they aren't") counted toward the cap or swept automatically. Sweep Everything still moves \(symbols.count == 1 ? "it" : "them")."
    }

    public static let noEthPrice = "ETH's oracle can't be read right now, so gas can't be valued and nothing is swept automatically."
    public static let wrongChain = "That RPC isn't on Base, so nothing will be signed. Change it in Settings."
    public static let cantReachChain = "Can't reach the RPC, so balances may be old and nothing is being swept."
    public static let cantCheckAmp = "Can't read this wallet's history from Amp right now, so it isn't being compared with what this app signed. The nonce check still runs."
    public static let keyMissing = "This device no longer has this wallet's key, so nothing here can be moved. This can happen after restoring onto a different device."
    public static let rotating = "Moving everything off the old key. It's deleted once there's nothing left on it."

    public static func alarm(_ alarm: StolenKeyAlarm) -> String {
        alarm.findings.map {
            switch $0 {
            case .unknownTransaction(let hash): "A transaction this app didn't sign took funds from this wallet: \(hash)."
            case .nonceAhead(let signed, let onchain): "This key has sent \(onchain) transactions, and this app only signed \(signed)."
            case .nonceTaken(let nonce, let ours): "Another transaction used nonce \(nonce) instead of this app's \(ours)."
            }
        }.joined(separator: " ")
    }

    public static let alarmHeadline = "This wallet's key may be stolen"
    public static let alarmAdvice = "Top-ups are stopped. Move what's left and replace the key now. Anything sent here can be taken."
}
