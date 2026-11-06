import Foundation
import KeyVault
import PricetagKit

/// Something this wallet did that's worth telling someone who isn't looking. Only what it did, never what a price did.
public enum HotWalletNews: Equatable, Sendable {
    /// Its receipt came back, saying it landed or that it failed onchain.
    case settled(SignedRecord)
    /// It's been given up on after a wait, so its nonce is free again. It hasn't landed, but it still can, so this says nothing about whether money moved.
    case unconfirmed(SignedRecord)
    /// One that was given up on turned out to have landed.
    case landedLate(SignedRecord)
    /// An automatic sweep couldn't go out. It tries again by itself.
    case sweepDidntGoOut(String)
}

extension HotWalletWording {
    /// What to say about news that came in together, like a sweep's ETH and USDC landing a moment apart, as few notifications as that can be.
    /// What the person did and is waiting on in front of them is left to the app to hold back, since only it knows what's on screen.
    public static func notices(for news: [HotWalletNews], savingsName: (EthereumAddress) -> String?, in display: MoneyDisplay) -> [MoneyNotice] {
        var notices: [MoneyNotice] = []
        var swept: [SignedRecord] = []
        var moved: [SignedRecord] = []
        let waited = "hasn't landed after \(Int(HotWallet.pendingTimeout / 60)) minutes. It may still go through"
        for item in news {
            switch item {
            case .settled(let record) where record.status == .confirmed:
                switch record.reason {
                case .aboveCap, .manual: swept.append(record)
                case .rotation: moved.append(record)
                case .sent: notices.append(notice(record, "Sent", "\(amount(record)) went to \(recipient(record, savingsName))."))
                // The site shows what became of it, and a published cost or a revoked approval is in the app the moment it lands.
                case .site, .note, .revoke: break
                }
            case .settled(let record):
                notices.append(notice(record, failedTitle(record), failedOnchainText(record)))
            case .unconfirmed(let record):
                // The same id as what it turns out to be, so that replaces this.
                switch record.reason {
                // A sweep that didn't land goes again by itself.
                case .aboveCap, .manual, .rotation: break
                case .sent: notices.append(notice(record, "Send Not Confirmed Yet", "\(amount(record)) to \(recipient(record, savingsName)) \(waited), so check Spending Money before sending it again."))
                case .site: notices.append(notice(record, "Transaction Not Confirmed Yet", "A transaction for \(record.site.map(siteName) ?? "a site") \(waited), so check before trying it again."))
                case .note: notices.append(notice(record, "Cost Not Published Yet", "Publishing the cost of \(record.symbol) \(waited), so check before publishing it again."))
                case .revoke: notices.append(notice(record, "Revoke Not Confirmed Yet", "Revoking an approval for \(record.symbol) \(waited), so check before revoking it again."))
                }
            case .landedLate(let record):
                switch record.reason {
                case .aboveCap, .manual: swept.append(record)
                case .rotation: moved.append(record)
                case .sent: notices.append(notice(record, "Sent", "\(amount(record)) went to \(recipient(record, savingsName)) after all."))
                case .site: notices.append(notice(record, "Transaction Confirmed", "The transaction for \(record.site.map(siteName) ?? "a site") landed after all."))
                case .note: notices.append(notice(record, "Cost Published", "The cost of \(record.symbol) was published after all."))
                case .revoke: notices.append(notice(record, "Approval Revoked", "The approval for \(record.symbol) was revoked after all."))
                }
            case .sweepDidntGoOut(let message):
                notices.append(MoneyNotice(id: MoneyNotice.sweepProblemRow, title: "Sweep Didn't Go Out", body: "\(message) It tries again in a few minutes.", row: MoneyNotice.sweepProblemRow))
            }
        }
        if let first = swept.first {
            let destinations = Set(swept.map(\.to))
            let to = destinations.count == 1 ? savingsName(first.to) ?? "your savings" : "your savings"
            notices.insert(notice(first, "Swept to Savings", "\(amounts(swept))\(worth(swept, in: display)) moved to \(to)."), at: 0)
        }
        if let first = moved.first {
            // Its records belong to a key that's about to be gone, so this opens what the money's on now.
            let to = Set(moved.map(\.to)).count == 1 ? savingsName(first.to) ?? "the new key" : "the new key"
            notices.insert(MoneyNotice(id: MoneyNotice.recordRow(first.hash), title: "Moved Off the Old Key", body: "\(amounts(moved)) moved to \(to).", row: MoneyNotice.balanceRow), at: 0)
        }
        return notices
    }

    private static func recipient(_ record: SignedRecord, _ savingsName: (EthereumAddress) -> String?) -> String {
        savingsName(record.to) ?? Format.shortHash(record.to.checksummed)
    }

    private static func notice(_ record: SignedRecord, _ title: String, _ body: String) -> MoneyNotice {
        let row = MoneyNotice.recordRow(record.hash)
        return MoneyNotice(id: row, title: title, body: body, row: row)
    }

    private static func failedTitle(_ record: SignedRecord) -> String {
        switch record.reason {
        case .aboveCap, .manual, .rotation: "Sweep Failed"
        case .sent: "Send Failed"
        case .site: "Transaction Failed"
        case .note: "Cost Not Published"
        case .revoke: "Revoke Failed"
        }
    }

    private static func failedOnchainText(_ record: SignedRecord) -> String {
        switch record.reason {
        case .aboveCap, .manual, .rotation: "A sweep of \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
        case .sent, .note, .revoke: failedOnchain(record)
        case .site: "A transaction for \(record.site.map(siteName) ?? "a site") failed onchain. Nothing moved, but its gas was spent."
        }
    }

    private static func amount(_ record: SignedRecord) -> String {
        "\(Format.amount(record.amount, decimals: record.decimals)) \(record.symbol)"
    }

    private static func amounts(_ records: [SignedRecord]) -> String {
        records.map(amount).formatted(.list(type: .and))
    }

    /// What it was worth when it went, which is a fact about these transactions. Left out unless every one of them had a price.
    private static func worth(_ records: [SignedRecord], in display: MoneyDisplay) -> String {
        let values = records.compactMap { $0.usdMicros.flatMap { UInt128($0) } }
        guard !values.isEmpty, values.count == records.count else { return "" }
        return ", worth \(display.money(values.reduce(0, +))),"
    }
}
