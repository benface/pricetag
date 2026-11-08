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

    /// Whether this is a moment exactly as `toISOString` writes it, which is all the server takes for when a record was made, and
    /// how a purchase is named. One written any other way, like `.0Z`, would make the whole book unreadable to it.
    public static func isMoment(_ text: String) -> Bool {
        guard text.wholeMatch(of: /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/) != nil, let date = date(text) else { return false }
        // A day the calendar doesn't have, like February 30, would come back as another. Only to the second, since milliseconds
        // don't always come back exactly from a `Date`.
        return moment(date).prefix(19) == text.prefix(19)
    }
}

/// What a top-up page needs to name the units a send takes: what each savings wallet holds, by token and purchase, with the costs in
/// `currency`, and a one-time `flow` that the record has to bring back, so nothing but that page can hand one back.
public struct TopUpNaming: Sendable, Equatable {
    public let flow: String
    public let currency: CurrencyCode
    public let held: [String: [String: HeldUnits]]

    public init(currency: CurrencyCode, held: [String: [String: HeldUnits]], flow: String = TopUpNaming.newFlow()) {
        self.flow = flow
        self.currency = currency
        self.held = held
    }

    /// 128 random bits, as hex. Nobody else can guess it, so a link can only bring it back if it came from the page this opened.
    public static func newFlow() -> String {
        var random = SystemRandomNumberGenerator()
        return (0..<2).map { _ in String(random.next() as UInt64, radix: 16) }.map { String(repeating: "0", count: 16 - $0.count) + $0 }.joined()
    }

    public static func isFlow(_ text: String) -> Bool {
        text.wholeMatch(of: /[0-9a-f]{32}/) != nil
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
    /// The top-up it says it's from.
    public let flow: String
    public let choice: UnitChoice

    public init?(url: URL) {
        guard url.scheme == AddSavingsLink.scheme, url.host() == "unit-choice", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacing("+", with: "%20")
        guard let items = parts.queryItems else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard let flow = value("flow"), TopUpNaming.isFlow(flow),
              let wallet = value("wallet"), WalletAddress.isValid(wallet),
              let tx = value("tx")?.lowercased(), tx.wholeMatch(of: /0x[0-9a-f]{64}/) != nil,
              let asset = value("asset"), asset.wholeMatch(of: /[A-Za-z0-9]{1,16}/) != nil,
              let recorded = value("recorded"), NamedUnits.isMoment(recorded),
              let written = value("takes") else { return nil }
        var takes: [UnitChoice.Take] = []
        for part in written.split(separator: ",", omittingEmptySubsequences: false) {
            let halves = part.split(separator: "~", omittingEmptySubsequences: false)
            guard halves.count == 2, NamedUnits.isMoment(String(halves[0])), halves[1].wholeMatch(of: /[1-9][0-9]{0,77}/) != nil, let units = UInt128(String(halves[1])) else { return nil }
            takes.append(UnitChoice.Take(boughtAt: String(halves[0]), units: String(units)))
        }
        guard !takes.isEmpty, takes.count <= NamedUnits.mostTakes, Set(takes.map(\.boughtAt)).count == takes.count else { return nil }
        self.flow = flow
        choice = UnitChoice(wallet: wallet.lowercased(), txHash: tx, asset: asset, recordedAt: recorded, takes: takes)
    }
}

/// The top-ups this app has opened, so a record that comes back is only kept if it brings back one's `flow`, once, and fits what that
/// top-up said was held: one of its savings wallets and tokens, purchases it listed, no more of each than was left, and made after the
/// page opened. Only for as long as a page stays open, and not across launches.
@MainActor
public final class UnitChoiceHandoff {
    private struct Opened {
        let naming: TopUpNaming
        let at: Date
    }

    /// The page stops being served after this, so nothing later can be from it.
    static let longest: TimeInterval = 3600
    private var opened: [String: Opened] = [:]

    public init() {}

    /// The app's own, since a link back can arrive in any window.
    public static let shared = UnitChoiceHandoff()

    public func opened(_ naming: TopUpNaming, at date: Date = .now) {
        opened = opened.filter { date.timeIntervalSince($0.value.at) <= Self.longest }
        opened[naming.flow] = Opened(naming: naming, at: date)
    }

    /// The record to keep, or nil when it isn't one a top-up this app opened could have made. `existing` is what's kept already: a
    /// record for the same send is never replaced this way, since only the first one could have been made before it was signed.
    /// A record that's kept uses up its top-up, so the same link can't come back twice.
    public func accept(_ link: UnitChoiceLink, existing: [UnitChoice], at date: Date = .now) -> UnitChoice? {
        let choice = link.choice
        guard let top = opened[link.flow], date.timeIntervalSince(top.at) <= Self.longest,
              let recorded = NamedUnits.date(choice.recordedAt), recorded >= top.at.addingTimeInterval(-1), recorded <= date.addingTimeInterval(60),
              let held = top.naming.held[choice.wallet]?[choice.asset],
              !existing.contains(where: { $0.txHash.lowercased() == choice.txHash })
        else { return nil }
        for take in choice.takes {
            guard let purchase = held.purchases.first(where: { $0.boughtAt == take.boughtAt }), let units = UInt128(take.units), units <= purchase.amount, !purchase.allOnly || units == purchase.amount else { return nil }
        }
        opened[link.flow] = nil
        return choice
    }
}

/// What each savings wallet holds, read while a top-up's amount is chosen, so its page can name the units the send takes. Only under
/// US rules. The page only opens once every read is back, and one that failed has to be tried again or let go on purpose: otherwise
/// the page would just have nothing to choose from, with no word why.
@MainActor @Observable
public final class TopUpHoldings {
    public enum State: Equatable {
        /// Not under US rules, so nothing's named.
        case notNeeded
        case reading
        /// Every wallet read, or the ones that didn't let go.
        case ready
        /// These couldn't be read.
        case failed([String])
    }

    public private(set) var state: State
    public private(set) var held: [String: [String: HeldUnits]] = [:]
    /// What the costs are in, as read.
    public let currency: CurrencyCode
    private let wallets: [String]
    private let read: @MainActor (String) async throws -> [String: HeldUnits]

    public init(needed: Bool, wallets: [String], currency: CurrencyCode, read: @escaping @MainActor (String) async throws -> [String: HeldUnits]) {
        state = needed && !wallets.isEmpty ? .reading : .notNeeded
        self.wallets = wallets.map { $0.lowercased() }
        self.currency = currency
        self.read = read
    }

    /// Whether the page can open now.
    public var isSettled: Bool {
        switch state {
        case .notNeeded, .ready: true
        case .reading, .failed: false
        }
    }

    /// Reads every wallet that hasn't been yet.
    public func load() async {
        guard state != .notNeeded else { return }
        let missing = wallets.filter { held[$0] == nil }
        guard !missing.isEmpty else {
            state = .ready
            return
        }
        state = .reading
        var failed: [String] = []
        for wallet in missing {
            if let assets = try? await read(wallet) { held[wallet] = assets } else { failed.append(wallet) }
            guard !Task.isCancelled else { return }
        }
        guard !Task.isCancelled else { return }
        state = failed.isEmpty ? .ready : .failed(wallets.filter(failed.contains))
    }

    /// Opens the page without the ones that couldn't be read. A send from one of them just can't name its units.
    public func goWithout() {
        if case .failed = state { state = .ready }
    }

    /// What to put in the link, with a new flow each time. Nil when there's nothing to name from.
    public func naming() -> TopUpNaming? {
        state == .ready && !held.isEmpty ? TopUpNaming(currency: currency, held: held) : nil
    }
}
