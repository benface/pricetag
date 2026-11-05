import Foundation

/// A wallet the user has looked at, kept in the settings. It's an address and a name, so it holds nothing that could sign.
public struct SavedWallet: Codable, Equatable, Sendable {
    public let address: String
    public var name: String?
    public var lastSeen: Date
    /// Stays under Watching without a name, because the user put it there. Optional, or wallets saved before this existed wouldn't read.
    public var isKept: Bool?

    public init(address: String, name: String? = nil, lastSeen: Date, isKept: Bool? = nil) {
        self.address = address
        self.name = name
        self.lastSeen = lastSeen
        self.isKept = isKept
    }

    /// Unnamed wallets beyond this many fall off. Naming one keeps it, and so does keeping it.
    static let recentLimit = 5

    /// Adds or refreshes one, and drops the oldest unnamed ones past the limit. Wallets in `own` are listed anyway, so they don't count.
    static func seeing(_ address: String, at date: Date, in saved: [SavedWallet], own: [String]) -> [SavedWallet] {
        var next = saved
        if let index = next.firstIndex(where: { $0.address == address }) {
            next[index].lastSeen = date
        } else {
            next.append(SavedWallet(address: address, lastSeen: date))
        }
        let dropped = next.filter { !$0.isListedForGood && !own.contains($0.address) }
            .sorted { $0.lastSeen > $1.lastSeen }
            .dropFirst(recentLimit)
            .map(\.address)
        return next.filter { !dropped.contains($0.address) }
    }

    var isListedForGood: Bool { name != nil || isKept == true }
}

/// A wallet with a name it can't lose, like spending money or a savings wallet.
public struct NamedWallet: Equatable, Sendable {
    public let address: String
    public let name: String

    public init(address: String, name: String) {
        self.address = address.lowercased()
        self.name = name
    }
}

/// What the user can do with a wallet here, which is what they most need to know about what they're looking at.
public enum WalletKind: Equatable, Sendable {
    case spendingMoney, savings, yours, watching, demo

    public var isOwn: Bool {
        switch self {
        case .spendingMoney, .savings, .yours: true
        case .watching, .demo: false
        }
    }

    public var label: String {
        switch self {
        case .spendingMoney: "Spending Money"
        case .savings: "Savings"
        case .yours: "Yours"
        case .watching: "Watching"
        case .demo: "Sample data"
        }
    }
}

public struct WalletEntry: Identifiable, Equatable, Sendable {
    public let address: String
    public let name: String?
    public let kind: WalletKind
    /// A spending key that's been replaced. It's the user's whatever anyone says, and costs keep following its money.
    public var isReplacedKey = false
    /// Under Recent, so it falls off the list by itself unless it's kept.
    public var isRecent = false

    public init(address: String, name: String?, kind: WalletKind, isReplacedKey: Bool = false, isRecent: Bool = false) {
        self.address = address
        self.name = name
        self.kind = kind
        self.isReplacedKey = isReplacedKey
        self.isRecent = isRecent
    }

    public var id: String { address }

    public var shortAddress: String? {
        kind == .demo ? nil : Format.shortHash(address)
    }

    public var title: String {
        name ?? (kind == .demo ? "Demo Wallet" : Format.shortHash(address))
    }

    private var kindLabel: String { isReplacedKey ? "Replaced Key" : kind.label }

    /// What the title doesn't already say. Nothing for the demo wallet, which has its own notice.
    public var badge: String? {
        kind == .demo || kindLabel == title ? nil : kindLabel
    }

    /// The row's second line: what kind it is and its address, leaving out whichever the title or section already says.
    public var detail: String {
        let isUnderWatching = kind == .watching && name != nil
        let kindText = kindLabel == title || isUnderWatching ? nil : kindLabel
        let addressText = shortAddress == title ? nil : shortAddress
        return [kindText, addressText].compactMap(\.self).joined(separator: " · ")
    }

