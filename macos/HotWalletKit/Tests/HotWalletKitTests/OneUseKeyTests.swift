import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

/// The address an ERC-20 transfer's calldata sends to.
private func recipient(_ transaction: UnsignedTransaction) -> EthereumAddress? {
    EthereumAddress("0x" + Hex.encode(transaction.data[16..<36]))
}

/// A one-use key's history, recent enough to retire it on.
private let keyHistory = portfolio(address: oneUseAddress, toBlock: 2000)

/// What's left on a key after ETH paid for its own last move: less than anything worth moving.
private let dust: UInt128 = 1_000_000_000

@MainActor
@Suite struct OneUseKeyTests {
    @Test func aKeyForAPurchaseIsOnDiskBeforeItsAddressGoesAnywhere() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        let key = try #require(await rig.wallet.createOneUseKey())
        #expect(key == oneUseAddress)
        #expect(rig.stateStore.saved.oneUseKeys?.map(\.address) == [oneUseAddress])
        #expect(rig.stateStore.saved.oneUseKeys?.first?.destination == coldAddress)
        #expect(rig.stateStore.saved.purchaseKeys == [oneUseAddress])
        #expect(rig.wallet.address == hotAddress, "Spending Money stays what it was")
        #expect(rig.wallet.linkedWallets.contains(oneUseAddress.lowercased), "so what's bought carries its cost on to savings")
        #expect(rig.wallet.replacedKeys.isEmpty)
    }

    @Test func aKeyThatCantBeWrittenDownIsDeletedAndNothingStarts() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        rig.stateStore.failSaves(with: CocoaError(.fileWriteNoPermission))
        #expect(await rig.wallet.createOneUseKey() == nil)
        #expect(await rig.signer.hasKey(oneUseAddress) == false)
        #expect(rig.wallet.oneUseKeys.isEmpty)
    }

    @Test func thereIsNoOneUseKeyWithoutSavingsOrWhileTheKeyMayBeStolen() async throws {
        let noSavings = await Rig(withCold: false, nextKeys: [oneUseAddress])
        #expect(await noSavings.wallet.createOneUseKey() == nil)

        let alarmed = await Rig(nextKeys: [oneUseAddress], portfolio: .success(portfolio(outgoing: ["0x" + String(repeating: "ab", count: 32)])))
        await alarmed.wallet.readHistory()
        #expect(alarmed.wallet.alarm != nil)
        #expect(await alarmed.wallet.createOneUseKey() == nil)
        #expect(await alarmed.signer.addresses() == [hotAddress])
    }

    @Test func onlyWhatDoesntFitGoesThroughOne() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        #expect(rig.wallet.buysThroughOneUseKey(usdMicros: rig.wallet.topUpRoom) == false)
        #expect(rig.wallet.buysThroughOneUseKey(usdMicros: rig.wallet.topUpRoom + Money.dollar))

        let noSavings = await Rig(withCold: false)
        await noSavings.wallet.tick()
        #expect(noSavings.wallet.buysThroughOneUseKey(usdMicros: 5000 * Money.dollar) == false, "without savings there's nowhere for it to go on to")
    }

    @Test func boughtEthMovesToSavingsThenTheKeyIsRetired() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress], portfolio: .success(keyHistory))
        await rig.wallet.tick()
        await rig.chain.set(snapshot(eth: 0), for: oneUseAddress)
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.wallet.tick()
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .waitingForPurchase)
        #expect(await rig.signer.signed.isEmpty)

        await rig.chain.set(snapshot(eth: oneEth / 10), for: oneUseAddress)
        await rig.wallet.tick()
        let sweep = try #require(await rig.signer.signed.last)
        #expect(sweep.to == coldAddress)
        #expect(sweep.value > oneEth / 10 - oneEth / 1000, "all of it, less the fee")
        #expect(rig.wallet.state.records[oneUseAddress]?.map(\.reason) == [.purchase])
        #expect(rig.wallet.state.records[hotAddress] == nil, "Spending Money's records aren't touched")

        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: dust, nonce: 1), for: oneUseAddress)
        await rig.wallet.tick()
        await rig.wallet.readOneUseHistory()
        for _ in 1..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(oneUseAddress), "one read saying it's empty isn't enough to delete a key")
        await rig.wallet.tick()
        #expect(await rig.signer.hasKey(oneUseAddress) == false)
        #expect(rig.wallet.oneUseKeys.isEmpty)
        #expect(rig.wallet.state.retired == [oneUseAddress])
        #expect(rig.wallet.linkedWallets.contains(oneUseAddress.lowercased), "its costs still carry over")
        #expect(rig.wallet.replacedKeys.isEmpty, "and it isn't listed as a replaced key")
        #expect(rig.wallet.purchaseKeys == [oneUseAddress], "and its purchases can still be found")
        #expect(rig.wallet.address == hotAddress)
    }

    @Test func boughtUsdcGetsItsFeeFromSpendingMoneyOnceThenMoves() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0, tokens: [usdc: usdcUnits(500)]), for: oneUseAddress)
        await rig.wallet.tick()
        let fee = 2 * cheapFees.costWei(of: usdc)
        let gas = try #require(await rig.signer.signed.last)
        #expect(gas.to == oneUseAddress)
        #expect(gas.value == fee)
        #expect(rig.wallet.state.records[hotAddress]?.map(\.reason) == [.purchaseGas])
        #expect(rig.wallet.oneUseKeys.first?.gasSends == 1)

        await rig.wallet.tick()
        #expect(await rig.signer.signed.count == 1, "nothing more while the fee's on its way")
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .moving)
        #expect(rig.wallet.notices.allSatisfy { $0.text != HotWalletWording.purchaseNeedsGas })

        await rig.chain.confirmAll()
        await rig.chain.set(snapshot(eth: fee, tokens: [usdc: usdcUnits(500)]), for: oneUseAddress)
        await rig.wallet.tick()
        let move = try #require(await rig.signer.signed.last)
        #expect(move.to == usdc.contract)
        #expect(recipient(move) == coldAddress)
        #expect(rig.wallet.state.records[oneUseAddress]?.map(\.reason) == [.purchase])
    }

    @Test func spendingMoneyNeverPaysMoreThanItsShareOfFees() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0, tokens: [usdc: usdcUnits(500)]), for: oneUseAddress)
        // Each fee lands and the key still shows none, as if something kept taking it.
        for _ in 0..<(HotWallet.gasSendsPerKey + 3) {
            await rig.wallet.tick()
            await rig.chain.confirmAll()
            await rig.chain.set(snapshot())
            await rig.chain.set(snapshot(eth: 0, tokens: [usdc: usdcUnits(500)]), for: oneUseAddress)
        }
        #expect(await rig.signer.signed.filter { $0.to == oneUseAddress }.count == HotWallet.gasSendsPerKey)
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .needsGas)
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.purchaseNeedsGas })
    }

    @Test func withoutEthInSpendingMoneyItWaitsAndSaysSo() async throws {
        let rig = await Rig(snapshot(eth: 0), nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0, tokens: [usdc: usdcUnits(500)]), for: oneUseAddress)
        await rig.wallet.tick()
        #expect(await rig.signer.signed.isEmpty)
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .needsGas)
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.purchaseNeedsGas })
        #expect(await rig.signer.hasKey(oneUseAddress), "and the key stays while it holds anything")
    }

    @Test func aKeyNothingArrivedAtIsKeptForAWhileThenRetired() async throws {
        let clock = TestClock()
        let rig = await Rig(nextKeys: [oneUseAddress], portfolio: .success(keyHistory), now: { clock.now })
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0), for: oneUseAddress)
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        await rig.wallet.readOneUseHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(oneUseAddress), "a provider can deliver long after its page closed")

        clock.advance(HotWallet.unusedOneUseKeyLifetime + 1)
        await rig.wallet.tick()
        await rig.wallet.readOneUseHistory()
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(oneUseAddress) == false)
        #expect(rig.wallet.oneUseKeys.isEmpty)
    }

    @Test func itsKeptWhileItHoldsOtherTokensOrHistoryCantSay() async throws {
        let spam = "0x00000000000000000000000000000000000000f1"
        let clock = TestClock()
        let rig = await Rig(nextKeys: [oneUseAddress], portfolio: .success(portfolio(address: oneUseAddress, toBlock: 2000, unlisted: [spam])), now: { clock.now })
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0), for: oneUseAddress)
        clock.advance(HotWallet.unusedOneUseKeyLifetime + 1)
        await rig.wallet.tick()
        await rig.wallet.readOneUseHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(oneUseAddress))
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .otherTokens(1))
        #expect(rig.wallet.notices.contains { $0.text == HotWalletWording.purchaseKeyHoldsOtherTokens(1) })

        await rig.portfolios.set(.failure(.unreachable))
        await rig.wallet.readOneUseHistory()
        for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await rig.wallet.tick() }
        #expect(await rig.signer.hasKey(oneUseAddress))
        #expect(rig.wallet.oneUseHolds[oneUseAddress] == .cantCheckOtherTokens)
    }

    @Test func somethingTheKeySentThatThisAppDidntSignRaisesTheAlarm() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0, nonce: 1), for: oneUseAddress)
        for _ in 0..<HotWallet.readsBeforeAlarm { await rig.wallet.tick() }
        #expect(rig.wallet.alarm?.findings == [.oneUseKeySpent(address: oneUseAddress)])
        #expect(rig.wallet.alarm?.address == hotAddress, "it's Spending Money the alarm stops")
        #expect(rig.wallet.canTopUp == false)
    }

    @Test func historyShowingATransactionItDidntSignRaisesTheAlarm() async throws {
        let theirs = "0x" + String(repeating: "cd", count: 32)
        let clock = TestClock()
        let rig = await Rig(nextKeys: [oneUseAddress], portfolio: .success(portfolio(address: oneUseAddress, toBlock: 2000, outgoing: [theirs])), now: { clock.now })
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.chain.set(snapshot(eth: 0), for: oneUseAddress)
        clock.advance(HotWallet.unusedOneUseKeyLifetime + 1)
        await rig.wallet.tick()
        #expect(rig.wallet.alarm == nil)
        await rig.wallet.readOneUseHistory()
        #expect(rig.wallet.alarm?.findings == [.oneUseKeySpent(address: oneUseAddress)])
    }

    @Test func deletingSpendingMoneyLeavesAPurchaseOnItsWayToSavings() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        await rig.chain.set(snapshot(eth: 0), for: oneUseAddress)
        _ = try #require(await rig.wallet.createOneUseKey())
        await rig.wallet.deleteWallet()
        await rig.wallet.tick()
        #expect(rig.wallet.address == nil, "a one-use key never comes back as Spending Money")
        #expect(await rig.signer.hasKey(oneUseAddress))

        await rig.chain.set(snapshot(eth: oneEth / 10), for: oneUseAddress)
        await rig.wallet.tick()
        #expect(await rig.signer.signed.last?.to == coldAddress)
    }

    @Test func aPurchaseThatLandsWhileTheAppIsClosedStillMoves() async throws {
        let chain = FakeChain(snapshot())
        let signer = FakeSigner(keys: [hotAddress], next: [oneUseAddress])
        let store = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try store.save(state)
        let settings = MemorySettingsStore()
        var values = WalletSettings()
        values.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: Date()))
        settings.save(values)
        let make = { HotWallet(signer: signer, settingsStore: settings, stateStore: store, presence: FakePresence(allows: true), portfolioSource: { ScriptedPortfolios(.success(keyHistory)) }, makeChain: { _ in chain }) }

        let before = make()
        await before.tick()
        _ = try #require(await before.createOneUseKey())

        await chain.set(snapshot(eth: oneEth / 10), for: oneUseAddress)
        let after = make()
        #expect(after.oneUseKeys.map(\.address) == [oneUseAddress])
        #expect(after.linkedWallets.contains(oneUseAddress.lowercased))
        await after.tick()
        #expect(await signer.signed.last?.to == coldAddress)
        #expect(after.address == hotAddress)
    }

    @Test func aOneUseAddressIsntSomewhereToSendOrSaveTo() async throws {
        let rig = await Rig(nextKeys: [oneUseAddress])
        await rig.wallet.tick()
        _ = try #require(await rig.wallet.createOneUseKey())
        #expect(rig.wallet.problem(sendingTo: oneUseAddress) == .isARetiredKey)
        #expect(rig.wallet.problem(addingColdWallet: oneUseAddress) == .isARetiredKey)
    }
}

