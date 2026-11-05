import KeyVault
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
            dollars: dollars,
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

    @Test func withoutSavingsItsLimitedToTheRoom() {
        #expect(plan(25, savings: false).problem == nil)
        #expect(plan(26, savings: false).problem == .needsSavings)
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
        let unread = BuyPlan(dollars: 20, token: Base.eth, priceUsdMicros: nil, holdings: [], capUsdMicros: 50 * Money.dollar, roomUsdMicros: 50 * Money.dollar, fees: nil, destination: cold)
        #expect(unread.problem == .notReadYet)
        let noPrice = BuyPlan(dollars: 20, token: Base.eth, priceUsdMicros: nil, holdings: [Holding(token: Base.eth, balance: 0, priceUsdMicros: nil)], capUsdMicros: 50 * Money.dollar, roomUsdMicros: 50 * Money.dollar, fees: lowFees, destination: cold)
        #expect(noPrice.problem == .notReadYet)
    }

    @Test func belowTheMinimumIsSaidFirst() {
        #expect(plan(4).problem == .belowMinimum)
        #expect(plan(0, savings: false).problem == .belowMinimum)
        #expect(plan(5).problem == nil)
    }

    @Test func whatsTypedIsntAlwaysAnAmount() {
        // An empty field reads as 0.
        for typed in [-5, -1, 0, Int.min, 4] {
            #expect(plan(typed).problem == .belowMinimum)
            #expect(plan(typed).stays == 0 || typed == 4)
            #expect(BuyPlan.cryptoAmount(dollars: typed, isNative: true, ethUsdMicros: 2_640_000_000) == nil)
            #expect(BuyPlan.cryptoAmount(dollars: typed, isNative: false, ethUsdMicros: nil) == nil)
        }
    }

    @Test func theAmountToAskForIsInTheToken() {
        #expect(BuyPlan.cryptoAmount(dollars: 17, isNative: true, ethUsdMicros: 2_640_000_000) == "0.006439")
        #expect(BuyPlan.cryptoAmount(dollars: 50, isNative: false, ethUsdMicros: nil) == "50")
        #expect(BuyPlan.cryptoAmount(dollars: 17, isNative: true, ethUsdMicros: nil) == nil)
        #expect(BuyPlan.cryptoAmount(dollars: 17, isNative: true, ethUsdMicros: 0) == nil)
        #expect(BuyPlan.cryptoAmount(dollars: .max, isNative: true, ethUsdMicros: 1) != nil, "However large, it doesn't overflow")
    }

    @Test func amountsForTheProviderRoundDown() {
        #expect(BuyPlan.decimal(6_439_393_939_393_939, decimals: 18, keeping: 6) == "0.006439")
        #expect(BuyPlan.decimal(1_500_000_000_000_000_000, decimals: 18, keeping: 6) == "1.500000")
        #expect(BuyPlan.decimal(12, decimals: 18, keeping: 6) == "0.000000")
    }
}
