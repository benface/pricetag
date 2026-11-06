import Foundation
import KeyVault

/// Contracts on Base that sites commonly ask this wallet to use, by name. A name only ever goes beside the address, never in place
/// of it, and anything off this list is unknown. Each address is from its project's own published deployments:
/// - Uniswap: https://developers.uniswap.org/contracts/v3/reference/deployments/base-deployments and …/contracts/v4/deployments
/// - Aerodrome: https://github.com/aerodrome-finance/contracts (README, Base deployment)
/// - CoW Swap: https://github.com/cowprotocol/contracts (networks.json, chain 8453)
public enum KnownContracts {
    static let names: [EthereumAddress: String] = [
        EthereumAddress("0x2626664c2603336e57b271c5c0b26f421741e481")!: "Uniswap",
        EthereumAddress("0x6ff5693b99212da76ad316178a184ab56d299b43")!: "Uniswap",
        EthereumAddress("0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7")!: "Uniswap",
        EthereumAddress("0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40")!: "Uniswap",
        Base.permit2: "Uniswap Permit2",
        EthereumAddress("0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43")!: "Aerodrome",
        EthereumAddress("0x9008d19f58aabd9ed0d60971565aa8510560ab41")!: "CoW Swap",
        EthereumAddress("0xc92e8bdf79f0507f65a392b0ab4667716bfe0110")!: "CoW Swap",
    ]

    /// What this app calls a contract, from this list or the token list, or nil if it's unknown.
    public static func name(of address: EthereumAddress) -> String? {
        names[address] ?? Base.tokens.first { $0.contract == address }?.symbol
    }
}
