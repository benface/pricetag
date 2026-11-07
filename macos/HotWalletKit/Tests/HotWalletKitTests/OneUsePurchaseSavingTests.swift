import Foundation
import KeyVault
@testable import PricetagKit
import Testing
@testable import HotWalletKit

private final class SavingClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSince1970: 1_000_000)
    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

/// Coinbase as far as the tracker sees it: a page, then an order that succeeded with a hash and no block or cost yet.
private actor SucceededWithoutBlock: PortfolioSource {
    func portfolio(_ read: ReadContext, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation { throw FetchError.unreachable }
    func onrampCheckout(address: String, asset: String, cryptoAmount: String, fiat: PricetagKit.Money?) async throws -> OnrampCheckout {
        OnrampCheckout(url: "https://pay.coinbase.com/buy/select-asset?sessionToken=x", ref: "ref")
    }
    func onrampOrders(ref: String) async throws -> [OnrampOrder] {
        [OnrampOrder(id: "order", status: .succeeded, asset: "USDC", units: "500000000", wallet: oneUseAddress.lowercased, network: "base", txHash: "0x" + String(repeating: "ab", count: 32), blockNum: nil)]
    }
}

/// A one-use key's purchase has to be on disk, in the wallet's records or the tracker's, before anything could let the key go after a restart.
/// From WORK-465's third review: a failed save, then a dismissal, then a restart deleted the key of a delivery whose block was unknown.
@MainActor
@Suite struct OneUsePurchaseSavingTests {
    @MainActor private final class Setup {
        let clock = SavingClock()
        let chain = FakeChain(snapshot())
        let signer = FakeSigner(keys: [hotAddress], next: [oneUseAddress])
        let stateStore = MemoryStateStore()
        let settingsStore = MemorySettingsStore()
        let defaults: UserDefaults
        let portfolioStore: PortfolioStore

        init(suite: String) throws {
            var initial = DeviceWalletState()
            initial.active = hotAddress
            try stateStore.save(initial)
            var settings = WalletSettings()
            settings.add(ColdWallet(address: coldAddress, name: "Ledger", confirmedOnDeviceAt: clock.now))
            settingsStore.save(settings)
            defaults = try #require(UserDefaults(suiteName: suite))
            let orders = SucceededWithoutBlock()
            portfolioStore = PortfolioStore(defaults: defaults, makeSource: { _ in orders })
        }

        func wallet() -> HotWallet {
            let history = ScriptedPortfolios(.success(portfolio(address: oneUseAddress, toBlock: 2000)))
            let (clock, chain) = (clock, chain)
            return HotWallet(signer: signer, settingsStore: settingsStore, stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { history }, makeChain: { _ in chain }, now: { clock.now })
        }

        /// As MacApp wires it at launch: every tracked purchase first, then each change.
        func tracker(for wallet: HotWallet) -> PurchaseTracker {
            let clock = clock
            let tracker = PurchaseTracker(store: portfolioStore, defaults: defaults, now: { clock.now }, pollDelay: .milliseconds(1), matchOf: { _ in .waiting })
            for purchase in tracker.purchases { try? wallet.purchaseChanged(purchase, wallet: purchase.wallet) }
            tracker.onChange = { try wallet.purchaseChanged($1, wallet: $0) }
            return tracker
        }

        /// Long enough for the unused-key timeout, then empty reads and history, which is everything else a retirement needs.
        func waitOutEverything(_ wallet: HotWallet) async {
            clock.advance(HotWallet.unusedOneUseKeyLifetime + 1)
            await wallet.tick()
            await wallet.readOneUseHistory()
            for _ in 0..<(HotWallet.readsBeforeAlarm + 1) { await wallet.tick() }
        }
    }

    @Test func noPageOpensUntilTheKeyKnowsAPurchaseMayBeComing() async throws {
        let suite = "one-use-saving-\(UUID())"
        let setup = try Setup(suite: suite)
        defer { setup.defaults.removePersistentDomain(forName: suite) }
        let wallet = setup.wallet()
        await wallet.tick()
        _ = try #require(await wallet.createOneUseKey())
        await setup.chain.set(snapshot(eth: 0), for: oneUseAddress)
        let tracker = setup.tracker(for: wallet)

        setup.stateStore.failSaves(with: CocoaError(.fileWriteNoPermission))
        await #expect(throws: RecordsNotSaved.self) {
            _ = try await tracker.begin(wallet: oneUseAddress.lowercased, asset: "USDC", dollars: 500, cryptoAmount: "500")
        }
        #expect(tracker.purchases.isEmpty, "nobody saw a page, so there's nothing to follow")
        #expect(setup.stateStore.saved.oneUseKeys?.first?.delivery == .notStarted)

        // Nobody could have paid, so after a restart it's an unused key, and goes once it's been long enough.
        setup.stateStore.failSaves(with: nil)
        let after = setup.wallet()
        _ = setup.tracker(for: after)
        await setup.waitOutEverything(after)
        #expect(await !setup.signer.hasKey(oneUseAddress))
    }

    /// The reviewer's path, with saves failing only after the page opened: the row can't be hidden until the wallet's written down that it
    /// has an order, so a restart still has the purchase to replay, and the key stays.
    @Test func aRowIsOnlyHiddenOnceItsOrderIsWrittenDown() async throws {
        let suite = "one-use-saving-\(UUID())"
        let setup = try Setup(suite: suite)
        defer { setup.defaults.removePersistentDomain(forName: suite) }
        let wallet = setup.wallet()
        await wallet.tick()
        _ = try #require(await wallet.createOneUseKey())
        await setup.chain.set(snapshot(eth: 0), for: oneUseAddress)
        let tracker = setup.tracker(for: wallet)
        let page = try await tracker.begin(wallet: oneUseAddress.lowercased, asset: "USDC", dollars: 500, cryptoAmount: "500")
        #expect(page.host() == "pay.coinbase.com")
        #expect(setup.stateStore.saved.oneUseKeys?.first?.delivery == .expected, "on disk before the page opens")

        setup.stateStore.failSaves(with: CocoaError(.fileWriteNoPermission))
        await tracker.check()
        let row = try #require(tracker.purchases.first)
        #expect(tracker.phase(of: row) == .costNotSaid)
        #expect(wallet.oneUseKeys.first?.delivery == .ordered)
        tracker.dismiss(row)
        #expect(tracker.purchases.count == 1, "kept, since the wallet couldn't write its order down")
        #expect(tracker.problem == PurchaseWording.cantForgetYet)

        // Quit before a save works. On restart the disk is writable again, and the tracker still has the purchase to tell the wallet.
        setup.stateStore.failSaves(with: nil)
        let after = setup.wallet()
        let trackerAfter = setup.tracker(for: after)
        #expect(trackerAfter.purchases.count == 1)
        #expect(setup.stateStore.saved.oneUseKeys?.first?.delivery == .ordered)
        await setup.waitOutEverything(after)
        #expect(await setup.signer.hasKey(oneUseAddress), "an order with no block yet keeps its key")

        // Now it can be hidden, and the key still waits for its delivery.
        trackerAfter.dismiss(try #require(trackerAfter.purchases.first))
        #expect(trackerAfter.purchases.isEmpty)
        await setup.waitOutEverything(after)
        #expect(await setup.signer.hasKey(oneUseAddress))
    }

    /// Saying nothing was bought, from a page with no order, lets the key time out, but only once that's on disk.
    @Test func sayingNothingWasBoughtOnlyCountsOnceItsWrittenDown() async throws {
        let suite = "one-use-saving-\(UUID())"
        let setup = try Setup(suite: suite)
        defer { setup.defaults.removePersistentDomain(forName: suite) }
        let wallet = setup.wallet()
        await wallet.tick()
        _ = try #require(await wallet.createOneUseKey())
        await setup.chain.set(snapshot(eth: 0), for: oneUseAddress)
        let tracker = setup.tracker(for: wallet)
        _ = try await tracker.begin(wallet: oneUseAddress.lowercased, asset: "USDC", dollars: 500, cryptoAmount: "500")
        let row = try #require(tracker.purchases.first)

        setup.stateStore.failSaves(with: CocoaError(.fileWriteNoPermission))
        tracker.dismiss(row)
        #expect(tracker.purchases.count == 1)
        #expect(wallet.oneUseKeys.first?.delivery == .expected)

        setup.stateStore.failSaves(with: nil)
        tracker.dismiss(row)
        #expect(tracker.purchases.isEmpty)
        #expect(setup.stateStore.saved.oneUseKeys?.first?.delivery == .notStarted)
        await setup.waitOutEverything(wallet)
        #expect(await !setup.signer.hasKey(oneUseAddress), "an unused key goes once it's been long enough")
    }
}
