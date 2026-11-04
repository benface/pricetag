import Foundation
import KeyVault

/// A transaction this device signed. It's written down before it's broadcast, so nothing the app sent can ever look like a thief's.
public struct SignedRecord: Codable, Equatable, Identifiable, Sendable {
    public enum Status: String, Codable, Sendable {
        case pending, confirmed, failed
        /// It never made it into a block, so its nonce is free again.
        case dropped
    }

    public enum Reason: String, Codable, Sendable {
        case aboveCap, manual, rotation
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

    public var id: String { hash }

    public init(hash: String, nonce: UInt64, to: EthereumAddress, symbol: String, decimals: Int, amount: String, usdMicros: String?, gainUsdMicros: String, reason: Reason, createdAt: Date, status: Status) {
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

    public init() {}
}

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
