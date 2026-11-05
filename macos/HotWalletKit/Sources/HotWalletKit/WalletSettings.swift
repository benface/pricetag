import Foundation
import KeyVault

/// A hardware wallet's address, which the user read on the device's own screen before it got here.
public struct ColdWallet: Codable, Equatable, Identifiable, Sendable {
    public let address: EthereumAddress
    public var name: String
    public let confirmedOnDeviceAt: Date

    public var id: EthereumAddress { address }

    public init(address: EthereumAddress, name: String, confirmedOnDeviceAt: Date) {
        self.address = address
        self.name = name
        self.confirmedOnDeviceAt = confirmedOnDeviceAt
    }
}

/// What the user chose, as opposed to what this device holds. It can move to a store that syncs without anything else changing.
public struct WalletSettings: Codable, Equatable, Sendable {
    public static let suggestedCap: UInt128 = 50 * Money.dollar
    /// This build hasn't been reviewed.
    public static let capCeiling: UInt128 = 100 * Money.dollar
    /// Lower without a cold wallet, since the hot wallet is then all they have.
    public static let capCeilingWithoutCold: UInt128 = 25 * Money.dollar

    /// As a string in storage, since JSON has no 128-bit number. It's always under the ceiling, so it fits in anything.
    private var capDollars: Int
    public private(set) var coldWallets: [ColdWallet]
    public private(set) var sweepDestination: EthereumAddress?
    public var sweepsRealizedGains: Bool
    public var rpcURL: URL

    public init() {
        capDollars = Int(Self.suggestedCap / Money.dollar)
        coldWallets = []
        sweepDestination = nil
        sweepsRealizedGains = true
        rpcURL = Base.publicRPC
    }

    public var capCeiling: UInt128 { coldWallets.isEmpty ? Self.capCeilingWithoutCold : Self.capCeiling }

    public var capUsdMicros: UInt128 {
        min(UInt128(max(capDollars, 1)) * Money.dollar, capCeiling)
    }

    public var capInDollars: Int { Int(capUsdMicros / Money.dollar) }

    public mutating func setCap(dollars: Int) {
        capDollars = min(max(dollars, 1), Int(Self.capCeiling / Money.dollar))
    }

    public mutating func add(_ wallet: ColdWallet) {
        guard !coldWallets.contains(where: { $0.address == wallet.address }) else { return }
        coldWallets.append(wallet)
        if sweepDestination == nil { sweepDestination = wallet.address }
    }

    public mutating func removeColdWallet(_ address: EthereumAddress) {
        coldWallets.removeAll { $0.address == address }
        if sweepDestination == address { sweepDestination = coldWallets.first?.address }
    }

    public mutating func renameColdWallet(_ address: EthereumAddress, to name: String) {
        guard let index = coldWallets.firstIndex(where: { $0.address == address }) else { return }
        coldWallets[index].name = name
    }

    public mutating func setSweepDestination(_ address: EthereumAddress) {
        guard coldWallets.contains(where: { $0.address == address }) else { return }
        sweepDestination = address
    }
}

public protocol WalletSettingsStore: Sendable {
    func load() -> WalletSettings
    func save(_ settings: WalletSettings)
}

public final class UserDefaultsWalletSettingsStore: WalletSettingsStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key = "hotWallet.settings"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> WalletSettings {
        defaults.data(forKey: key).flatMap { try? JSONDecoder().decode(WalletSettings.self, from: $0) } ?? WalletSettings()
    }

    public func save(_ settings: WalletSettings) {
        defaults.set(try? JSONEncoder().encode(settings), forKey: key)
    }
}
