import Foundation
import KeyVault
import Testing
@testable import HotWalletKit

private let cap = 50 * Money.dollar

private func holdings(eth: UInt128 = oneEth / 100, ethUsd: UInt128? = ethPrice, _ tokens: (Token, UInt128, UInt128?)...) -> [Holding] {
    [Holding(token: Base.eth, balance: eth, priceUsdMicros: ethUsd)] + tokens.map { Holding(token: $0.0, balance: $0.1, priceUsdMicros: $0.2) }
}

private func plan(_ holdings: [Holding], cap: UInt128 = cap, fees: FeeQuote = cheapFees, destination: EthereumAddress? = coldAddress, gain: UInt128 = 0) -> SweepPlan {
    SweepPlanner.automatic(holdings: holdings, capUsdMicros: cap, fees: fees, destination: destination, pendingGainUsdMicros: gain)
}

@Suite struct SweepPlannerTests {
    @Test func nothingHappensUnderTheCap() {
        let result = plan(holdings(eth: oneEth / 1000, (usdc, usdcUnits(40), Money.dollar)))
        #expect(result.transfers.isEmpty)
        #expect(result.excessUsdMicros == 0)
    }

    @Test func sweepsWhatsAboveTheCapAndLeavesExactlyTheCap() throws {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(500), Money.dollar)))
        let transfer = try #require(result.transfers.first)
        #expect(result.transfers.count == 1)
        #expect(transfer.token == usdc)
        #expect(transfer.amount == usdcUnits(450))
        #expect(result.valueUsdMicros == 500 * Money.dollar)
        #expect(result.excessUsdMicros == 450 * Money.dollar)
    }

    @Test func aReceiptFromAnExchangeCanBeWayOverTheCapForAMoment() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(1_000_000), Money.dollar)))
        #expect(result.transfers.first?.amount == usdcUnits(999_950))
    }

    @Test func takesFromTheLargestHoldingFirst() {
        let result = plan(holdings(eth: oneEth / 10, (usdc, usdcUnits(40), Money.dollar)))
        // About $300 of ETH and $40 of USDC, with $290 to move: ETH is the one to take from, and one transaction does it.
        #expect(result.transfers.map(\.token) == [Base.eth])
    }

    @Test func spillsIntoTheNextHoldingWhenTheFirstIsntEnough() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(60), Money.dollar), (weth, oneEth / 50, ethPrice)), cap: 10 * Money.dollar)
        // WETH is $60 and USDC is $60: it takes all of one and part of the other.
        #expect(result.transfers.count == 2)
        #expect(result.transfers.reduce(0) { $0 + ($1.usdMicros ?? 0) } == 110 * Money.dollar)
    }

    @Test func alwaysLeavesTheGasReserveInEth() throws {
        let fees = cheapFees
        let reserve = SweepPlanner.gasReserve(fees)
        let result = plan(holdings(eth: oneEth), fees: fees)
        let transfer = try #require(result.transfers.first)
        #expect(transfer.token.isNative)
        #expect(oneEth - transfer.amount >= reserve)
    }

    @Test func theReserveDoesntCountTowardTheCap() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei), cap: Money.dollar)
        #expect(result.valueUsdMicros == 0)
        #expect(result.transfers.isEmpty)
    }

    @Test func theReserveGrowsWithFees() {
        let expensive = FeeQuote(maxFeePerGas: 10_000_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 300_000_000_000)
        #expect(SweepPlanner.gasReserve(expensive) > SweepPlanner.minimumGasReserveWei)
    }

    @Test func aTokenWithNoPriceIsNeverCountedOrSwept() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (dai, oneEth * 1000, nil)))
        #expect(result.transfers.isEmpty)
        #expect(result.valueUsdMicros == 0)
    }

    @Test func withNoColdWalletTheExcessStaysAndSaysSo() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(500), Money.dollar)), destination: nil)
        #expect(result.transfers.isEmpty)
        #expect(result.blockers == [.noDestination])
        #expect(result.excessUsdMicros == 450 * Money.dollar)
    }

    @Test func tokensWithNoEthToMoveThemAreFlagged() {
        let result = plan(holdings(eth: 0, (usdc, usdcUnits(500), Money.dollar)))
        #expect(result.transfers.isEmpty)
        #expect(result.blockers == [.notEnoughGas])
    }

    @Test func flagsTokensItCantMoveEvenUnderTheCap() {
        let result = plan(holdings(eth: 0, (usdc, usdcUnits(10), Money.dollar)))
        #expect(result.blockers == [.notEnoughGas])
        #expect(result.excessUsdMicros == 0)
    }

    @Test func dustWithNoGasIsntWorthFlagging() {
        let result = plan(holdings(eth: 0, (usdc, 1, Money.dollar)))
        #expect(result.blockers.isEmpty)
    }

    @Test func aTokenWithNoPriceAndNoGasIsStillStuck() {
        let result = plan(holdings(eth: 0, (dai, oneEth, nil)))
        #expect(result.blockers == [.notEnoughGas])
    }

    @Test func skipsDust() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(50) + 500_000, Money.dollar)))
        #expect(result.transfers.isEmpty)
        #expect(result.excessIsDust)
    }

    @Test func skipsAnAmountGasWouldEatTooMuchOf() {
        // At 10 gwei a transfer costs $3, so $20 isn't worth moving, even though it's well above the $1 floor.
        let expensive = FeeQuote(maxFeePerGas: 10_000_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 0)
        let result = plan(holdings(eth: SweepPlanner.gasReserve(expensive), (usdc, usdcUnits(70), Money.dollar)), fees: expensive)
        #expect(result.transfers.isEmpty)
        #expect(result.excessIsDust)
    }

    @Test func movesNothingWhenItCantValueGas() {
        let result = plan(holdings(eth: oneEth / 1000, ethUsd: nil, (usdc, usdcUnits(500), Money.dollar)))
        #expect(result.transfers.isEmpty)
        #expect(!result.excessIsDust)
    }

    @Test func gainsComeFromAnyStablecoinBeforeWhatsBeingHeld() throws {
        let aero = token("AERO")
        // $30 of ETH, $40 of AERO and $20 of DAI, all under a high cap. $10 of gains leaves the ETH and AERO alone.
        let result = plan(holdings(eth: oneEth / 100, (aero, oneEth * 40, Money.dollar), (dai, oneEth * 20, Money.dollar)), cap: 100 * Money.dollar, gain: 10 * Money.dollar)
        #expect(result.transfers.map(\.token) == [dai])
        #expect(result.transfers.first?.gainUsdMicros == 10 * Money.dollar)
    }

    @Test func sweepsRealizedGainsEvenUnderTheCap() throws {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(30), Money.dollar)), gain: 12 * Money.dollar)
        let transfer = try #require(result.transfers.first)
        #expect(transfer.token == usdc)
        #expect(transfer.amount == usdcUnits(12))
        #expect(transfer.gainUsdMicros == 12 * Money.dollar)
    }

    @Test func gainsComeFromUsdcFirstEvenIfSomethingElseIsBigger() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (weth, oneEth / 100, ethPrice), (usdc, usdcUnits(10), Money.dollar)), cap: 100 * Money.dollar, gain: 5 * Money.dollar)
        #expect(result.transfers.map(\.token) == [usdc])
    }

    @Test func gainsAndExcessMergeIntoOneTransfer() throws {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(100), Money.dollar)), gain: 5 * Money.dollar)
        let transfer = try #require(result.transfers.first)
        #expect(result.transfers.count == 1)
        #expect(transfer.amount == usdcUnits(55))
        #expect(transfer.gainUsdMicros == 5 * Money.dollar)
    }

    @Test func aDustGainWaitsToGrow() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (usdc, usdcUnits(30), Money.dollar)), gain: 500_000)
        #expect(result.transfers.isEmpty)
    }

    @Test func survivesAnAbsurdBalance() {
        let result = plan(holdings(eth: SweepPlanner.minimumGasReserveWei, (token("DEGEN"), UInt128.max, Money.dollar)))
        #expect(result.transfers.count <= 1)
    }

    // MARK: - Everything

    @Test func everythingMovesAllTokensPricedOrNotWithEthLast() {
        let result = SweepPlanner.everything(holdings: holdings(eth: oneEth / 100, (usdc, usdcUnits(10), Money.dollar), (dai, oneEth, nil)), fees: cheapFees, destination: coldAddress)
        #expect(result.transfers.map(\.token.symbol) == ["USDC", "DAI", "ETH"])
    }

    @Test func everythingLeavesEnoughEthToPayForAllOfIt() {
        let result = SweepPlanner.everything(holdings: holdings(eth: oneEth / 100, (usdc, usdcUnits(10), Money.dollar)), fees: cheapFees, destination: coldAddress)
        let sentEth = result.transfers.first { $0.token.isNative }!.amount
        #expect(sentEth + cheapFees.costWei(of: usdc) + cheapFees.costWei(of: Base.eth) == oneEth / 100)
    }

    @Test func everythingSaysSoWhenThereIsNoGas() {
        let result = SweepPlanner.everything(holdings: holdings(eth: 0, (usdc, usdcUnits(10), Money.dollar)), fees: cheapFees, destination: coldAddress)
        #expect(result.transfers.isEmpty)
        #expect(result.blockers == [.notEnoughGas])
    }

    @Test func everythingLeavesBehindWhatsWorthLessThanItsGas() {
        let result = SweepPlanner.everything(holdings: holdings(eth: oneEth / 1000, (usdc, 1, Money.dollar)), fees: cheapFees, destination: coldAddress)
        #expect(!result.transfers.contains { $0.token == usdc })
        #expect(result.notWorthTheGas == [usdc])
    }

    @Test func everythingDoesntSpendGasToMoveDustEth() {
        let result = SweepPlanner.everything(holdings: holdings(eth: cheapFees.costWei(of: Base.eth)), fees: cheapFees, destination: coldAddress)
        #expect(result.transfers.isEmpty)
        #expect(result.blockers.isEmpty)
        #expect(result.notWorthTheGas.isEmpty, "that's what's left after a last transfer")
    }

    @Test func everythingSaysWhenGasMakesRealEthNotWorthMoving() {
        let fees = FeeQuote(maxFeePerGas: 100_000_000_000, maxPriorityFeePerGas: 1_000_000, l1FeeWei: 0)
        let result = SweepPlanner.everything(holdings: holdings(eth: oneEth / 300), fees: fees, destination: coldAddress)
        #expect(result.transfers.isEmpty)
        #expect(result.notWorthTheGas == [Base.eth])
    }

    @Test func everythingDoesntGuessEthsWorthWithoutAPrice() {
        let result = SweepPlanner.everything(holdings: holdings(eth: cheapFees.costWei(of: Base.eth), ethUsd: nil), fees: cheapFees, destination: coldAddress)
        #expect(result.notWorthTheGas == [Base.eth])
    }
}

