import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

struct BuyPlanTests {
    private let usdcToken = Base.tokens.first { $0.symbol == "USDC" }!
    private let price: UInt128 = 2_000 * Money.dollar
    private let cold = EthereumAddress("0x00000000000000000000000000000000000de302")!
    private let lowFees = cheapFees

    /// $25 of room under a $50 cap, with $25 of USDC already held unless it says otherwise.
    private func plan(_ dollars: Int, native: Bool = true, room: Int = 25, eth: UInt128 = SweepPlanner.minimumGasReserveWei, savings: Bool = true, fees: FeeQuote? = nil, usdcHeld: UInt128? = nil) -> BuyPlan {
        let held = usdcHeld ?? (UInt128(50 - min(room, 50)) * 1_000_000)
        return BuyPlan(
            usdMicros: UInt128(max(dollars, 0)) * Money.dollar,
            token: native ? Base.eth : usdcToken,
            priceUsdMicros: native ? price : Money.dollar,
            // As the wallet lists them: a token that isn't held isn't there.
            holdings: [Holding(token: Base.eth, balance: eth, priceUsdMicros: price)] + (held > 0 ? [Holding(token: usdcToken, balance: held, priceUsdMicros: Money.dollar)] : []),
            capUsdMicros: 50 * Money.dollar,
            roomUsdMicros: UInt128(room) * Money.dollar,
            fees: fees ?? lowFees,
            destination: savings ? cold : nil
        )
    }

    /// What's typed in another currency reaches the plan as USD, so the room, the sweep and the minimum are all measured as they are in USD.
    @Test func anAmountInAnotherCurrencyIsMeasuredInUSD() {
        let cad = MoneyDisplay(main: .CAD, rateMicros: "1400000")
        #expect(cad.usdMicros(ofWhole: 28) == 20 * Money.dollar)
        #expect(cad.wholeAmount(BuyPlan.minimumUsdMicros, rounding: .up) == 5)
        #expect(cad.usdMicros(ofWhole: 4) < BuyPlan.minimumUsdMicros)
        #expect(cad.usdMicros(ofWhole: 5) >= BuyPlan.minimumUsdMicros)
        #expect(BuyPlan.cryptoAmount(usdMicros: cad.usdMicros(ofWhole: 4), isNative: false, ethUsdMicros: nil) == nil)
        #expect(BuyPlan.cryptoAmount(usdMicros: cad.usdMicros(ofWhole: 50), isNative: false, ethUsdMicros: nil) == "35.71", "Rounded down, so it never asks for more than was chosen")
        #expect(BuyPlan.cryptoAmount(usdMicros: cad.usdMicros(ofWhole: 28), isNative: false, ethUsdMicros: nil) == "20")
    }

    @Test func whatFitsStays() {
        #expect(plan(20).stays == 20 * Money.dollar)
        #expect(plan(20).sweeps == 0)
        #expect(plan(20).problem == nil)
        #expect(plan(25).sweeps == 0, "Exactly to the cap sweeps nothing")
    }

    @Test func theRestGoesToSavingsWithNoMaximumOfOurs() {
        let large = plan(5000)
        #expect(large.stays == 25 * Money.dollar)
        #expect(large.sweeps == 4975 * Money.dollar)
        #expect(large.problem == nil)
        #expect(plan(50, room: 0).stays == 0)
        #expect(plan(50, room: 0).sweeps == 50 * Money.dollar)
    }

