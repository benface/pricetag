import Foundation
import KeyVault
import PricetagKit

/// A token this wallet is willing to touch. It's `src/core/tokens.ts`, and a test compares the two.
public struct Token: Hashable, Sendable, Identifiable {
    /// nil for native ETH, which has no contract.
    public let contract: EthereumAddress?
    public let symbol: String
    public let decimals: Int
    /// The position it counts toward in the portfolio, and the price it takes from there.
    public let asset: String

    public var id: String { symbol }
    public var isNative: Bool { contract == nil }
    public var isStablecoin: Bool { ["USDC", "USDT", "DAI"].contains(symbol) }
}

public enum Base {
    /// Goes into every signature, so nothing signed here can be replayed on another chain.
    public static let chainID: UInt64 = 8453
    public static let publicRPC = URL(string: "https://mainnet.base.org")!
    public static let eth = Token(contract: nil, symbol: "ETH", decimals: 18, asset: "ETH")
    /// Uniswap's, at the same address on every chain. Revoking only ever calls its `lockdown`.
    public static let permit2 = EthereumAddress("0x000000000022D473030F116dDEE9F6B43aC78BA3")!

    /// Nothing else is ever called. Unknown tokens can be malicious, and a transaction to one could do anything.
    public static let tokens: [Token] = [
        eth,
        token("0x4200000000000000000000000000000000000006", "WETH", 18, asset: "ETH"),
        token("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "USDC", 6),
        token("0xfde4c96c8593536e31f229ea8f37b2ada2699bb2", "USDT", 6),
        token("0x50c5725949a6f0c72e6c4a641f24049a917db0cb", "DAI", 18),
        token("0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22", "cbETH", 18),
        token("0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452", "wstETH", 18),
        token("0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "cbBTC", 8),
        token("0x940181a94a35a4569e4529a3cdfb74e38fd98631", "AERO", 18),
        token("0x0b3e328455c4059eeb9e3f84b5543f74e24e7e1b", "VIRTUAL", 18),
        token("0x4ed4e862860bed51a9570b96d89af5e1b0efefed", "DEGEN", 18),
    ]

    public static let ethUsdFeed = EthereumAddress("0x71041dddad3595f9ced3dccfbe3d1f4b0a16bb70")!
    public static let usdcUsdFeed = EthereumAddress("0x7e860098f58bbfc8648a4311b374b1d669a2bc6b")!
    /// The OP Stack predeploy that works out a transaction's L1 data fee, which is charged on top of its gas.
    public static let gasPriceOracle = EthereumAddress("0x420000000000000000000000000000000000000f")!

    private static func token(_ address: String, _ symbol: String, _ decimals: Int, asset: String? = nil) -> Token {
        Token(contract: EthereumAddress(address)!, symbol: symbol, decimals: decimals, asset: asset ?? symbol)
    }
}

/// USD in millionths, as everywhere else in the app, and token amounts in their smallest unit.
public enum Money {
    public static let dollar: UInt128 = 1_000_000

    private static func powerOfTen(_ exponent: Int) -> UInt128 {
        (0..<exponent).reduce(1) { value, _ in value * 10 }
    }

    /// a × b ÷ c, through 256 bits. Saturates rather than trapping, which only something absurd could reach.
    private static func scale(_ a: UInt128, by b: UInt128, over c: UInt128) -> UInt128 {
        guard c > 0 else { return 0 }
        let product = a.multipliedFullWidth(by: b)
        guard product.high < c else { return .max }
        return c.dividingFullWidth(product).quotient
    }

    public static func usdMicros(of amount: UInt128, priceMicros: UInt128, decimals: Int) -> UInt128 {
        scale(amount, by: priceMicros, over: powerOfTen(decimals))
    }

    public static func amount(ofUsdMicros usd: UInt128, priceMicros: UInt128, decimals: Int) -> UInt128 {
        scale(usd, by: powerOfTen(decimals), over: priceMicros)
    }

    /// An amount as typed. nil when it isn't one, including when it's finer than the token can hold, because rounding someone's money isn't this app's call.
    public static func units(fromText text: String, decimals: Int) -> UInt128? {
        guard let clean = Format.plainAmount(text), clean.wholeMatch(of: /\d+(\.\d*)?|\.\d+/) != nil else { return nil }
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        let whole = parts.first.map(String.init) ?? ""
        let fraction = parts.count > 1 ? String(parts[1]) : ""
        guard fraction.count <= decimals else { return nil }
        let digits = whole + fraction + String(repeating: "0", count: decimals - fraction.count)
        return UInt128(digits.isEmpty ? "0" : digits)
    }

    /// The shortest text `units(fromText:decimals:)` reads back as exactly this.
    public static func text(ofUnits units: UInt128, decimals: Int) -> String {
        let digits = String(units)
        guard decimals > 0 else { return digits }
        let padded = String(repeating: "0", count: max(0, decimals + 1 - digits.count)) + digits
        var fraction = String(padded.suffix(decimals))
        while fraction.last == "0" { fraction.removeLast() }
        return String(padded.dropLast(decimals)) + (fraction.isEmpty ? "" : "." + fraction)
    }
}