@Suite struct MoneyTests {
    @Test func convertsBothWays() {
        #expect(Money.usdMicros(of: oneEth, priceMicros: ethPrice, decimals: 18) == ethPrice)
        #expect(Money.amount(ofUsdMicros: ethPrice, priceMicros: ethPrice, decimals: 18) == oneEth)
        #expect(Money.usdMicros(of: 1_500_000, priceMicros: Money.dollar, decimals: 6) == 1_500_000)
    }

    @Test func saturatesRatherThanTrapping() {
        #expect(Money.usdMicros(of: .max, priceMicros: .max, decimals: 0) == .max)
        #expect(Money.amount(ofUsdMicros: 1, priceMicros: 0, decimals: 18) == 0)
    }

    @Test func handlesBigProductsWithoutOverflowing() {
        // A trillion tokens at $100,000: past 128 bits in the middle of the sum, and fine at the end.
        let amount: UInt128 = 1_000_000_000_000 * oneEth
        #expect(Money.usdMicros(of: amount, priceMicros: 100_000 * Money.dollar, decimals: 18) == 1_000_000_000_000 * 100_000 * Money.dollar)
    }
}

@Suite struct SettingsTests {
    @Test func suggestsFiftyWithAColdWalletAndTwentyFiveWithout() {
        var settings = WalletSettings()
        #expect(settings.capInDollars == 25)
        settings.add(ColdWallet(address: coldAddress, name: "L", confirmedOnDeviceAt: Date()))
        #expect(settings.capInDollars == 50)
    }

