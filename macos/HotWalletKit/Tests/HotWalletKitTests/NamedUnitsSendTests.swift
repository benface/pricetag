import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let friend = EthereumAddress("0x3333333333333333333333333333333333333333")!
private let first = "2026-01-02T00:00:00.000Z"
private let second = "2026-03-04T00:00:00.000Z"
private let held = HeldByAsset(assets: ["USDC": HeldUnits(purchases: [
    .init(boughtAt: first, units: String(usdcUnits(10)), costMicros: "10000000", allOnly: false),
    .init(boughtAt: second, units: String(usdcUnits(10)), costMicros: nil, allOnly: false),
], unnamed: "0")])

/// A send from spending money that names the units it takes, as it's signed.
@MainActor
@Suite struct NamingASendsUnitsTests {
    private func model(_ read: Result<HeldByAsset, FetchError>, canName: Bool = true) async -> (SendModel, PortfolioStore, UserDefaults, Rig) {
        let rig = await Rig(snapshot(eth: oneEth / 200, tokens: [usdc: usdcUnits(20)]))
        await rig.wallet.tick()
        let source = ScriptedPortfolios(.success(portfolio()))
        await source.setHeld(read)
        let defaults = UserDefaults(suiteName: "named-units-\(UUID().uuidString)")!
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        let model = SendModel(wallet: rig.wallet, store: store, canName: canName)
        model.token = usdc
        model.amountText = "5"
        model.addressText = friend.lowercased
        return (model, store, defaults, rig)
    }

    private func read(_ model: SendModel) async throws {
        for _ in 0..<400 where model.held == .reading { try await Task.sleep(for: .milliseconds(5)) }
    }

    @Test func onlyUnderUSRules() async {
        let (model, store, _, _) = await model(.success(held), canName: false)
        defer { store.stop() }
        model.startNaming()
        #expect(!model.naming)
        #expect(model.canSend)
    }

    @Test func doesntSendWhileReadingOrWhenItCantRead() async throws {
        let (model, store, _, _) = await model(.failure(.unreachable))
        defer { store.stop() }
        model.startNaming()
        #expect(!model.canSend, "not while it's reading")
        try await read(model)
        #expect(model.held == .failed)
        #expect(!model.canSend, "not without the choice someone opened this to make")
        model.stopNaming()
        #expect(model.canSend, "Don't Choose sends the usual way")
        #expect(await model.send())
        #expect(store.book.unitChoices.isEmpty)
    }

    @Test func sendsWithTheChoiceAndKeepsItAcrossARelaunch() async throws {
        let (model, store, defaults, rig) = await model(.success(held))
        defer { store.stop() }
        model.startNaming()
        try await read(model)
        #expect(model.held == .read(try #require(held.assets["USDC"])))
        #expect(!model.canSend, "nothing's picked")
        model.picked[first] = "2"
        #expect(model.namingProblem == "Those add up to 2 USDC, and this sends 5 USDC.")
        #expect(!model.canSend)
        model.picked[second] = "3"
        #expect(model.namingProblem == nil)
        #expect(model.canSend)
        model.confirm()
        #expect(model.namedSummary == "2 USDC bought \(NamedUnits.shown(first))\n3 USDC bought \(NamedUnits.shown(second))")
        let before = NamedUnits.moment(.now)
        #expect(await model.send())
        let hash = try #require(rig.wallet.lastSubmitted.last)
        let choice = try #require(store.book.unitChoices.first)
        #expect(store.book.unitChoices.count == 1)
        #expect(choice.wallet == rig.wallet.address?.lowercased)
        #expect(choice.txHash == hash.lowercased())
        #expect(choice.asset == "USDC")
        #expect(choice.takes == [.init(boughtAt: first, units: "2000000"), .init(boughtAt: second, units: "3000000")])
        #expect(choice.recordedAt >= before && choice.recordedAt <= NamedUnits.moment(.now))
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in ScriptedPortfolios(.failure(.unreachable)) })
        defer { reopened.stop() }
        #expect(reopened.book.unitChoices == [choice])
    }

    @Test func anotherTokenStartsOver() async throws {
        let (model, store, _, _) = await model(.success(held))
        defer { store.stop() }
        model.startNaming()
        try await read(model)
        model.picked[first] = "5"
        #expect(model.canSend)
        model.token = Base.eth
        #expect(model.picked.isEmpty)
        #expect(model.held == .read(HeldUnits(purchases: [], unnamed: "0")))
    }
}