    public var canRename: Bool { kind != .spendingMoney && kind != .demo }
    /// Spending money holds a key and a savings wallet takes sweeps, so neither is only an entry in a list.
    public var canRemove: Bool { kind == .yours || kind == .watching }
    public var canMoveToYours: Bool { kind == .watching }
    public var canMoveToWatching: Bool { kind == .yours && !isReplacedKey }
    public var canKeep: Bool { isRecent }
    public var canStopBeingSavings: Bool { kind == .savings }
}

/// Every wallet the switcher offers, in the order it offers them. Each address appears once, as the most it is to the user.
public struct WalletList: Equatable, Sendable {
    public let yours: [WalletEntry]
    public let watching: [WalletEntry]
    public let recent: [WalletEntry]
    /// Only where it's offered, or while it's the one showing.
    public let demo: WalletEntry?

    /// `linked` is every wallet the user has said is theirs, which includes the spending money and savings ones.
    /// `replacedKeys` is the ones among them this Mac's wallet used to spend from. `order` is how the user arranged them, and `hidden` is what they took
    /// off the list that stays theirs anyway, until they look at it again.
    public init(spending: NamedWallet?, savings: [NamedWallet], linked: [String], replacedKeys: [String] = [], saved: [SavedWallet], current: String?, offersDemo: Bool = true, order: [String] = [], hidden: [String] = []) {
        let savedNames = Dictionary(saved.compactMap { wallet in wallet.name.map { (wallet.address, $0) } }, uniquingKeysWith: { first, _ in first })
        var yours = spending.map { [WalletEntry(address: $0.address, name: $0.name, kind: .spendingMoney)] } ?? []
        yours += savings.filter { $0.address != spending?.address }.map { WalletEntry(address: $0.address, name: $0.name, kind: .savings) }
        let named = Set(yours.map(\.address))
        yours += linked.filter { !named.contains($0) && ($0 == current || !hidden.contains($0)) }.map { WalletEntry(address: $0, name: savedNames[$0], kind: .yours, isReplacedKey: replacedKeys.contains($0)) }
        self.yours = Self.arranged(yours, by: order)

        let own = Set(linked + yours.map(\.address))
        let others = saved.filter { !own.contains($0.address) && $0.address != WalletAddress.demo }
        // Listed for good, they keep their place, so they're where the hand expects. Recent ones move, because that's what recent means.
        let listed = others.filter(\.isListedForGood)
            .sorted { ($0.name ?? $0.address).localizedStandardCompare($1.name ?? $1.address) == .orderedAscending }
            .map { WalletEntry(address: $0.address, name: $0.name, kind: .watching) }
        watching = Self.arranged(listed, by: order)
        var recent = others.filter { !$0.isListedForGood }
            .sorted { $0.lastSeen > $1.lastSeen }
            .prefix(SavedWallet.recentLimit)
            .map { WalletEntry(address: $0.address, name: nil, kind: .watching, isRecent: true) }
        if let current, current != WalletAddress.demo, !own.contains(current), !others.contains(where: { $0.address == current }) {
            recent.insert(WalletEntry(address: current, name: nil, kind: .watching, isRecent: true), at: 0)
        }
        self.recent = recent
        demo = offersDemo || current == WalletAddress.demo ? WalletEntry(address: WalletAddress.demo, name: nil, kind: .demo) : nil
    }

    public var all: [WalletEntry] { yours + watching + recent + (demo.map { [$0] } ?? []) }

    public func entry(for address: String?) -> WalletEntry? {
        address.flatMap { address in all.first { $0.address == address } }
    }

    /// What to show once this one is gone. Never the demo, which must not quietly stand in for a real wallet.
    public func next(afterRemoving address: String) -> String? {
        (yours + watching + recent).first { $0.address != address }?.address
    }

    /// What the user arranged comes first, in that order. Whatever they haven't placed yet follows, as it would have been.
    private static func arranged(_ entries: [WalletEntry], by order: [String]) -> [WalletEntry] {
        let placed = order.compactMap { address in entries.first { $0.address == address } }
        return placed + entries.filter { !order.contains($0.address) }
    }
}