    @Test func neverGoesPastTheCeiling() {
        var settings = WalletSettings()
        settings.add(ColdWallet(address: coldAddress, name: "L", confirmedOnDeviceAt: Date()))
        settings.setCap(dollars: 5000)
        #expect(settings.capUsdMicros == 100 * Money.dollar)
        settings.setCap(dollars: -3)
        #expect(settings.capUsdMicros == Money.dollar)
    }

    @Test func removingTheLastColdWalletLowersTheCapAgain() {
        var settings = WalletSettings()
        settings.add(ColdWallet(address: coldAddress, name: "L", confirmedOnDeviceAt: Date()))
        settings.setCap(dollars: 100)
        settings.removeColdWallet(coldAddress)
        #expect(settings.capInDollars == 25)
        #expect(settings.sweepDestination == nil)
    }

    @Test func aDestinationHasToBeARegisteredColdWallet() {
        var settings = WalletSettings()
        settings.setSweepDestination(coldAddress)
        #expect(settings.sweepDestination == nil)
    }

    @Test func survivesTheStore() {
        let defaults = UserDefaults(suiteName: "work331-\(UUID().uuidString)")!
        let store = UserDefaultsWalletSettingsStore(defaults: defaults)
        var settings = WalletSettings()
        settings.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: Date(timeIntervalSince1970: 1)))
        settings.setCap(dollars: 75)
        store.save(settings)
        #expect(store.load() == settings)
    }
}

