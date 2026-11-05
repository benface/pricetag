// Buying through a provider's page: what's been started, what its order says, and recording what it cost. Nothing here
// touches a key or signs anything. The page takes the payment, and what arrives is read from the chain like anything else.

import Foundation
import Observation

public struct OnrampCheckout: Codable, Sendable, Equatable {
    public let url: String
    public let ref: String

    /// Only a known provider's own page. Whatever a server says, this app won't send a purchase anywhere else.
    public var page: URL? {
        guard let page = URL(string: url), page.scheme == "https", let host = page.host(), PurchaseWording.providerHosts.contains(host) else { return nil }
        return page
    }
}

/// A provider's order, as it says. What it doesn't say, or says in a way that can't be read, is nil.
public struct OnrampOrder: Codable, Sendable, Equatable {
    public enum Status: String, Codable, Sendable {
        case pending, succeeded, failed
    }

    public enum Failure: String, Codable, Sendable {
        case payment, delivery
    }

    public let provider: String
    public let id: String
    public let status: Status
    public let failure: Failure?
    public let asset: String?
    public let units: String?
    public let wallet: String?
    public let network: String?
    public let txHash: String?
    public let blockNum: Int?
    public let cost: Money?
    public let costUsdMicros: String?
    /// The currency it was paid in, when that's why `cost` is nil: there's no rate for it.
    public let paidIn: String?

    public init(provider: String = "coinbase", id: String, status: Status, failure: Failure? = nil, asset: String? = nil, units: String? = nil, wallet: String? = nil, network: String? = nil, txHash: String? = nil, blockNum: Int? = nil, cost: Money? = nil, costUsdMicros: String? = nil, paidIn: String? = nil) {
        self.provider = provider
        self.id = id
        self.status = status
        self.failure = failure
        self.asset = asset
        self.units = units
        self.wallet = wallet
        self.network = network
        self.txHash = txHash
        self.blockNum = blockNum
        self.cost = cost
        self.costUsdMicros = costUsdMicros
        self.paidIn = paidIn
    }

    /// What goes in the book. Nil until it's delivered and says all of this, because a cost is never made up from part of it.
    public var purchase: Purchase? {
        guard status == .succeeded, let asset, let units, let wallet, let txHash else { return nil }
        guard let paid = cost ?? costUsdMicros.map({ Money(micros: $0, currency: .USD) }) else { return nil }
        return Purchase(provider: provider, order: id, wallet: wallet, asset: asset, units: units, txHash: txHash, blockNum: blockNum, cost: paid, costUsdMicros: costUsdMicros)
    }
}

/// A purchase someone started from this device. It's kept, so one still going is picked up after a restart.
public struct TrackedPurchase: Codable, Sendable, Equatable, Identifiable {
    public let ref: String
    public let wallet: String
    public let asset: String
    public let dollars: Int
    /// What was typed, when that wasn't USD. Without it, `dollars` is what was typed. It's a past amount, so it never goes through today's rate.
    public let typed: Money?
    public let startedAt: Date
    public var order: OnrampOrder?

    public var id: String { ref }

    public init(ref: String, wallet: String, asset: String, dollars: Int, typed: Money? = nil, startedAt: Date, order: OnrampOrder? = nil) {
        self.ref = ref
        self.wallet = wallet
        self.asset = asset
        self.dollars = dollars
        self.typed = typed
        self.startedAt = startedAt
        self.order = order
    }
}

/// Where a purchase has got to, as simply as it can be said.
public enum PurchasePhase: Equatable, Sendable {
    /// The page is open, and there's no order yet.
    case onProvidersPage
    case onItsWay
    /// Delivered, and not seen on the chain yet. Its cost is known, and waits for that.
    case arriving
    case recorded(Money)
    /// What arrived isn't exactly what the order says, or nothing ever did. Its cost stays unknown.
    case costUnknown
    /// The order doesn't say what was paid for it, as when it was paid from crypto already held. Its cost stays unknown.
    case costNotSaid
    /// It was paid in a currency there's no rate for. Its cost stays unknown.
    case noRateFor(String)
    case failed(OnrampOrder.Failure)
    /// There's been a long time with no order. Someone could still have paid, so it's asked about whenever the app starts or comes back.
    case noOrderYet

    public var isFinished: Bool {
        switch self {
        case .onProvidersPage, .noOrderYet, .onItsWay, .arriving: false
        case .recorded, .costUnknown, .costNotSaid, .noRateFor, .failed: true
        }
    }

