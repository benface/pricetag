import Foundation
@testable import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let wallet = hotAddress
private let router = EthereumAddress("0x2626664c2603336e57b271c5c0b26f421741e481")!
private let eth = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
private let scamToken = EthereumAddress("0x5555555555555555555555555555555555555555")!

private func topic(_ signature: String) -> String { "0x" + Hex.encode(keccak256(Array(signature.utf8))) }
private func word(_ address: EthereumAddress) -> String { "0x" + String(repeating: "0", count: 24) + address.lowercased.dropFirst(2) }
private func amountData(_ amount: UInt128) -> String {
    let digits = String(amount, radix: 16)
    return "0x" + String(repeating: "0", count: 64 - digits.count) + digits
}

private func log(_ address: String, _ signature: String, _ topics: [String], data: String) -> JSONValue {
    .object(["address": .string(address), "topics": .array(([topic(signature)] + topics).map { .string($0) }), "data": .string(data)])
}

private func transfer(_ token: String, from: EthereumAddress, to: EthereumAddress, _ amount: UInt128) -> JSONValue {
    log(token, "Transfer(address,address,uint256)", [word(from), word(to)], data: amountData(amount))
}

private func approval(_ token: String, spender: EthereumAddress, data: String) -> JSONValue {
    log(token, "Approval(address,address,uint256)", [word(wallet), word(spender)], data: data)
}

private func simulated(_ logs: [JSONValue], status: String = "0x1") -> JSONValue {
    .array([.object(["timestamp": .string("0x6aec0daf"), "calls": .array([.object(["status": .string(status), "logs": .array(logs)])])])])
}

private func preview(_ logs: [JSONValue], value: UInt128 = 0, price: (Token) -> UInt128? = { _ in nil }) -> CallPreview? {
    CallSimulation(simulated(logs), wallet: wallet, value: value)?.preview(price: price)
}

private func known(_ text: String, _ symbol: String, usd: UInt128? = nil) -> CallPreview.Asset {
    .known(ReviewAmount(text: text, symbol: symbol, usdMicros: usd))
}

private let usdcText = usdc.contract!.lowercased
private let wethText = weth.contract!.lowercased

@Suite struct CallSimulationTests {
    @Test func aSwapGivesOneThingAndGetsAnother() {
        let swap = preview([transfer(usdcText, from: wallet, to: router, 200_000_000), transfer(eth, from: router, to: wallet, oneEth / 10)]) { $0 == usdc ? Money.dollar : ethPrice }
        #expect(swap?.gives == [known("200", "USDC", usd: 200 * Money.dollar)])
        #expect(swap?.gets == [known("0.1", "ETH", usd: 300 * Money.dollar)])
    }

    /// What `mainnet.base.org` answered on 2026-11-04 for a swap of ETH to USDC through Uniswap, which goes by way of WETH.
    @Test func whatPassesThroughOtherAccountsDoesntCount() {
        let pool = EthereumAddress("0xd0b53d9277642d899df5c87a3966a349a798f224")!
        let swap = preview([
            transfer(eth, from: wallet, to: router, oneEth / 100),
            transfer(usdcText, from: pool, to: wallet, 24_200_000),
            transfer(eth, from: router, to: weth.contract!, oneEth / 100),
            log(wethText, "Deposit(address,uint256)", [word(router)], data: amountData(oneEth / 100)),
            transfer(wethText, from: router, to: pool, oneEth / 100),
        ], value: oneEth / 100)
        #expect(swap?.gives == [known("0.01", "ETH")])
        #expect(swap?.gets == [known("24.2", "USDC")])
    }

    @Test func wrappingOnlySaysDepositAndWithdrawal() {
        let wrap = preview([transfer(eth, from: wallet, to: weth.contract!, oneEth), log(wethText, "Deposit(address,uint256)", [word(wallet)], data: amountData(oneEth))], value: oneEth)
        #expect(wrap?.gives == [known("1", "ETH")])
        #expect(wrap?.gets == [known("1", "WETH")])
        let unwrap = preview([log(wethText, "Withdrawal(address,uint256)", [word(wallet)], data: amountData(oneEth)), transfer(eth, from: weth.contract!, to: wallet, oneEth)])
        #expect(unwrap?.gives == [known("1", "WETH")])
        #expect(unwrap?.gets == [known("1", "ETH")])
    }

    @Test func aDepositFromAnotherContractIsntWETH() {
        let fake = preview([log(scamToken.lowercased, "Deposit(address,uint256)", [word(wallet)], data: amountData(oneEth))])
        #expect(fake?.gets == [])
    }

    @Test func aRefundIsNetted() {
        let refunded = preview([transfer(eth, from: wallet, to: router, oneEth), transfer(eth, from: router, to: wallet, oneEth / 4)], value: oneEth)
        #expect(refunded?.gives == [known("0.75", "ETH")])
        #expect(refunded?.gets == [])
    }

