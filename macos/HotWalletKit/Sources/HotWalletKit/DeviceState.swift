import Foundation
import KeyVault

/// What's become of what was just signed, from its receipts. Nothing counts as landed until every one of them says so, and it's only ever read here.
public enum Landing: Equatable, Sendable {
    case onItsWay, landed, didntLand

    public init(_ records: [SignedRecord]) {
        if records.contains(where: { $0.status == .failed || $0.status == .dropped }) {
            self = .didntLand
        } else if records.isEmpty || records.contains(where: { $0.status == .pending }) {
            self = .onItsWay
        } else {
            self = .landed
        }
    }
}

/// A transaction this device signed. It's written down before it's broadcast, so nothing the app sent can ever look like a thief's.
public struct SignedRecord: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending, confirmed, failed
        /// It never made it into a block, so its nonce is free again.
        case dropped
    }

    public enum Reason: String, Codable, Sendable {
        case aboveCap, manual, rotation
        /// A site asked, and the user approved it in this app.
        case site
        /// The user sent it to someone, or to another wallet of theirs.
        case sent
        /// A cost the user published. `symbol` is the token it's about, and nothing moved.
        case note
        /// Approvals taken back. `to` is who could spend, `symbol` what they could spend, and nothing moved.
        case revoke
        /// What a purchase brought to its one-use key, on its way to savings. See `OneUseKey`.
        case purchase
        /// ETH from Spending Money to a one-use key, for the fee to move a purchase that came without any.
        case purchaseGas
    }

    public let hash: String
    public let nonce: UInt64
    public let to: EthereumAddress
    public let symbol: String
    public let decimals: Int
    public let amount: String
    public let usdMicros: String?
    public let gainUsdMicros: String
    public let reason: Reason
    public var createdAt: Date
    public var status: Status
    /// The site that asked for it, when `reason` is `.site`.
    public var site: String?

    public var id: String { hash }

    public init(hash: String, nonce: UInt64, to: EthereumAddress, symbol: String, decimals: Int, amount: String, usdMicros: String?, gainUsdMicros: String, reason: Reason, createdAt: Date, status: Status, site: String? = nil) {
        self.hash = hash
        self.nonce = nonce
        self.to = to
        self.symbol = symbol
        self.decimals = decimals
        self.amount = amount
        self.usdMicros = usdMicros
        self.gainUsdMicros = gainUsdMicros
        self.reason = reason
        self.createdAt = createdAt
        self.status = status
        self.site = site
    }
}

public struct StolenKeyAlarm: Codable, Equatable, Sendable {
    public enum Finding: Codable, Equatable, Hashable, Sendable {
        /// Amp saw this wallet spend in a transaction this app has no record of.
        case unknownTransaction(hash: String)
        /// The chain counts more transactions from this key than this app signed.
        case nonceAhead(signed: UInt64, onchain: UInt64)
        /// Something else used a nonce this app signed for.
        case nonceTaken(nonce: UInt64, ours: String)
        /// A key made for one purchase sent something this app didn't sign. Nothing but this Mac ever had that key.
        case oneUseKeySpent(address: EthereumAddress)

        var isNonceCount: Bool {
            if case .nonceAhead = self { true } else { false }
        }
    }

    public var address: EthereumAddress
    public var findings: [Finding]
    public var raisedAt: Date
}

public struct Rotation: Codable, Equatable, Sendable {
    public let from: EthereumAddress
    public let to: EthereumAddress
    /// Where what's left goes. After an alarm, that's savings rather than the new key, if there's a cold wallet.
    public let destination: EthereumAddress

    public init(from: EthereumAddress, to: EthereumAddress, destination: EthereumAddress) {
        self.from = from
        self.to = to
        self.destination = destination
    }
}

