import Foundation
import KeyVault
import PricetagKit

/// Something this wallet did that's worth telling someone who isn't looking. Only what it did, never what a price did.
public enum HotWalletNews: Equatable, Sendable {
    /// Its receipt came back, saying it landed or that it failed onchain.
    case settled(SignedRecord)
    /// It never made it into a block, and nothing moved.
    case neverLanded(SignedRecord)
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
        for item in news {
            switch item {
            case .settled(let record) where record.status == .confirmed:
                switch record.reason {
                case .aboveCap, .manual: swept.append(record)
                case .rotation: moved.append(record)
                case .sent: notices.append(notice(record, "Sent", "\(amount(record)) went to \(savingsName(record.to) ?? Format.shortHash(record.to.checksummed))."))
                // The site shows what became of it, and a published cost is in the app the moment it lands.
                case .site, .note: break
                }
            case .settled(let record):
                notices.append(notice(record, failedTitle(record), failedOnchainText(record)))
            case .neverLanded(let record):
                switch record.reason {
                // A sweep that didn't land goes again by itself.
                case .aboveCap, .manual, .rotation: break
                case .sent: notices.append(notice(record, "Send Didn't Go Through", "\(amount(record)) to \(savingsName(record.to) ?? Format.shortHash(record.to.checksummed)) never landed, so nothing moved."))
                case .site: notices.append(notice(record, "Transaction Didn't Go Through", "A transaction for \(record.site.map(siteName) ?? "a site") never landed, so nothing moved."))
                case .note: notices.append(notice(record, "Cost Not Published", "Publishing the cost of \(record.symbol) never landed, so nothing was published."))
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
            notices.insert(notice(first, "Moved to the New Key", "\(amounts(moved)) moved off the old key."), at: 0)
        }
        return notices
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
        }
    }

    private static func failedOnchainText(_ record: SignedRecord) -> String {
        switch record.reason {
        case .aboveCap, .manual, .rotation: "A sweep of \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
        case .sent, .note: failedOnchain(record)
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