    /// Nothing says they've paid, so only they can say they won't.
    public var isUpToThem: Bool { self == .onProvidersPage || self == .noOrderYet }
}

public enum PurchaseWording {
    /// The one thing the flow says about who the provider is, along with where its page is.
    public static let provider = "Coinbase"
    static let providerHosts: Set<String> = ["pay.coinbase.com"]

    /// What the order says once it says, because the amount can be changed on the page. Until then, what was chosen.
    public static func title(_ purchase: TrackedPurchase, beside main: CurrencyCode) -> String {
        if let units = purchase.order?.units, let asset = purchase.order?.asset, let decimals = ["ETH": 18, "USDC": 6][asset] {
            return "\(Format.amount(units, decimals: decimals)) \(asset)"
        }
        let typed = purchase.typed ?? Money(micros: String(UInt128(max(purchase.dollars, 0)) * 1_000_000), currency: .USD)
        // Whole, as it was typed.
        let chosen = Format.money(typed, beside: main).replacing(".00", with: "")
        return "\(chosen) of \(purchase.order?.asset ?? purchase.asset)"
    }

    /// What the amount in the sheet will do once it's on the provider's page, so what it charges is no surprise.
    public static func checkoutNote(_ display: MoneyDisplay) -> String {
        let account = "You'll need a \(provider) account."
        if display.isConverted {
            return "\(account) Its page starts at this amount in \(display.currency.rawValue) and shows its fees before you pay. What it charges, fees included, becomes the cost here."
        }
        if display.main != .USD {
            return "There's no current USD to \(display.main.rawValue) rate, so this is in US dollars, and \(provider)'s page works out its own price in your currency. \(account) What it charges, fees included, becomes the cost here."
        }
        return "\(account) Its fees are added, and that total becomes the cost here."
    }

    public static func status(_ phase: PurchasePhase, beside main: CurrencyCode) -> String {
        switch phase {
        case .onProvidersPage: "Waiting for you on \(provider)"
        case .onItsWay: "On its way"
        case .arriving: "Delivered. Waiting to see it arrive"
        case .recorded(let cost): "Cost \(Format.money(cost, beside: main)), fees included"
        case .costUnknown: "Cost unknown. The order didn't match what arrived"
        case .costNotSaid: "Cost unknown. The order doesn't say what you paid for it"
        case .noRateFor(let currency): "Cost unknown. There's no exchange rate for \(currency)"
        case .failed(.payment): "\(provider) couldn't take the payment"
        case .failed(.delivery): "\(provider) couldn't deliver it"
        case .noOrderYet: "No order from \(provider) yet"
        }
    }

    public static func isWarning(_ phase: PurchasePhase) -> Bool {
        switch phase {
        case .costUnknown, .costNotSaid, .noRateFor, .failed: true
        default: false
        }
    }
}

@MainActor
@Observable
public final class PurchaseTracker {
    public private(set) var purchases: [TrackedPurchase]
    /// Why orders can't be checked right now. They're tried again, and nothing's lost.
    public private(set) var problem: String?

    @ObservationIgnored private let store: PortfolioStore
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let pollDelay: Duration
    @ObservationIgnored private let matchOf: @MainActor (String) -> PurchaseMatch.State?
    @ObservationIgnored private var polling: Task<Void, Never>?

    /// How long something unresolved is polled for. After that it's read when the app starts or comes back, so it's never given up on.
    private static let followedFor: TimeInterval = 2 * 60 * 60
    private static let shownFinished = 5
    private static let key = "purchases"

    public init(
        store: PortfolioStore,
        defaults: UserDefaults = .standard,
        now: @escaping @Sendable () -> Date = { .now },
        pollDelay: Duration = .seconds(10),
        matchOf: (@MainActor (String) -> PurchaseMatch.State?)? = nil
    ) {
        self.store = store
        self.defaults = defaults
        self.now = now
        self.pollDelay = pollDelay
        self.matchOf = matchOf ?? { order in store.portfolio?.purchases?.first { $0.order == order }?.state }
        purchases = defaults.data(forKey: Self.key).flatMap { try? JSONDecoder().decode([TrackedPurchase].self, from: $0) } ?? []
    }

    /// What to say when a purchase couldn't start.
    public static func message(for error: any Error) -> String { failureMessage(for: error) }

