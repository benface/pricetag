// Naming which units a send takes, as it's signed. US rules only count units named no later than the sale, and a choice made before
// the transaction exists is one the app itself can vouch for. `src/core/held-units.ts` is the same on the web, and works out what's held.

import Foundation

/// What a wallet still holds of a token, by purchase, as the server folds it for a US report.
public struct HeldUnits: Codable, Sendable, Equatable {
    public struct Purchase: Codable, Sendable, Equatable, Identifiable {
        /// When it was bought, as `toISOString` writes it. It's what a choice names it by.
        public let boughtAt: String
        public let units: String
        /// What all of it cost, or nil when that's unknown.
        public let costMicros: String?
        /// Bought at that moment at different costs, so only all of it can be named, since naming part doesn't say which.
        public let allOnly: Bool

        public var id: String { boughtAt }
        public var amount: UInt128 { UInt128(units) ?? 0 }

        public init(boughtAt: String, units: String, costMicros: String?, allOnly: Bool) {
            self.boughtAt = boughtAt
            self.units = units
            self.costMicros = costMicros
            self.allOnly = allOnly
        }
    }

    /// Oldest first.
    public let purchases: [Purchase]
    /// Units nothing can name, because nothing says exactly when they were bought.
    public let unnamed: String

    public init(purchases: [Purchase], unnamed: String) {
        self.purchases = purchases
        self.unnamed = unnamed
    }
}

/// What the server says a wallet holds, by token.
public struct HeldByAsset: Codable, Sendable, Equatable {
    public let assets: [String: HeldUnits]

    public init(assets: [String: HeldUnits]) {
        self.assets = assets
    }
}

/// How much each purchase gives, by when it was bought, in a token's smallest units.
public typealias UnitPicks = [String: UInt128]

public enum NamedUnits {
    /// `UnitChoice` holds at most this many, the same as the web's `MAX_CHOICE_TAKES`.
    public static let mostTakes = 64

    /// Why these picks can't go with a send of `units`, or nil when they can. Nothing picked at all isn't a choice, so it's for the caller
    /// to say whether that's fine.
    public static func problem(held: HeldUnits, picks: UnitPicks, units: UInt128, format: (UInt128) -> String) -> String? {
        let picked = picks.filter { $0.value > 0 }
        if picked.count > mostTakes { return "A send can name up to \(mostTakes) purchases." }
        for (at, n) in picked.sorted(by: { $0.key < $1.key }) {
            guard let purchase = held.purchases.first(where: { $0.boughtAt == at }) else { return "One of those purchases isn't held anymore." }
            if n > purchase.amount { return "That's more than is left of one purchase, which has \(format(purchase.amount))." }
            if purchase.allOnly, n != purchase.amount { return "One purchase was bought at different prices at the same moment, so it's all \(format(purchase.amount)) or none of it." }
        }
        let named = picked.values.reduce(0, +)
        if named != units { return "Those add up to \(format(named)), and this sends \(format(units))." }
        return nil
    }

    /// When something happened, the way `toISOString` writes it, which is how a choice says when it was made.
    public static func moment(_ date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// When a purchase was made, as someone reads it.
    public static func shown(_ moment: String) -> String {
        date(moment)?.formatted(date: .abbreviated, time: .shortened) ?? moment
    }

    static func date(_ moment: String) -> Date? {
        try? Date(moment, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }
}

extension UnitChoice {
    /// The record of which units a send took, made at `recordedAt`, before it was signed. Nil when nothing's named.
    public init?(wallet: String, txHash: String, asset: String, recordedAt: String, picks: UnitPicks) {
        let takes = picks.filter { $0.value > 0 }.sorted { $0.key < $1.key }.map { Take(boughtAt: $0.key, units: String($0.value)) }
        guard !takes.isEmpty else { return nil }
        self.init(wallet: wallet.lowercased(), txHash: txHash.lowercased(), asset: asset, recordedAt: recordedAt, takes: takes)
    }
}

/// The page a top-up opened saying which units it took, once it's signed. `unitChoiceLink` in `src/core/device-link.ts` writes it.
/// Anyone can make this link, so it's only a claim until `UnitChoiceHandoff` finds the top-up it's about.
public struct UnitChoiceLink: Equatable, Sendable {
    public let choice: UnitChoice

    public init?(url: URL) {
        guard url.scheme == AddSavingsLink.scheme, url.host() == "unit-choice", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacing("+", with: "%20")
        guard let items = parts.queryItems else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard let wallet = value("wallet"), WalletAddress.isValid(wallet),
              let tx = value("tx")?.lowercased(), tx.wholeMatch(of: /0x[0-9a-f]{64}/) != nil,
              let asset = value("asset"), asset.wholeMatch(of: /[A-Za-z0-9]{1,16}/) != nil,
              let recorded = value("recorded"), NamedUnits.date(recorded) != nil,
              let written = value("takes") else { return nil }
        var takes: [UnitChoice.Take] = []
        for part in written.split(separator: ",") {
            let halves = part.split(separator: "~")
            guard halves.count == 2, NamedUnits.date(String(halves[0])) != nil, let units = UInt128(String(halves[1])), units > 0 else { return nil }
            takes.append(UnitChoice.Take(boughtAt: String(halves[0]), units: String(units)))
        }
        guard !takes.isEmpty, takes.count <= NamedUnits.mostTakes, Set(takes.map(\.boughtAt)).count == takes.count else { return nil }
        choice = UnitChoice(wallet: wallet.lowercased(), txHash: tx, asset: asset, recordedAt: recorded, takes: takes)
    }
}

/// The top-ups this app has opened, so a record that comes back is only kept for one of them: from one of the savings wallets it said
/// what was held in, and made after it opened the page and before it came back. Only for as long as a page stays open, and not across launches.
@MainActor
public final class UnitChoiceHandoff {
    private struct Opened {
        let wallets: Set<String>
        let at: Date
    }

    /// The page stops being served after this, so nothing later can be from it.
    static let longest: TimeInterval = 3600
    private var opened: [Opened] = []

    public init() {}

    /// The app's own, since a link back can arrive in any window.
    public static let shared = UnitChoiceHandoff()

    public func opened(wallets: [String], at date: Date = .now) {
        opened.removeAll { date.timeIntervalSince($0.at) > Self.longest }
        opened.append(Opened(wallets: Set(wallets.map { $0.lowercased() }), at: date))
    }

    /// The record to keep, or nil when no top-up this app opened could have made it.
    public func accept(_ link: UnitChoiceLink, at date: Date = .now) -> UnitChoice? {
        let choice = link.choice
        guard let recorded = NamedUnits.date(choice.recordedAt), recorded <= date.addingTimeInterval(60) else { return nil }
        let matches = opened.contains { top in
            top.wallets.contains(choice.wallet) && date.timeIntervalSince(top.at) <= Self.longest && recorded >= top.at.addingTimeInterval(-1)
        }
        return matches ? choice : nil
    }
}