@Suite struct ChainDecodingTests {
    private func word(_ value: UInt128) -> String {
        String(repeating: "0", count: 32) + String(format: "%032@", String(value, radix: 16) as NSString).replacingOccurrences(of: " ", with: "0")
    }

    private func round(answer: UInt128, updatedAt: UInt128) -> String {
        "0x" + [1, answer, 2, updatedAt, 1].map(pad).joined()
    }

    private func pad(_ value: UInt128) -> String {
        let hex = String(value, radix: 16)
        return String(repeating: "0", count: 64 - hex.count) + hex
    }

    @Test func readsAChainlinkAnswer() {
        #expect(Oracle.price(round(answer: 300_000_000_000, updatedAt: 1000), feed: .eth, blockTime: 1100) == 3000 * Money.dollar)
    }

    @Test func aStalePriceIsNoPrice() {
        #expect(Oracle.price(round(answer: 300_000_000_000, updatedAt: 1000), feed: .eth, blockTime: 1000 + 3601) == nil)
        #expect(Oracle.price(round(answer: 100_000_000, updatedAt: 1000), feed: .usdc, blockTime: 1000 + 3601) == Money.dollar)
    }

    @Test func anImplausiblePriceIsNoPrice() {
        #expect(Oracle.price(round(answer: 5_000_000_000, updatedAt: 1000), feed: .eth, blockTime: 1000) == nil)
        #expect(Oracle.price(round(answer: 50_000_000, updatedAt: 1000), feed: .usdc, blockTime: 1000) == nil)
    }

    @Test func aNegativeOrBrokenAnswerIsNoPrice() {
        let negative = "0x" + pad(1) + String(repeating: "f", count: 64) + pad(2) + pad(1000) + pad(1)
        #expect(Oracle.price(negative, feed: .eth, blockTime: 1000) == nil)
        #expect(Oracle.price("0x", feed: .eth, blockTime: 1000) == nil)
        #expect(Oracle.price(nil, feed: .eth, blockTime: 1000) == nil)
    }

    @Test func aFeedKeepsToItsOwnHeartbeat() throws {
        let dai = try #require(Oracle.others["DAI"])
        let cbBTC = try #require(Oracle.others["cbBTC"])
        #expect(Oracle.price(round(answer: 100_000_000, updatedAt: 1000), feed: dai, blockTime: 1000 + 25 * 3600) == Money.dollar)
        #expect(Oracle.price(round(answer: 100_000_000, updatedAt: 1000), feed: dai, blockTime: 1000 + 27 * 3600) == nil)
        #expect(Oracle.price(round(answer: 8_000_000_000_000, updatedAt: 1000), feed: cbBTC, blockTime: 1000 + 3601, ethUsdMicros: ethPrice) == nil)
    }

    @Test func aDepeggedStablecoinIsNoPrice() throws {
        let usdt = try #require(Oracle.others["USDT"])
        #expect(Oracle.price(round(answer: 99_000_000, updatedAt: 1000), feed: usdt, blockTime: 1000) == 990_000)
        #expect(Oracle.price(round(answer: 70_000_000, updatedAt: 1000), feed: usdt, blockTime: 1000) == nil)
    }

    @Test func aFeedCheckedAgainstEthNeedsEthsPrice() throws {
        let cbBTC = try #require(Oracle.others["cbBTC"])
        let answer = round(answer: 8_000_000_000_000, updatedAt: 1000)
        #expect(Oracle.price(answer, feed: cbBTC, blockTime: 1000, ethUsdMicros: ethPrice) == 80_000 * Money.dollar)
        #expect(Oracle.price(answer, feed: cbBTC, blockTime: 1000) == nil)
        // $80,000 is more than 200 ETH at $300, and less than 5 ETH at $20,000.
        #expect(Oracle.price(answer, feed: cbBTC, blockTime: 1000, ethUsdMicros: 300 * Money.dollar) == nil)
        #expect(Oracle.price(answer, feed: cbBTC, blockTime: 1000, ethUsdMicros: 20_000 * Money.dollar) == nil)
    }

