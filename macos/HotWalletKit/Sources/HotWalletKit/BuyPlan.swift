import Foundation
import KeyVault

/// Where a purchase ends up. It all lands here, and what's above the cap sweeps to savings, so this says how much of each, and whether that can work.
public struct BuyPlan: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        /// Below what the provider takes for some ways to pay. Its page has the last word.
        case belowMinimum
        /// No savings wallet. The provider's page can raise the amount, so nothing can keep a purchase to the room, and what's above it would have nowhere to go.
        case needsSavings
        /// Not enough ETH to move this token at today's fees, so what's above the cap would be stuck.
        case noGasToSweep
        /// There's no knowing whether it could be moved until the chain's been read.
        case notReadYet
    }

    /// Coinbase's live limits take a card from CA$3, and a new key's trial tier refused $5 at CA$6.99 a transaction, so this has to sit between them. Apple Pay and Google Pay want about $5, and the page says so.
    public static let minimumDollars = 3

    public let stays: UInt128
    public let sweeps: UInt128
    public let problem: Problem?

    /// Nothing above the room and the minimum is this app's to limit. The provider applies its own limits to the account.
    public init(dollars: Int, token: Token, priceUsdMicros: UInt128?, holdings: [Holding], capUsdMicros: UInt128, roomUsdMicros: UInt128, fees: FeeQuote?, destination: EthereumAddress?) {
        let amount = UInt128(max(dollars, 0)) * Money.dollar
        stays = min(amount, roomUsdMicros)
        sweeps = amount.subtractingClamped(roomUsdMicros)
        if destination == nil {
            problem = .needsSavings
        } else if dollars < Self.minimumDollars {
            problem = .belowMinimum
        } else if let fees, let priceUsdMicros, let after = Self.holdings(holdings, buying: amount, of: token, priceUsdMicros: priceUsdMicros) {
            // What a sweep would make of it, whatever the amount: the provider's page can change it, so a token that can't move at all is a problem even if this much would fit.
            let sweep = SweepPlanner.automatic(holdings: after, capUsdMicros: capUsdMicros, fees: fees, destination: destination, pendingGainUsdMicros: 0)
            problem = sweep.blockers.contains(.notEnoughGas) ? .noGasToSweep : nil
        } else {
            problem = .notReadYet
        }
    }

    /// The holdings once this has arrived. A token that isn't held yet isn't among them. Nil with nothing read, or no price to work out how much that is.
    private static func holdings(_ holdings: [Holding], buying amount: UInt128, of token: Token, priceUsdMicros price: UInt128) -> [Holding]? {
        guard !holdings.isEmpty, price > 0 else { return nil }
        let bought = Money.amount(ofUsdMicros: amount, priceMicros: price, decimals: token.decimals)
        let held = holdings.first { $0.token == token }?.balance ?? 0
        return holdings.filter { $0.token != token } + [Holding(token: token, balance: held + bought, priceUsdMicros: price)]
    }

    /// What to ask the provider for: the amount in the token, which a page in any currency can start from. Nil when what's typed isn't an amount to buy, or there's no price to work it out from.
    public static func cryptoAmount(dollars: Int, isNative: Bool, ethUsdMicros: UInt128?) -> String? {
        guard dollars >= minimumDollars else { return nil }
        guard isNative else { return String(dollars) }
        guard let ethUsdMicros, ethUsdMicros > 0 else { return nil }
        return decimal(Money.amount(ofUsdMicros: UInt128(dollars) * Money.dollar, priceMicros: ethUsdMicros, decimals: 18), decimals: 18, keeping: 6)
    }

    /// In plain digits for the provider, rounded down, so this never asks for more than was chosen.
    public static func decimal(_ units: UInt128, decimals: Int, keeping: Int) -> String {
        let text = String(units)
        let padded = String(repeating: "0", count: max(0, decimals + 1 - text.count)) + text
        let fraction = padded.suffix(decimals).prefix(keeping)
        return "\(padded.dropLast(decimals)).\(fraction)"
    }
}