    @Test func tokensOffTheAllowlistAreUnknownWhateverTheyCallThemselves() {
        let result = preview([
            transfer(scamToken.lowercased, from: router, to: wallet, oneEth),
            log(scamToken.lowercased, "Transfer(address,address,uint256)", [word(wallet), word(router)], data: amountData(5)),
        ])
        #expect(result?.gets == [.unknown(contract: scamToken)])
        #expect(result?.gives == [.unknown(contract: scamToken)])
    }

    @Test func dustThatMovesNothingIsLeftOut() {
        #expect(preview([transfer(scamToken.lowercased, from: wallet, to: router, 0)])?.gives == [])
    }

    @Test func itemsCountAsUnknown() {
        let tokenID = "0x" + String(repeating: "0", count: 63) + "7"
        let single = preview([log(scamToken.lowercased, "Transfer(address,address,uint256)", [word(wallet), word(router), tokenID], data: "0x")])
        #expect(single?.gives == [.unknown(contract: scamToken)])
        let multi = preview([log(scamToken.lowercased, "TransferBatch(address,address,address,uint256[],uint256[])", [word(router), word(wallet), word(router)], data: "0x")])
        #expect(multi?.gives == [.unknown(contract: scamToken)])
    }

    @Test func anAllowanceThatsLeftOverIsShown() {
        let limited = preview([approval(usdcText, spender: router, data: amountData(5_000_000))])
        #expect(limited?.allowances.map(\.words) == ["up to 5 USDC"])
        #expect(limited?.allowances.first?.isUnlimited == false)

        let unlimited = preview([approval(usdcText, spender: router, data: "0x" + String(repeating: "f", count: 64))])
        #expect(unlimited?.allowances.map(\.words) == ["all of your USDC"])
        #expect(unlimited?.allowances.first?.isUnlimited == true)

        let used = preview([approval(usdcText, spender: router, data: amountData(5_000_000)), approval(usdcText, spender: router, data: amountData(0))])
        #expect(used?.allowances == [])

        let everyItem = preview([log(scamToken.lowercased, "ApprovalForAll(address,address,bool)", [word(wallet), word(router)], data: amountData(1))])
        #expect(everyItem?.allowances.first?.isUnlimited == true)

        let someoneElses = preview([log(usdcText, "Approval(address,address,uint256)", [word(router), word(wallet)], data: amountData(1))])
        #expect(someoneElses?.allowances == [])
    }

    @Test func anyAnswerThatIsntClearIsNoAnswer() {
        // It failed.
        #expect(CallSimulation(simulated([], status: "0x0"), wallet: wallet, value: 0) == nil)
        #expect(CallSimulation(.array([]), wallet: wallet, value: 0) == nil)
        #expect(CallSimulation(.string("0xread"), wallet: wallet, value: 0) == nil)
        // A node that doesn't report ETH can't be trusted on what comes back.
        #expect(preview([], value: 1) == nil)
        // A transfer that doesn't say what moved could hide what's leaving.
        #expect(preview([log(usdcText, "Transfer(address,address,uint256)", [word(wallet)], data: amountData(1))]) == nil)
        #expect(preview([log(scamToken.lowercased, "Transfer(address,address,uint256)", [], data: "0x")]) == nil)
        #expect(preview([log(usdcText, "Transfer(address,address,uint256)", [word(wallet), word(router)], data: "0x")]) == nil)
        // More than anything's worth, from a token that's meant to be sane.
        #expect(preview([log(usdcText, "Transfer(address,address,uint256)", [word(wallet), word(router)], data: "0x" + String(repeating: "f", count: 64))]) == nil)
    }

    @Test func itAsksAboutWhatWouldReallyBeSigned() {
        let transaction = SiteTransaction(to: router, value: 16, data: [0x12, 0x34])
        let parameters = CallSimulation.parameters(transaction, from: wallet, nonce: 7, gasLimit: 90000, fees: cheapFees)
        let options = parameters[0]
        #expect(options?["traceTransfers"] == .bool(true))
        #expect(options?["validation"] == .bool(true))
        #expect(parameters[1] == .string("latest"))
        let call = options?["blockStateCalls"]?[0]?["calls"]?[0]
        #expect(call?["from"]?.string == wallet.lowercased)
        #expect(call?["to"]?.string == router.lowercased)
        #expect(call?["value"]?.string == "0x10")
        #expect(call?["data"]?.string == "0x1234")
        #expect(call?["nonce"]?.string == "0x7")
        #expect(call?["gas"]?.string == "0x15f90")
        #expect(call?["maxFeePerGas"]?.string == "0x989680")
    }
}

/// Through `HotWallet.quoteForSite`, the way a request gets there.
@MainActor
@Suite struct CallPreviewReviewTests {
    private let swapLogs = [transfer(usdcText, from: wallet, to: router, 200_000_000), transfer(eth, from: router, to: wallet, oneEth / 10)]
    private let unreadable = SiteTransaction(to: router, value: 0, data: [0x12, 0x34, 0x56, 0x78])