    public func purchases(of wallet: String) -> [TrackedPurchase] {
        purchases.filter { $0.wallet == wallet.lowercased() }.reversed()
    }

    public func phase(of purchase: TrackedPurchase) -> PurchasePhase {
        guard let order = purchase.order else {
            return now().timeIntervalSince(purchase.startedAt) > Self.followedFor ? .noOrderYet : .onProvidersPage
        }
        switch order.status {
        case .failed: return .failed(order.failure ?? .payment)
        case .pending: return .onItsWay
        case .succeeded:
            if order.txHash == nil { return .onItsWay }
            guard let recorded = order.purchase else { return order.paidIn.map(PurchasePhase.noRateFor) ?? .costNotSaid }
            switch matchOf(order.id) {
            case .recorded: return .recorded(recorded.cost)
            case .unmatched: return .costUnknown
            // Its hash hasn't led to a block in all this time. It's still asked about, and a block would change this.
            case .waiting, nil: return order.blockNum == nil && now().timeIntervalSince(purchase.startedAt) > Self.followedFor ? .costUnknown : .arriving
            }
        }
    }

    /// Asks the server for a page, and starts following it. Throws when there's no page to open, with something to say about why.
    public func begin(wallet: String, asset: String, dollars: Int, cryptoAmount: String, typed: Money? = nil) async throws -> URL {
        let checkout = try await store.currentSource.onrampCheckout(address: wallet, asset: asset, cryptoAmount: cryptoAmount, fiat: typed)
        guard let page = checkout.page else { throw FetchError.rejected("The server sent a page that isn't \(PurchaseWording.provider)'s.") }
        purchases.append(TrackedPurchase(ref: checkout.ref, wallet: wallet.lowercased(), asset: asset, dollars: dollars, typed: typed, startedAt: now()))
        save()
        start()
        return page
    }

    /// Reads everything unresolved, however old, and keeps polling what's recent. Here and not in a view, because a delivery gets its cost whether or not a window's open.
    public func start() {
        guard polling == nil, purchases.contains(where: { !isResolved($0) }) else { return }
        polling = Task { [weak self] in
            while let self, !Task.isCancelled {
                await self.check()
                guard self.purchases.contains(where: self.isFollowed) else { break }
                try? await Task.sleep(for: self.pollDelay)
            }
            self?.polling = nil
        }
    }

    /// Reads every unresolved order. A failed read changes nothing, so a purchase can't get lost, and it's tried again.
    public func check() async {
        var failure: String?
        for purchase in purchases where !isResolved(purchase) {
            do {
                let orders = try await store.currentSource.onrampOrders(ref: purchase.ref)
                failure = nil
                guard let order = orders.first, let index = purchases.firstIndex(where: { $0.ref == purchase.ref }) else { continue }
                if purchases[index].order != order {
                    purchases[index].order = order
                    save()
                }
                if let recorded = order.purchase { store.recordPurchase(recorded) }
            } catch is CancellationError {
                return
            } catch {
                failure = failureMessage(for: error)
            }
        }
        problem = failure
        trim()
    }

    /// Someone who's left the page without paying says so. It's kept going if an order has already started.
    public func dismiss(_ purchase: TrackedPurchase) {
        purchases.removeAll { $0.ref == purchase.ref }
        save()
    }

    /// Whether there's nothing more to learn about it. How long it's been never settles this: an order can appear after any wait, and so can a delivery's block.
    private func isResolved(_ purchase: TrackedPurchase) -> Bool {
        guard let order = purchase.order else { return false }
        switch order.status {
        case .failed: return true
        case .pending: return false
        case .succeeded: return order.txHash != nil && order.blockNum != nil
        }
    }

    private func isFollowed(_ purchase: TrackedPurchase) -> Bool {
        !isResolved(purchase) && now().timeIntervalSince(purchase.startedAt) <= Self.followedFor
    }

    /// What's finished only matters for a while, and what's still going stays however long this gets.
    private func trim() {
        let finished = purchases.filter(isResolved)
        guard finished.count > Self.shownFinished else { return }
        let dropped = Set(finished.dropLast(Self.shownFinished).map(\.ref))
        purchases.removeAll { dropped.contains($0.ref) }
        save()
    }

    private func save() {
        defaults.set(try? JSONEncoder().encode(purchases), forKey: Self.key)
    }
}
