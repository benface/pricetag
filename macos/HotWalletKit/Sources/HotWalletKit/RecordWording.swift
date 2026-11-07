import Foundation
import KeyVault
import PricetagKit

/// What a record of something this Mac signed says, on Spending Money's page and in the transactions.
extension SignedRecord {
    public var title: String {
        switch reason {
        case .note: "What you paid for \(symbol)"
        case .revoke: "Approval for \(symbol)"
        default: "\(Format.amount(amount, decimals: decimals)) \(symbol)"
        }
    }

    public var reasonText: String {
        switch reason {
        case .aboveCap: gainUsdMicros == "0" ? "Above the cap" : "Above the cap or realized gains"
        case .manual: "Swept by you"
        case .rotation: "Replacing the key"
        case .site: site.map(siteName) ?? "A site"
        case .sent: "Sent to \(Format.shortHash(to.checksummed))"
        case .note: "Published for anyone to read"
        case .revoke: "Revoked, for \(Format.shortHash(to.checksummed))"
        }
    }

    public func statusText(among records: [SignedRecord]) -> String {
        switch status {
        case .pending: "On its way"
        case .confirmed: "Done"
        case .failed: "Failed"
        // Given up on, it can still land, unless another transaction took its place.
        case .dropped: records.contains { $0.nonce == nonce && ($0.status == .confirmed || $0.status == .failed) } ? "Never landed" : "Not confirmed"
        }
    }
}

extension SentTransaction {
    /// Only what's still on its way or failed. One that landed is read with the rest, and one that never did changed nothing.
    public init?(_ record: SignedRecord) {
        let status: Status
        switch record.status {
        case .pending: status = .pending
        case .failed: status = .failed
        case .confirmed, .dropped: return nil
        }
        let amount = "\(Format.amount(record.amount, decimals: record.decimals)) \(record.symbol)"
        let summary = switch record.reason {
        case .sent: "Send \(amount)"
        case .site: record.amount == "0" ? "Transaction for \(record.site.map(siteName) ?? "a site")" : "Send \(amount) for \(record.site.map(siteName) ?? "a site")"
        case .note: "Publish what you paid for \(record.symbol)"
        case .revoke: "Revoke an approval for \(record.symbol)"
        case .aboveCap, .manual, .rotation: "Move \(amount) to savings"
        }
        self.init(txHash: record.hash, date: record.createdAt, summary: summary, to: record.to.lowercased, asset: record.reason == .note || record.reason == .revoke ? nil : record.symbol, status: status)
    }
}

extension HotWallet {
    /// What Buy starts at, once the wallet's been read: the room left is unknown before, and would read as the whole cap. Without
    /// savings it's all the room, since nothing would move what's above it.
    public var buySuggestion: Int? {
        guard plan != nil else { return nil }
        let room = display.wholeAmount(topUpRoom, rounding: .down)
        let start = settings.sweepDestination == nil ? room : min(room, 20)
        return max(display.wholeAmount(BuyPlan.minimumUsdMicros, rounding: .up), start)
    }

    /// What deleting an old key leaves behind, for someone about to do it.
    public var leavingOldKeyMessage: String {
        HotWalletWording.leavingOldKey(isMissing: isKeyMissing, hold: rotationHold)
    }
}