/// A key made for one large purchase, so it arrives where no site has ever been approved and no old copy of a key can reach.
/// What lands moves on to savings, and once the key's empty it's retired like a replaced one. Until then it stays in the vault,
/// however long that takes, and whatever happens to Spending Money.
public struct OneUseKey: Codable, Equatable, Sendable {
    public let address: EthereumAddress
    /// Savings when it was made, for when there's none set by the time it moves.
    public let destination: EthereumAddress
    public let createdAt: Date
    /// Like `DeviceWalletState.settledThroughBlock`, for this key's own transactions.
    public var settledThroughBlock: UInt64?
    /// How many times Spending Money has sent it ETH for a fee. Capped, so nothing can drain Spending Money a little at a time.
    public var gasSends: Int
    /// What its purchase's order says. Nil in older records, which counts as `.expected`, so nothing's deleted on a guess.
    public var delivery: Delivery?

    /// Whether the purchase it was made for can still bring something. Only the order can say it can't, so an empty key, or one that's
    /// sent something, still waits for that. Anything else could arrive at an address that has no key anymore.
    public enum Delivery: Codable, Equatable, Sendable {
        /// Made, and its address may not have reached the provider. Nobody's been shown a page to pay on, so it waits a while, then goes.
        case notStarted
        /// The provider has its address, and there's no order yet. Someone saying they didn't buy it takes this back to `notStarted`.
        case expected
        /// There's an order, and it hasn't said it's done. Only the order can let this go: hiding its row doesn't, since a delivery's
        /// block can be unknown when it's hidden.
        case ordered
        /// Delivered in this block. Once a read reaches it, and the key's empty, there's nothing more coming.
        case delivered(block: UInt64)
        /// The order failed, so nothing's coming.
        case failed
    }

    public init(address: EthereumAddress, destination: EthereumAddress, createdAt: Date, settledThroughBlock: UInt64? = nil, gasSends: Int = 0, delivery: Delivery? = .notStarted) {
        self.address = address
        self.destination = destination
        self.createdAt = createdAt
        self.settledThroughBlock = settledThroughBlock
        self.gasSends = gasSends
        self.delivery = delivery
    }
}

/// What only this device can know. Unlike settings, this never syncs, because each device has its own key and history.
public struct DeviceWalletState: Codable, Equatable, Sendable {
    public var active: EthereumAddress?
    /// Earlier keys on this device, which count as linked so a rotation's cost carries over.
    public var retired: [EthereumAddress] = []
    public var records: [EthereumAddress: [SignedRecord]] = [:]
    /// Realized gains already on their way to savings, by wallet, in micros.
    public var sweptGains: [EthereumAddress: String] = [:]
    public var alarm: StolenKeyAlarm?
    /// What the user has looked at and said was fine.
    public var acknowledged: [StolenKeyAlarm.Finding] = []
    /// Nonces below this have been looked at and said to be fine, so they're no longer a gap.
    public var acknowledgedThroughNonce: UInt64?
    public var rotation: Rotation?
    /// The newest block a settled transaction of this key's is in. A read from before it still counts what that transaction moved,
    /// so nothing signs from one, including right after a restart.
    public var settledThroughBlock: UInt64?
    /// The sites the user let see this key's address, by origin. Optional because older records don't have it.
    public var connectedSites: [String]?
    /// Permits each key signed for sites that may still be used. Optional because older records don't have it.
    public var signedPermits: [EthereumAddress: [SignedPermit]]?
    /// One-use keys still in use. Optional because older records don't have it.
    public var oneUseKeys: [OneUseKey]?
    /// Every one-use key this device has made, the retired ones included, so their purchases stay findable. Optional because older records don't have it.
    public var purchaseKeys: [EthereumAddress]?

    public init() {}
}

/// The real failure can name a local file, so nothing past here gets to repeat it.
struct RecordsNotSaved: Error {}

public protocol DeviceStateStore: Sendable {
    func load() throws -> DeviceWalletState
    func save(_ state: DeviceWalletState) throws
}

/// A file, written atomically, since a record has to be safely on disk before its transaction is broadcast.
public struct FileDeviceStateStore: DeviceStateStore {
    private let url: URL

    public init(url: URL? = nil) {
        self.url = url ?? URL.applicationSupportDirectory.appending(path: "HotWallet/device-state.json")
    }

    public func load() throws -> DeviceWalletState {
        guard FileManager.default.fileExists(atPath: url.path) else { return DeviceWalletState() }
        return try JSONDecoder().decode(DeviceWalletState.self, from: Data(contentsOf: url))
    }

    public func save(_ state: DeviceWalletState) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(state).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}