@Suite struct OneUseBuyPlanTests {
    private func holdings(eth: UInt128) -> [Holding] {
        [Holding(token: Base.eth, balance: eth, priceUsdMicros: ethPrice)]
    }

    @Test func allOfItGoesOnToSavings() {
        let plan = BuyPlan(usdMicros: 5000 * Money.dollar, token: Base.eth, priceUsdMicros: ethPrice, holdings: holdings(eth: 0), capUsdMicros: 100 * Money.dollar, roomUsdMicros: 80 * Money.dollar, fees: cheapFees, destination: coldAddress, throughOneUseKey: true)
        #expect(plan.isThroughOneUseKey)
        #expect(plan.fits == 0)
        #expect(plan.aboveCap == 5000 * Money.dollar)
        #expect(plan.problem == nil, "ETH pays for its own move, whatever Spending Money holds")
    }

    @Test func aTokenNeedsEthInSpendingMoneyForItsFee() {
        let none = BuyPlan(usdMicros: 5000 * Money.dollar, token: usdc, priceUsdMicros: Money.dollar, holdings: holdings(eth: 0), capUsdMicros: 100 * Money.dollar, roomUsdMicros: 80 * Money.dollar, fees: cheapFees, destination: coldAddress, throughOneUseKey: true)
        #expect(none.problem == .noGasToSweep)
        let enough = BuyPlan(usdMicros: 5000 * Money.dollar, token: usdc, priceUsdMicros: Money.dollar, holdings: holdings(eth: BuyPlan.gasForOneUseKey(usdc, fees: cheapFees)), capUsdMicros: 100 * Money.dollar, roomUsdMicros: 80 * Money.dollar, fees: cheapFees, destination: coldAddress, throughOneUseKey: true)
        #expect(enough.problem == nil)
    }

    @Test func withoutSavingsItsTheUsualPlan() {
        let plan = BuyPlan(usdMicros: 5000 * Money.dollar, token: Base.eth, priceUsdMicros: ethPrice, holdings: holdings(eth: 0), capUsdMicros: 100 * Money.dollar, roomUsdMicros: 80 * Money.dollar, fees: cheapFees, destination: nil, throughOneUseKey: true)
        #expect(plan.isThroughOneUseKey == false)
        #expect(plan.fits == 80 * Money.dollar)
    }
}
