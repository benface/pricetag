import Foundation
import KeyVault

public struct Holding: Equatable, Sendable, Identifiable {
    public let token: Token
    public let balance: UInt128
    /// nil means there's no trusted price. It isn't counted as $0: it's left out of the value and never swept automatically.
    public let priceUsdMicros: UInt128?

    public var id: String { token.id }
    public var valueUsdMicros: UInt128? {
        priceUsdMicros.map { Money.usdMicros(of: balance, priceMicros: $0, decimals: token.decimals) }
    }

    public init(token: Token, balance: UInt128, priceUsdMicros: UInt128?) {
        self.token = token
        self.balance = balance
        self.priceUsdMicros = priceUsdMicros
    }
}

public struct PlannedTransfer: Equatable, Sendable, Identifiable {
    public let token: Token
    public var amount: UInt128
    public var usdMicros: UInt128?
    /// How much of this is realized gains, which get marked as swept once it lands.
    public var gainUsdMicros: UInt128

    public var id: String { token.id }
}

public struct SweepPlan: Equatable, Sendable {
    public enum Blocker: Hashable, Sendable {
        /// Over the cap or holding a realized gain, and nowhere to sweep to.
        case noDestination
        /// Tokens that need to move, without the ETH to pay for it.
        case notEnoughGas
    }

    public var transfers: [PlannedTransfer] = []
    public var blockers: Set<Blocker> = []
    /// What's priced in the wallet, without the gas it keeps.
    public var valueUsdMicros: UInt128 = 0
    public var excessUsdMicros: UInt128 = 0
    public var gasReserveWei: UInt128 = 0
    /// Over the cap, but by less than it makes sense to spend gas on.
    public var excessIsDust = false
    /// What moving everything skipped because of what gas costs, which can change. It's still there, so it never
    /// counts as empty. ETH under `minimumSweep` isn't here, because paying for its own last transfer always leaves a little.
    public var notWorthTheGas: [Token] = []
}

public struct SweepPreview: Equatable, Sendable {
    public let transfers: [PlannedTransfer]
    public let feeWei: UInt128
    public let feeUsdMicros: UInt128?

    /// What it's all worth, unless something in it has no price, which isn't counted as $0.
    public var valueUsdMicros: UInt128? {
        transfers.reduce(UInt128?(0)) { total, transfer in
            guard let total, let usd = transfer.usdMicros else { return nil }
            return total + usd
        }
    }
}

public enum SweepPlanner {
    /// Below this a sweep isn't worth making, whatever gas costs.
    public static let minimumSweep: UInt128 = Money.dollar
    /// Nor if gas would be more than a tenth of what's moved.
    public static let maximumGasShare: UInt128 = 10
    /// Always there, because a low fee now says nothing about later.
    public static let minimumGasReserveWei: UInt128 = 100_000_000_000_000
    private static let sweepsReserved: UInt128 = 10

    public static func gasReserve(_ fees: FeeQuote) -> UInt128 {
        max(minimumGasReserveWei, sweepsReserved * fees.costWei(gas: FeeQuote.tokenTransferGas))
    }

