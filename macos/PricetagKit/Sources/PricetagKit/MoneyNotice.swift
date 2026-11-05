// What the app tells someone who isn't looking when money moves. Only what their own wallet did: never a price, a gain or anything
// else that rewards watching. The words are here so they can be tested. Showing them is the app's.

import Foundation

/// One system notification. Its title never has an amount in it, so a locked screen that shows titles says what happened and not how much.
public struct MoneyNotice: Equatable, Sendable {
    /// The same id replaces the last one, so a purchase that's delivered and then gets its cost is one notification, not two.
    public let id: String
    public let title: String
    public let body: String
    /// The row it's about, which clicking it opens.
    public let row: String

    public init(id: String, title: String, body: String, row: String) {
        self.id = id
        self.title = title
        self.body = body
        self.row = row
    }

    /// What a locked screen shows in place of the body, when the system hides it.
    public static let hiddenBody = "Your spending money changed."

    /// Why a sweep didn't go out, which is a notice at the top rather than a row.
    public static let sweepProblemRow = "sweep-problem"
    /// Spending Money's balance, at the top. Also where a row goes that's no longer shown, like one from a key that's been replaced.
    public static let balanceRow = "balance"
    public static func purchaseRow(_ ref: String) -> String { "purchase-\(ref)" }
    public static func recordRow(_ hash: String) -> String { "record-\(hash)" }
}

/// How far the news of a purchase has got. A phase can step back, as when a wallet's numbers are reloading or another wallet is chosen
/// and its cost waits to be matched again, but what's been told never does.
public enum PurchaseMilestone: Int, Codable, Comparable, Sendable {
    case started, delivered, finished

    public init(_ phase: PurchasePhase) {
        switch phase {
        case .onProvidersPage, .onItsWay, .noOrderYet: self = .started
        case .arriving: self = .delivered
        case .recorded, .costUnknown, .costNotSaid, .noRateFor, .failed: self = .finished
        }
    }

    public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

/// What's been told about each purchase, kept so a relaunch doesn't tell it again.
public struct PurchaseNews: Codable, Equatable, Sendable {
    public private(set) var told: [String: PurchaseMilestone] = [:]

    public init() {}

    /// What's new since what was told, which is then told. A purchase seen for the first time is only taken note of: one started here is
    /// seen as it starts, so one that isn't is from before this kept track, and whatever its order already says isn't news.
    public mutating func update(_ purchases: [(TrackedPurchase, PurchasePhase)], beside main: CurrencyCode) -> [MoneyNotice] {
        var notices: [MoneyNotice] = []
        var next: [String: PurchaseMilestone] = [:]
        for (purchase, phase) in purchases {
            let now = PurchaseMilestone(phase)
            guard let earlier = told[purchase.ref] else {
                let isSettled = purchase.order?.txHash != nil || purchase.order?.status == .failed
                next[purchase.ref] = isSettled ? .finished : now
                continue
            }
            if now > earlier, let notice = PurchaseWording.notice(for: purchase, phase: phase, after: earlier, beside: main) { notices.append(notice) }
            next[purchase.ref] = max(earlier, now)
        }
        // What's no longer listed has nothing more to say.
        told = next
        return notices
    }
}

extension PurchaseWording {
    /// What to say about a purchase that's got further than `told`. Nothing for what the person does on the provider's page, which they're looking at.
    public static func notice(for purchase: TrackedPurchase, phase: PurchasePhase, after told: PurchaseMilestone, beside main: CurrencyCode) -> MoneyNotice? {
        guard PurchaseMilestone(phase) > told else { return nil }
        let what = title(purchase, beside: main)
        // Delivered and then known is one story, and a phase can skip straight to the end of it.
        let wasDelivered = told == .delivered
        let (heading, body): (String, String)
        switch phase {
        case .onProvidersPage, .onItsWay, .noOrderYet:
            return nil
        case .arriving:
            (heading, body) = ("Purchase Delivered", "\(what) arrived from \(provider). Its cost is recorded once it shows up here.")
        case .recorded(let cost):
            (heading, body) = (wasDelivered ? "Purchase Cost Recorded" : "Purchase Delivered", "\(what) arrived. It cost \(Format.money(cost, beside: main)), fees included.")
        case .costUnknown:
            (heading, body) = (wasDelivered ? "Purchase Cost Unknown" : "Purchase Delivered", "\(what) arrived, but its cost is unknown: the order didn't match what arrived.")
        case .costNotSaid:
            (heading, body) = (wasDelivered ? "Purchase Cost Unknown" : "Purchase Delivered", "\(what) arrived, but its cost is unknown: the order doesn't say what you paid.")
        case .noRateFor(let currency):
            (heading, body) = (wasDelivered ? "Purchase Cost Unknown" : "Purchase Delivered", "\(what) arrived, but its cost is unknown: there's no exchange rate for \(currency).")
        case .failed(.payment):
            (heading, body) = ("Purchase Didn't Go Through", "\(provider) couldn't take the payment for \(what). Nothing was bought.")
        case .failed(.delivery):
            (heading, body) = ("Purchase Didn't Arrive", "\(provider) couldn't deliver \(what).")
        }
        let row = MoneyNotice.purchaseRow(purchase.ref)
        return MoneyNotice(id: row, title: heading, body: body, row: row)
    }
}
