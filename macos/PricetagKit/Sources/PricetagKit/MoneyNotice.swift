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
    public static func purchaseRow(_ ref: String) -> String { "purchase-\(ref)" }
    public static func recordRow(_ hash: String) -> String { "record-\(hash)" }
}

extension PurchaseWording {
    /// What's worth saying about a purchase that's moved on since `earlier`. Nothing for what the person does on the provider's page,
    /// which they're looking at, or for a purchase this is the first look at.
    public static func notice(for purchase: TrackedPurchase, from earlier: PurchasePhase?, to phase: PurchasePhase, beside main: CurrencyCode) -> MoneyNotice? {
        guard let earlier, earlier != phase else { return nil }
        let what = title(purchase, beside: main)
        // Delivered and then known is one story, and a phase can skip straight to the end of it.
        let wasDelivered = earlier == .arriving
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