    /// What the app does by itself: whatever's above the cap, plus realized gains. Only ever allowlisted tokens with a price.
    public static func automatic(holdings: [Holding], capUsdMicros: UInt128, fees: FeeQuote, destination: EthereumAddress?, pendingGainUsdMicros: UInt128) -> SweepPlan {
        var plan = SweepPlan()
        plan.gasReserveWei = gasReserve(fees)
        let ethPrice = holdings.first { $0.token.isNative }?.priceUsdMicros

        var available: [Token: UInt128] = [:]
        for holding in holdings where holding.priceUsdMicros != nil {
            available[holding.token] = holding.token.isNative ? holding.balance.subtractingClamped(plan.gasReserveWei) : holding.balance
        }
        let valueOf: (Holding) -> UInt128 = { holding in
            Money.usdMicros(of: available[holding.token] ?? 0, priceMicros: holding.priceUsdMicros ?? 0, decimals: holding.token.decimals)
        }
        plan.valueUsdMicros = holdings.reduce(0) { $0 + valueOf($1) }
        plan.excessUsdMicros = plan.valueUsdMicros.subtractingClamped(capUsdMicros)

        var ethForGas = holdings.first { $0.token.isNative }?.balance ?? 0
        // Whether or not anything is over the cap: tokens it can't move are stuck, and the user should hear that before it matters.
        let transferCost = fees.costWei(gas: FeeQuote.tokenTransferGas)
        let isStuck = holdings.contains { holding in
            guard !holding.token.isNative, holding.balance > 0 else { return false }
            guard let value = holding.valueUsdMicros, let ethPrice else { return true }
            return value > Money.usdMicros(of: transferCost, priceMicros: ethPrice, decimals: 18)
        }
        if isStuck, ethForGas < transferCost { plan.blockers.insert(.notEnoughGas) }

        let wantsGain = pendingGainUsdMicros >= minimumSweep
        guard plan.excessUsdMicros > 0 || wantsGain else { return plan }
        guard let destination, destination != .zero else {
            plan.blockers.insert(.noDestination)
            return plan
        }

        /// Takes `wanted` dollars from the holdings in this order. Whole sweeps only, so a dust remainder stays until it's bigger.
        func take(_ wanted: UInt128, from order: [Holding], isGain: Bool) {
            var remaining = wanted
            for holding in order where remaining > 0 {
                guard let price = holding.priceUsdMicros, let left = available[holding.token], left > 0 else { continue }
                let leftUsd = Money.usdMicros(of: left, priceMicros: price, decimals: holding.token.decimals)
                let usd = min(remaining, leftUsd)
                let amount = usd == leftUsd ? left : Money.amount(ofUsdMicros: usd, priceMicros: price, decimals: holding.token.decimals)
                guard amount > 0 else { continue }

                let existing = plan.transfers.firstIndex { $0.token == holding.token }
                let cost = existing == nil ? fees.costWei(of: holding.token) : 0
                let costUsd = ethPrice.map { Money.usdMicros(of: cost, priceMicros: $0, decimals: 18) }
                if existing == nil {
                    // Without an ETH price there's no saying what gas costs, so nothing moves.
                    guard let costUsd else { continue }
                    guard usd >= max(minimumSweep, costUsd * maximumGasShare) else {
                        if !isGain { plan.excessIsDust = true }
                        continue
                    }
                    guard ethForGas >= cost + (holding.token.isNative ? amount : 0) else {
                        plan.blockers.insert(.notEnoughGas)
                        continue
                    }
                }
                ethForGas -= cost + (holding.token.isNative ? amount : 0)
                if let existing {
                    plan.transfers[existing].amount += amount
                    plan.transfers[existing].usdMicros = (plan.transfers[existing].usdMicros ?? 0) + usd
                    if isGain { plan.transfers[existing].gainUsdMicros += usd }
                } else {
                    plan.transfers.append(PlannedTransfer(token: holding.token, amount: amount, usdMicros: usd, gainUsdMicros: isGain ? usd : 0))
                }
                available[holding.token] = left - amount
                remaining -= usd
            }
        }

        // Largest first, which usually means one transaction.
        let byValue = holdings.filter { valueOf($0) > 0 }.sorted { valueOf($0) > valueOf($1) }
        if plan.excessUsdMicros > 0 { take(plan.excessUsdMicros, from: byValue, isGain: false) }
        if wantsGain {
            // Gains are mostly already in a stablecoin. Taking from there leaves what's being held alone.
            let stablesFirst = byValue.filter(\.token.isStablecoin) + byValue.filter { !$0.token.isStablecoin }
            take(pendingGainUsdMicros, from: stablesFirst, isGain: true)
        }
        return plan
    }

    /// What the user asks for by hand: everything on the allowlist, priced or not, with ETH last because it pays for the rest.
    public static func everything(holdings: [Holding], fees: FeeQuote, destination: EthereumAddress) -> SweepPlan {
        var plan = SweepPlan()
        plan.valueUsdMicros = holdings.reduce(0) { $0 + ($1.valueUsdMicros ?? 0) }
        let native = holdings.first { $0.token.isNative }
        var eth = native?.balance ?? 0
        let ethPrice = native?.priceUsdMicros

        for holding in holdings where !holding.token.isNative && holding.balance > 0 {
            let cost = fees.costWei(of: holding.token)
            // Worth less than the gas to move it. Without a price, it isn't known to be, so it goes.
            if let value = holding.valueUsdMicros, let ethPrice, value <= Money.usdMicros(of: cost, priceMicros: ethPrice, decimals: 18) {
                plan.notWorthTheGas.append(holding.token)
                continue
            }
            guard eth >= cost else {
                plan.blockers.insert(.notEnoughGas)
                continue
            }
            eth -= cost
            plan.transfers.append(PlannedTransfer(token: holding.token, amount: holding.balance, usdMicros: holding.valueUsdMicros, gainUsdMicros: 0))
        }

        let cost = fees.costWei(of: Base.eth)
        if eth > 2 * cost {
            let amount = eth - cost
            let usd = ethPrice.map { Money.usdMicros(of: amount, priceMicros: $0, decimals: 18) }
            plan.transfers.append(PlannedTransfer(token: Base.eth, amount: amount, usdMicros: usd, gainUsdMicros: 0))
        } else if eth > 0, ethPrice.map({ Money.usdMicros(of: eth, priceMicros: $0, decimals: 18) >= minimumSweep }) ?? true {
            plan.notWorthTheGas.append(Base.eth)
        }
        return plan
    }
}

extension UInt128 {
    func subtractingClamped(_ other: UInt128) -> UInt128 {
        self > other ? self - other : 0
    }
}