    @Test func aFeedAnsweringInEthIsPricedThroughEth() throws {
        let wstETH = try #require(Oracle.others["wstETH"])
        let answer = round(answer: 1_250_000_000_000_000_000, updatedAt: 1000)
        #expect(Oracle.price(answer, feed: wstETH, blockTime: 1000, ethUsdMicros: 2000 * Money.dollar) == 2500 * Money.dollar)
        #expect(Oracle.price(answer, feed: wstETH, blockTime: 1000) == nil)
        #expect(Oracle.price(round(answer: 2_000_000_000_000_000_000, updatedAt: 1000), feed: wstETH, blockTime: 1000, ethUsdMicros: 2000 * Money.dollar) == nil)
    }

    @Test func quantities() throws {
        #expect(try RPCChainClient.quantity("0x0") == 0)
        #expect(try RPCChainClient.quantity("0x10") == 16)
        #expect(try RPCChainClient.quantity("0x" + String(repeating: "0", count: 40) + "ff") == 255)
        #expect(throws: ChainError.unreadable) { try RPCChainClient.quantity("0x1" + String(repeating: "0", count: 40)) }
        #expect(throws: ChainError.unreadable) { try RPCChainClient.quantity("12") }
        #expect(throws: ChainError.unreadable) { try RPCChainClient.quantity(nil) }
    }

    @Test func selectors() {
        #expect(Hex.encode(Calldata.transfer(to: coldAddress, amount: 100).prefix(4)) == "a9059cbb")
        #expect(Hex.encode(Calldata.balanceOf(coldAddress).prefix(4)) == "70a08231")
        #expect(Hex.encode(Calldata.latestRoundData) == "feaf968c")
        #expect(Hex.encode(Calldata.l1Fee(ofPayloadBytes: 180).prefix(4)) == "49948e0e")
    }

    @Test func transferCalldata() {
        #expect(Hex.encode(Calldata.transfer(to: coldAddress, amount: 100)) == "a9059cbb00000000000000000000000012345678901234567890123456789012345678900000000000000000000000000000000000000000000000000000000000000064")
    }
}

@Suite struct AllowlistTests {
    private struct Fixture: Decodable {
        struct Entry: Decodable {
            let address: String
            let symbol: String
            let decimals: Int
            let asset: String
            let sanity: Sanity?
        }

        let tokens: [Entry]
        let ethUsdFeed: String
        let usdcUsdFeed: String
    }

    private struct Sanity: Decodable {
        let usd: [Double]?
        let eth: [Double]?
    }

    @Test func matchesTheServers() throws {
        let url = try #require(Bundle.module.url(forResource: "tokens", withExtension: "json", subdirectory: "Resources"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        #expect(fixture.tokens.map(\.symbol) == Base.tokens.map(\.symbol))
        for (entry, token) in zip(fixture.tokens, Base.tokens) {
            #expect(entry.address == (token.contract ?? .zero).lowercased)
            #expect(entry.decimals == token.decimals)
            #expect(entry.asset == token.asset)
        }
        #expect(fixture.ethUsdFeed == Base.ethUsdFeed.lowercased)
        #expect(fixture.usdcUsdFeed == Base.usdcUsdFeed.lowercased)
    }

    @Test func everyTokenHasAFeed() {
        let priced = Set(Oracle.others.keys).union(["ETH", "USDC"])
        #expect(priced == Set(Base.tokens.map(\.asset)))
    }

    @Test func feedsUseTheServersBounds() throws {
        let url = try #require(Bundle.module.url(forResource: "tokens", withExtension: "json", subdirectory: "Resources"))
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        let scaled: ([Double], Double) -> ClosedRange<UInt128> = { UInt128(($0[0] * $1).rounded())...UInt128(($0[1] * $1).rounded()) }
        for entry in fixture.tokens {
            guard let sanity = entry.sanity else { continue }
            let feeds = Oracle.others.merging(["ETH": .eth, "USDC": .usdc]) { first, _ in first }
            let feed = try #require(feeds[entry.asset], "\(entry.symbol)")
            if let usd = sanity.usd { #expect(feed.plausible == .usd(scaled(usd, 1_000_000)), "\(entry.symbol)") }
            if let eth = sanity.eth { #expect(feed.plausible == .eth(scaled(eth, 1000)), "\(entry.symbol)") }
        }
    }
}