    @Test func withoutSavingsNothingCanBeBoughtEvenWhatFits() {
        // The page can raise the amount, so a small preset is no limit: at $500, $475 would have nowhere to go.
        for dollars in [3, 25, 26, 500] { #expect(plan(dollars, savings: false).problem == .needsSavings) }
        #expect(plan(3, native: false, savings: false).problem == .needsSavings)
    }

    @Test func aTokenThatCantBeSweptForLackOfGasIsStopped() {
        #expect(plan(100, native: false, eth: 0).problem == .noGasToSweep)
        #expect(plan(100, native: false).problem == nil)
        #expect(plan(100, native: true, eth: 0).problem == nil, "ETH pays for its own sweep")
    }

    @Test func gasIsCheckedAtTodaysFee() {
        // $75 above the cap, and 0.0001 ETH, which a 2 gwei fee makes too little for a token transfer. The minimum reserve would have passed it.
        let dear = FeeQuote(maxFeePerGas: 2_000_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 0)
        #expect(plan(100, native: false, eth: SweepPlanner.minimumGasReserveWei, fees: dear).problem == .noGasToSweep)
        #expect(plan(100, native: false, eth: SweepPlanner.minimumGasReserveWei * 3, fees: dear).problem == nil)
        #expect(plan(100, native: true, eth: 0, fees: dear).problem == nil)
    }

    @Test func aTokenWithNoGasIsStoppedEvenWhenThisMuchFits() {
        // The page can raise the amount, and a token that can't move has no way back out.
        #expect(plan(20, native: false, eth: 0, usdcHeld: 0).problem == .noGasToSweep)
        #expect(plan(20, native: true, eth: 0, usdcHeld: 0).problem == nil)
    }

    @Test func thereIsNoSayingUntilTheChainsBeenRead() {
        let unread = BuyPlan(usdMicros: 20 * Money.dollar, token: Base.eth, priceUsdMicros: nil, holdings: [], capUsdMicros: 50 * Money.dollar, roomUsdMicros: 50 * Money.dollar, fees: nil, destination: cold)
        #expect(unread.problem == .notReadYet)
        let noPrice = BuyPlan(usdMicros: 20 * Money.dollar, token: Base.eth, priceUsdMicros: nil, holdings: [Holding(token: Base.eth, balance: 0, priceUsdMicros: nil)], capUsdMicros: 50 * Money.dollar, roomUsdMicros: 50 * Money.dollar, fees: lowFees, destination: cold)
        #expect(noPrice.problem == .notReadYet)
    }

    @Test func belowTheMinimumIsSaidFirst() {
        #expect(plan(2).problem == .belowMinimum)
        #expect(plan(0).problem == .belowMinimum)
        #expect(plan(3).problem == nil)
    }

    @Test func aNewKeysTrialLimitCanBeMet() {
        // Coinbase refused $5 of ETH at CA$6.99 a transaction, so the floor has to be well under that, at about 1.40 CAD to the dollar.
        #expect(BuyPlan.minimumDollars * 140 < 699)
        #expect(plan(BuyPlan.minimumDollars).problem == nil)
    }

    @Test func whatsTypedIsntAlwaysAnAmount() {
        // An empty field reads as 0.
        for typed in [-5, -1, 0, Int.min, 2] {
            #expect(plan(typed).problem == .belowMinimum)
            #expect(plan(typed).stays == 0 || typed == 2)
            #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(typed, 0)) * Money.dollar, isNative: true, ethUsdMicros: 2_640_000_000) == nil)
            #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(typed, 0)) * Money.dollar, isNative: false, ethUsdMicros: nil) == nil)
        }
    }

    @Test func theAmountToAskForIsInTheToken() {
        #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(17, 0)) * Money.dollar, isNative: true, ethUsdMicros: 2_640_000_000) == "0.006439")
        #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(50, 0)) * Money.dollar, isNative: false, ethUsdMicros: nil) == "50")
        #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(17, 0)) * Money.dollar, isNative: true, ethUsdMicros: nil) == nil)
        #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(17, 0)) * Money.dollar, isNative: true, ethUsdMicros: 0) == nil)
        #expect(BuyPlan.cryptoAmount(usdMicros: UInt128(max(.max, 0)) * Money.dollar, isNative: true, ethUsdMicros: 1) != nil, "However large, it doesn't overflow")
    }

    @Test func amountsForTheProviderRoundDown() {
        #expect(BuyPlan.decimal(6_439_393_939_393_939, decimals: 18, keeping: 6) == "0.006439")
        #expect(BuyPlan.decimal(1_500_000_000_000_000_000, decimals: 18, keeping: 6) == "1.500000")
        #expect(BuyPlan.decimal(12, decimals: 18, keeping: 6) == "0.000000")
    }
}
