import Foundation
import KeyVault

/// Where a purchase ends up. It all lands here, and what's above the cap sweeps to savings, or stays here until there's a savings wallet, so this says how much of each, and whether that can work.
public struct BuyPlan: Equatable, Sendable {
    public enum Problem: Equatable, Sendable {
        /// Below what the provider takes for some ways to pay. Its page has the last word.
        case belowMinimum
        /// Not enough ETH to move this token at today's fees, so what's above the cap would be stuck.
        case noGasToSweep
        /// There's no knowing whether it could be moved until the chain's been read.
        case notReadYet
    }

    /// Coinbase's live limits take a card from CA$3, and a new key's trial tier refused $5 at CA$6.99 a transaction, so this has to sit between them. Apple Pay and Google Pay want about $5, and the page says so.
    public static let minimumDollars = 3
    public static let minimumUsdMicros = UInt128(minimumDollars) * Money.dollar

    /// What fits under the cap.
    public let fits: UInt128
    /// What's above it. With a savings wallet it sweeps there. Without one it stays here, over the cap, until there is one, since
    /// the provider's page can raise the amount and nothing here can turn money away.
    public let aboveCap: UInt128
    public let problem: Problem?

    /// Through a one-use key, all of it goes on to savings, and none of it stops in Spending Money. See `OneUseKey`.
    public let isThroughOneUseKey: Bool

    /// Nothing above the room and the minimum is this app's to limit. The provider applies its own limits to the account.
    public init(usdMicros amount: UInt128, token: Token, priceUsdMicros: UInt128?, holdings: [Holding], capUsdMicros: UInt128, roomUsdMicros: UInt128, fees: FeeQuote?, destination: EthereumAddress?, throughOneUseKey: Bool = false) {
        isThroughOneUseKey = throughOneUseKey && destination != nil
        fits = isThroughOneUseKey ? 0 : min(amount, roomUsdMicros)
        aboveCap = isThroughOneUseKey ? amount : amount.subtractingClamped(roomUsdMicros)
        if holdings.isEmpty {
            // Nothing's been read, so there's no room to measure against yet, and no amount to judge.
            problem = .notReadYet
        } else if amount < Self.minimumUsdMicros {
            problem = .belowMinimum
        } else if isThroughOneUseKey {
            // ETH pays for its own move. A token needs some sent from Spending Money, for its move and, to be safe, a second try.
            if token.isNative {
                problem = nil
            } else if let fees {
                let eth = holdings.first { $0.token.isNative }?.balance ?? 0
                problem = eth >= Self.gasForOneUseKey(token, fees: fees) ? nil : .noGasToSweep
            } else {
                problem = .notReadYet
            }
        } else if let fees, let priceUsdMicros, let after = Self.holdings(holdings, buying: amount, of: token, priceUsdMicros: priceUsdMicros) {
            // What a sweep would make of it, whatever the amount: the provider's page can change it, so a token that can't move at all is a problem even if this much would fit.
            // Without a savings wallet nothing sweeps yet, but a token with no ETH beside it can't be moved by anyone, so that's still a problem.
            let sweep = SweepPlanner.automatic(holdings: after, capUsdMicros: capUsdMicros, fees: fees, destination: destination, pendingGainUsdMicros: 0)
            problem = sweep.blockers.contains(.notEnoughGas) ? .noGasToSweep : nil
        } else {
            problem = .notReadYet
        }
    }

    /// What Spending Money needs in ETH so a token bought through a one-use key can move on: what it sends, and the fee to send it.
    static func gasForOneUseKey(_ token: Token, fees: FeeQuote) -> UInt128 {
        2 * fees.costWei(of: token) + fees.costWei(of: Base.eth)
    }

    /// The holdings once this has arrived. A token that isn't held yet isn't among them. Nil with nothing read, or no price to work out how much that is.
    private static func holdings(_ holdings: [Holding], buying amount: UInt128, of token: Token, priceUsdMicros price: UInt128) -> [Holding]? {
        guard !holdings.isEmpty, price > 0 else { return nil }
        let bought = Money.amount(ofUsdMicros: amount, priceMicros: price, decimals: token.decimals)
        let held = holdings.first { $0.token == token }?.balance ?? 0
        return holdings.filter { $0.token != token } + [Holding(token: token, balance: held + bought, priceUsdMicros: price)]
    }

    /// What to ask the provider for: the amount in the token, which a page in any currency can start from. Nil when what's typed isn't an amount to buy, or there's no price to work it out from.
    public static func cryptoAmount(usdMicros: UInt128, isNative: Bool, ethUsdMicros: UInt128?) -> String? {
        guard usdMicros >= minimumUsdMicros else { return nil }
        guard isNative else { return usdMicros % Money.dollar == 0 ? String(usdMicros / Money.dollar) : decimal(usdMicros, decimals: 6, keeping: 2) }
        guard let ethUsdMicros, ethUsdMicros > 0 else { return nil }
        return decimal(Money.amount(ofUsdMicros: usdMicros, priceMicros: ethUsdMicros, decimals: 18), decimals: 18, keeping: 6)
    }

    /// In plain digits for the provider, rounded down, so this never asks for more than was chosen.
    public static func decimal(_ units: UInt128, decimals: Int, keeping: Int) -> String {
        let text = String(units)
        let padded = String(repeating: "0", count: max(0, decimals + 1 - text.count)) + text
        let fraction = padded.suffix(decimals).prefix(keeping)
        return "\(padded.dropLast(decimals)).\(fraction)"
    }
}
