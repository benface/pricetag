import Foundation
import Testing
@testable import PricetagKit

/// Hands back whatever portfolio it's told, and remembers the books it was sent.
actor BookSource: PortfolioSource {
    var portfolios: [Portfolio]
    private(set) var books: [Book] = []
    private(set) var previewed: [[Book]] = []
    var previewAnswers: [BookPreview] = []

    init(_ portfolios: [Portfolio]) {
        self.portfolios = portfolios
    }

    func answerPreviews(_ answers: [BookPreview]) {
        previewAnswers = answers
    }

    func portfolio(address: String, method: CostMethod, book: Book, timeout: Duration) async throws -> Portfolio {
        books.append(book)
        return portfolios.count > 1 ? portfolios.removeFirst() : portfolios[0]
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func previews(address: String, method: CostMethod, candidates: [Book]) async throws -> [BookPreview] {
        previewed.append(candidates)
        return previewAnswers
    }

    func importCoinbase(csv: String) async throws -> ExchangeImport {
        ExchangeImport(withdrawals: [ExchangeWithdrawal(exchange: "Coinbase", asset: "ETH", units: "1", at: "2026-11-04T00:00:00.000Z", costUsdMicros: "5", toAddress: nil)], skipped: 1)
    }

    func verifyLink(owner: String, address: String, signature: String) async throws -> Bool {
        signature == "good"
    }
}

@MainActor
@Suite struct ResolveTests {
    let wallet = "0x00000000000000000000000000000000000000aa"
    let sender = "0x00000000000000000000000000000000000000bb"

    func makeStore(_ portfolios: [Portfolio] = []) throws -> (PortfolioStore, BookSource, UserDefaults) {
        let defaults = UserDefaults(suiteName: "resolve-tests-\(UUID().uuidString)")!
        defaults.set(wallet, forKey: "wallet")
        let source = BookSource(portfolios.isEmpty ? [try demoPortfolio()] : portfolios)
        return (PortfolioStore(defaults: defaults, makeSource: { _ in source }), source, defaults)
    }

    @Test func readsTheQuestionsAndWhatsFlagged() throws {
        let portfolio = try demoPortfolio()
        #expect(!portfolio.questions.isEmpty)
        #expect(portfolio.meter.open == portfolio.questions.count)
        #expect(portfolio.noMarketPositions.map(\.asset) == ["DEGEN"])
        #expect(!portfolio.listedPositions.contains { $0.noMarket })
        #expect(portfolio.totals.noMarket == ["DEGEN"])
        let usdt = try #require(portfolio.positions.first { $0.asset == "USDT" })
        #expect(usdt.estimates.cost)
        let eth = try #require(portfolio.positions.first { $0.asset == "ETH" })
        #expect(eth.resolvable)
    }

    @Test func aTotalNeverAppearsBare() throws {
        let portfolio = try demoPortfolio()
        let caveat = try #require(Wording.headlineCaveat(portfolio.totals))
        #expect(caveat.contains("unresolved"))
        #expect(caveat.contains("estimated"))
        #expect(FeedSummary(feed: .live, portfolio: portfolio).text.contains("≈"))
    }

    @Test func saysWhatHasNoMarket() throws {
        let text = try #require(Wording.noMarket(try demoPortfolio()))
        #expect(text.contains("DEGEN"))
        #expect(text.contains("2 tokens"))
    }

    @Test func userWordingAvoidsTheJargon() {
        for label in ["paid", "inherited", "received at market", "self-reported"] {
            #expect(!Wording.costSource(label).contains("market"))
        }
        #expect(Wording.priceSource("oracle") == "price feed")
        #expect(Wording.priceSource("market") == "recent trades")
    }

    @Test func answersAreSentAlongAndKeptOnThisDevice() async throws {
        let (store, source, defaults) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: wallet))
        await _ = store.poll()
        #expect(await source.books.last?.senders[sender] == .someoneElse)
        let again = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        #expect(again.book.senders[sender] == .someoneElse)
    }

    @Test func undoGoesBackOneAnswerAtATime() throws {
        let (store, _, _) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: wallet))
        store.setBook(store.book.enteringCost("k", usdMicros: "5"))
        store.undo()
        #expect(store.book.costs.isEmpty)
        #expect(store.book.senders[sender] == .someoneElse)
        store.undo()
        #expect(store.book.isEmpty)
        #expect(store.undoStack.isEmpty)
        store.undo()
        #expect(store.book.isEmpty)
    }

    @Test func sayingASendersYoursLinksThisWalletToo() {
        let book = Book().answering(sender, .mine, focus: wallet)
        #expect(book.linkedWallets == [wallet, sender].sorted())
        #expect(Book().answering(sender, .mine, focus: WalletAddress.demo).linkedWallets == [sender])
        #expect(Book().answering(sender, .someoneElse, focus: wallet).linkedWallets.isEmpty)
    }

    @Test func aReadAnsweredForOtherAnswersIsThrownAway() async throws {
        let defaults = UserDefaults(suiteName: "resolve-tests-\(UUID().uuidString)")!
        defaults.set(wallet, forKey: "wallet")
        let source = GatedSource()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        let read = Task { await store.poll() }
        await source.waitUntilAsked()
        store.setBook(Book(costs: ["k": "1"]))
        store.stop()
        await source.answer(.success(try demoPortfolio()))
        await _ = read.value
        #expect(store.portfolio == nil, "those numbers are from before the answer")
    }

    @Test func aModelWalksThroughTheCards() async throws {
        let portfolio = try demoPortfolio()
        let (store, source, _) = try makeStore([portfolio])
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let first = try #require(model.current)
        #expect(first.id == portfolio.questions[0].id)
        await source.answerPreviews([BookPreview(pnlUsdMicros: "12400000", pnlStatus: .complete, estimatedUsdMicros: "0", unresolvedUsdMicros: "0", open: 0, pending: false), BookPreview(pnlUsdMicros: nil, pnlStatus: .unavailable, estimatedUsdMicros: "0", unresolvedUsdMicros: "5000000", open: 1, pending: false)])
        await model.loadPreviews()
        #expect(model.previews[.mine].map(Wording.consequence) == "+$12.40")
        #expect(model.previews[.someoneElse].map(Wording.consequence) == "PnL still unavailable")
        #expect(model.previews[.myExchange] == nil, "that answer asks for a cost before it changes anything")

        let asked = await source.previewed.last
        #expect(asked?.count == 2)
        #expect(asked?.first?.senders[try #require(first.sender)] == .mine)
        #expect(store.book.isEmpty, "a preview isn't an answer")

        model.skip()
        #expect(model.current?.id != first.id)
        #expect(model.skipped.contains(first.id))
        model.revisitSkipped()
        #expect(model.current?.id == first.id)

        model.answer(.someoneElse)
        #expect(store.book.senders[try #require(first.sender)] == .someoneElse)
        model.undo()
        #expect(store.book.isEmpty)

        model.answer(.myExchange)
        #expect(model.isAskingCost)
        #expect(store.book.senders[try #require(first.sender)]?.kind == .myExchange)
        #expect(!model.enterCost(["USDC": "nope"]), "not an amount")
        await source.answerPreviews([BookPreview(pnlUsdMicros: "1000000", pnlStatus: .complete, estimatedUsdMicros: "0", unresolvedUsdMicros: "0", open: 0, pending: false)])
        await model.previewCost(["USDC": "$1,234.50"])
        #expect(model.costPreview.map(Wording.consequence) == "+$1.00")
        #expect(store.book.senders[try #require(first.sender)]?.costs == nil, "typing isn't answering")
        await model.previewCost(["USDC": "nope"])
        #expect(model.costPreview == nil)
        #expect(model.enterCost(["USDC": "$1,234.50"]))
        #expect(store.book.senders[try #require(first.sender)]?.costs == ["USDC": "1234500000"])
    }

    @Test func aHoldingsQuestionsComeFirstWhenThatsWhatWasClicked() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store, firstAsset: "DAI")
        #expect(model.current?.arrivals.first?.asset == "DAI")
    }

    @Test func aCostQuestionKeepsItsCostOnThatMovement() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store, firstAsset: "DAI")
        let question = try #require(model.current)
        #expect(question.kind == .cost)
        #expect(model.enterCost(["DAI": "250"]))
        #expect(store.book.costs[try #require(question.costKey)] == "250000000")
    }

    @Test func importingKeepsWhatItFoundAndSaysWhatItCouldnt() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let imported = await model.importCoinbase(csv: "anything")
        #expect(imported?.withdrawals.count == 1)
        #expect(store.book.withdrawals.count == 1)
        #expect(model.failure?.contains("1 had no usable cost") == true)
    }

    @Test func aSignatureOnlyLinksWhenItHoldsUp() async throws {
        let (store, _, _) = try makeStore()
        #expect(try await store.linkProved(sender, signature: "bad") == false)
        #expect(store.book.isEmpty)
        #expect(try await store.linkProved(sender, signature: "good") == true)
        #expect(store.book.linkedWallets.contains(sender))
    }

    @Test func aPendingPreviewSaysSo() {
        #expect(Wording.consequence(BookPreview(pnlUsdMicros: nil, pnlStatus: .unavailable, estimatedUsdMicros: "0", unresolvedUsdMicros: "0", open: 0, pending: true)) == "Reading that wallet…")
    }

    @Test func aPartlyEstimatedOrUnresolvedConsequenceSaysSo() {
        #expect(Wording.consequence(BookPreview(pnlUsdMicros: "1000000", pnlStatus: .partial, estimatedUsdMicros: "5", unresolvedUsdMicros: "45000000", open: 1, pending: false)) == "≈+$1.00 · $45.00 unresolved")
    }

    @Test func readsDollarsAsTyped() {
        #expect(Format.micros(fromDollars: "$1,234.50") == "1234500000")
        #expect(Format.micros(fromDollars: "0") == "0")
        #expect(Format.micros(fromDollars: ".5") == "500000")
        #expect(Format.micros(fromDollars: "12.") == "12000000")
        #expect(Format.micros(fromDollars: "1.1234567") == "1123456")
        for bad in ["", "-5", "abc", "1.2.3", "1e5"] { #expect(Format.micros(fromDollars: bad) == nil, "\(bad)") }
    }

    @Test func signsTheSameWordsTheServerChecks() throws {
        struct Vector: Decodable { let owner: String; let address: String; let message: String }
        struct Vectors: Decodable { let linkMessage: Vector }
        let vector = try resource("format-vectors", as: Vectors.self).linkMessage
        #expect(Wording.linkMessage(owner: vector.owner, address: vector.address) == vector.message)
    }
}
