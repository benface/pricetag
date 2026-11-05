import Testing
@testable import HotWalletKit

struct BuyPlanTests {
    private func plan(_ dollars: Int, native: Bool = true, room: Int = 25, eth: UInt128 = SweepPlanner.minimumGasReserveWei, savings: Bool = true) -> BuyPlan {
        BuyPlan(dollars: dollars, isNative: native, roomUsdMicros: UInt128(room) * Money.dollar, ethBalanceWei: eth, hasSavings: savings)
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
        #expect(plan(100, native: false, eth: SweepPlanner.minimumGasReserveWei - 1).problem == .noGasToSweep)
        #expect(plan(100, native: false).problem == nil)
        #expect(plan(100, native: true, eth: 0).problem == nil, "ETH pays for its own sweep")
        #expect(plan(20, native: false, eth: 0).problem == nil, "Nothing has to move")
    }

    @Test func belowTheMinimumIsSaidFirst() {
        #expect(plan(4).problem == .belowMinimum)
        #expect(plan(0, savings: false).problem == .belowMinimum)
        #expect(plan(5).problem == nil)
    }

    @Test func amountsForTheProviderRoundDown() {
        #expect(BuyPlan.decimal(6_439_393_939_393_939, decimals: 18, keeping: 6) == "0.006439")
        #expect(BuyPlan.decimal(1_500_000_000_000_000_000, decimals: 18, keeping: 6) == "1.500000")
        #expect(BuyPlan.decimal(12, decimals: 18, keeping: 6) == "0.000000")
    }
}