    private func hotWallet(_ chain: any ChainClient) throws -> HotWallet {
        let stateStore = MemoryStateStore()
        var state = DeviceWalletState()
        state.active = hotAddress
        try stateStore.save(state)
        return HotWallet(signer: FakeSigner(keys: [hotAddress], next: [nextAddress]), settingsStore: MemorySettingsStore(), stateStore: stateStore, presence: FakePresence(allows: true), portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) }, makeChain: { _ in chain }, readRetryDelay: .zero)
    }

    private func quoted(_ transaction: SiteTransaction, chain: any ChainClient) async throws -> TransactionReview {
        TransactionReview(transaction, quote: try await hotWallet(chain).quoteForSite(transaction))
    }

    @Test func aCallItCantReadSaysWhatItWouldDoInstead() async throws {
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated(swapLogs)))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.preview?.gives == [known("200", "USDC", usd: 200 * Money.dollar)])
        #expect(review.preview?.gets == [known("0.1", "ETH", usd: 300 * Money.dollar)])
        #expect(review.warnings.map(\.text) == [SiteWording.previewIsAnEstimate])
        // What Touch ID asks about only says what's certain.
        #expect(review.promptWords == "make a contract call")
    }

    @Test func aFailedSimulationFallsBackToTodaysWording() async throws {
        for answer: RPCAnswer in [.failure(SiteError(code: -32601, message: "no such method")), .success(simulated([], status: "0x0")), .success(.string("nonsense"))] {
            let chain = FakeChain(snapshot())
            await chain.setSimulation(answer)
            let review = try await quoted(unreadable, chain: chain)
            #expect(review.preview == nil)
            #expect(review.warnings.map(\.text) == [SiteWording.unreadableCall])
        }
    }

    @Test func aNodeThatCantBeReachedFallsBackToo() async throws {
        struct Unreachable: ChainClient {
            let fake: FakeChain
            func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot { try await fake.snapshot(of: address) }
            func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 { 60000 }
            func send(_ transaction: SignedTransaction) async throws {}
            func receipt(of hash: String) async throws -> Receipt? { nil }
            func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer { throw ChainError.unreachable }
            func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 { 1 }
        }
        let review = try await quoted(unreadable, chain: Unreachable(fake: FakeChain(snapshot())))
        #expect(review.warnings.map(\.text) == [SiteWording.unreadableCall])
    }

    @Test func whatItCanAlreadyReadIsntSimulated() async throws {
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated(swapLogs)))
        let send = SiteTransaction(to: usdc.contract!, value: 0, data: Calldata.transfer(to: nextAddress, amount: 5))
        let review = try await quoted(send, chain: chain)
        #expect(review.preview == nil)
        #expect(await chain.reads.isEmpty)
    }

    @Test func itNeverRelaxesAStrongWarning() async throws {
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated(swapLogs)))
        let burn = SiteTransaction(to: .zero, value: 0, data: [0x12, 0x34, 0x56, 0x78])
        let review = try await quoted(burn, chain: chain)
        #expect(review.preview != nil)
        #expect(review.warnings.first == SiteWarning(SiteWording.burn, isStrong: true))
        #expect(review.warnings.contains(SiteWarning(SiteWording.previewIsAnEstimate)))
    }

    @Test func notHoldingEnoughEthStillSaysSo() async throws {
        let chain = FakeChain(snapshot(eth: 1))
        await chain.setSimulation(.success(simulated(swapLogs)))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.warnings.contains(SiteWarning(SiteWording.notEnoughEth)))
    }

    @Test func anUnlimitedAllowanceInACallTakesSayingYouTrustIt() async throws {
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated([approval(usdcText, spender: router, data: "0x" + String(repeating: "f", count: 64))])))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.warnings.first?.isStrong == true)
        #expect(review.warnings.first?.text.contains("all of your USDC") == true)
    }

    @Test func anUnknownTokenIsFlaggedAndNeverPriced() async throws {
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated([transfer(scamToken.lowercased, from: router, to: wallet, oneEth)])))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.preview?.gets == [.unknown(contract: scamToken)])
        #expect(review.warnings.contains(SiteWarning(SiteWording.previewHasUnknownToken)))
    }

    @Test func aTokenThatIsntHeldStillGetsItsPriceFromItsFeed() async throws {
        let degen = token("DEGEN")
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated([transfer(degen.contract!.lowercased, from: router, to: wallet, oneEth * 1000)])))
        // roundId, answer of $0.01 in 8 decimals, startedAt, updatedAt at the simulated block's time, answeredInRound.
        let words = [amountData(1), amountData(1_000_000), amountData(0x6aec0daf), amountData(0x6aec0daf), amountData(1)]
        await chain.setFeedRound(.success(.string("0x" + words.map { $0.dropFirst(2) }.joined())))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.preview?.gets == [known("1000", "DEGEN", usd: 10 * Money.dollar)])
    }

    @Test func aTokenWithNoReadablePriceHasNone() async throws {
        let degen = token("DEGEN")
        let chain = FakeChain(snapshot())
        await chain.setSimulation(.success(simulated([transfer(degen.contract!.lowercased, from: router, to: wallet, oneEth * 1000)])))
        let review = try await quoted(unreadable, chain: chain)
        #expect(review.preview?.gets == [known("1000", "DEGEN")])
    }

    @Test func sitesCantAskForASimulationThemselves() {
        #expect(!SiteBridge.reads.contains(CallSimulation.method))
    }
}
