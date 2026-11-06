import Foundation
import Testing
@testable import PricetagKit


/// Hands back whatever portfolio it's told, and remembers the books it was sent.
actor BookSource: PortfolioSource {
    var portfolios: [Portfolio]
    private(set) var books: [Book] = []
    private(set) var previewed: [[Book]] = []
    private(set) var previewRules: [String?] = []
    var previewAnswers: [BookPreview] = []
    private var importAnswer = ExchangeImport(withdrawals: [ExchangeWithdrawal(exchange: "Coinbase", asset: "ETH", units: "1", at: "2026-11-04T00:00:00.000Z", cost: Money(micros: "5", currency: .USD), toAddress: nil)], skipped: 1)
    /// How long each of the next previews says to wait, instead of answering.
    var previewRefusals: [Int] = []

    init(_ portfolios: [Portfolio]) {
        self.portfolios = portfolios
    }

    func answerPreviews(_ answers: [BookPreview]) {
        previewAnswers = answers
    }

    func refusePreviews(retryAfter: Int) {
        previewRefusals.append(retryAfter)
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        books.append(book)
        return portfolios.count > 1 ? portfolios.removeFirst() : portfolios[0]
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        previewed.append(candidates)
        previewRules.append(rule)
        if !previewRefusals.isEmpty { throw FetchError.rateLimited("Too many requests.", retryAfter: previewRefusals.removeFirst()) }
        return previewAnswers
    }

    func exportCSV(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], shown: [String]?, book: Book) async throws -> String {
        books.append(book)
        return ""
    }

    func comparison(address: String, method: CostMethod, currency: CurrencyCode, linked: [String], book: Book) async throws -> RuleComparison {
        books.append(book)
        throw FetchError.unreachable
    }

    func importCoinbase(csv: String) async throws -> ExchangeImport {
        importAnswer
    }

    func answerImports(_ answer: ExchangeImport) {
        importAnswer = answer
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
        let caveat = try #require(Wording.headlineCaveat(portfolio.totals, portfolio.currency))
        #expect(caveat.contains("cost unknown"))
        #expect(caveat.contains("estimated"))
        #expect(FeedSummary(feed: .live, portfolio: portfolio, shows: .pnl).text.contains("≈"))
        #expect(FeedSummary(feed: .live, portfolio: portfolio, shows: .value).text.contains("≈") == portfolio.totals.estimated.value)
    }

    @Test func saysWhatHasNoMarket() throws {
        let text = try #require(Wording.noMarket(try demoPortfolio()))
        #expect(text.contains("DEGEN"))
        #expect(text.contains("3 tokens"))
    }

    @Test func answersAreSentAlongAndKeptOnThisDevice() async throws {
        let (store, source, defaults) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: wallet))
        await _ = store.poll()
        #expect(await source.books.last?.senders[sender] == .someoneElse)
        let again = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        #expect(again.book.senders[sender] == .someoneElse)
    }

    @Test func previewsGoByTheRuleOnScreen() async throws {
        let (store, source, _) = try makeStore()
        store.setRule("cautious-eth")
        _ = try await store.previews(of: [Book()])
        #expect(await source.previewRules == ["cautious-eth"])
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        for _ in 0..<200 where !condition() { try await Task.sleep(for: .milliseconds(5)) }
        #expect(condition())
    }

    @Test func previewsASlowedDownServerRefusedComeBackByThemselves() async throws {
        let portfolio = try demoPortfolio()
        let (store, source, _) = try makeStore([portfolio])
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let answer = BookPreview(pnlMicros: "12400000", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false)
        await source.answerPreviews([answer, answer])
        await source.refusePreviews(retryAfter: 5)
        let load = Task { await model.loadPreviews() }
        try await waitUntil { model.previewsAreHeldBack }
        #expect(model.previews.isEmpty)
        #expect(!model.costPreviewIsHeldBack, "the cost being typed isn't what's waiting")
        try await Task.sleep(for: .milliseconds(100))
        #expect(await source.previewed.count == 1, "nothing asks again until it's time")
        await load.value
        #expect(await source.previewed.count == 2)
        #expect(!model.previewsAreHeldBack)
        #expect(model.previews[.mine] == answer)
    }

    @Test func aHeldBackPreviewStopsWhenTheQuestionMovesOn() async throws {
        let (store, source, _) = try makeStore([try demoPortfolio()])
        await _ = store.poll()
        let model = ResolveModel(store: store)
        await source.refusePreviews(retryAfter: 60)
        let load = Task { await model.loadPreviews() }
        try await waitUntil { model.previewsAreHeldBack }
        model.skip()
        load.cancel()
        await load.value
        #expect(!model.previewsAreHeldBack)
        #expect(await source.previewed.count == 1)
    }

    @Test func aTypedCostWaitsOutARefusalAndGoesByTheLatestTyping() async throws {
        let (store, source, _) = try makeStore([try demoPortfolio()])
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let question = try #require(model.current)
        let typed = { (amount: String) in Dictionary(uniqueKeysWithValues: question.arrivals.map { ($0.asset, amount) }) }
        let answer = BookPreview(pnlMicros: "12400000", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false)
        await source.answerPreviews([answer])
        // What's on screen is about the amount before this one.
        await model.previewCost(typed("1"))
        #expect(model.costPreview == answer)
        await source.refusePreviews(retryAfter: 5)
        let first = Task { await model.previewCost(typed("2")) }
        try await waitUntil { model.costPreviewIsHeldBack }
        #expect(model.costPreview == nil, "that was for a different amount")
        #expect(!model.previewsAreHeldBack)
        first.cancel()
        await first.value
        let second = Task { await model.previewCost(typed("3")) }
        try await waitUntil { model.costPreviewIsHeldBack }
        #expect(await source.previewed.count == 2, "typing more doesn't ask a server that's said to wait")
        await second.value
        #expect(!model.costPreviewIsHeldBack)
        #expect(model.costPreview == answer)
        let asked = await source.previewed
        #expect(asked.count == 3)
        #expect(asked[2] != asked[1], "it asked about what's typed now")
    }

    @Test func undoGoesBackOneAnswerAtATime() throws {
        let (store, _, _) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: wallet))
        store.setBook(store.book.enteringCost("k", Money(micros: "5", currency: .USD)))
        store.undo()
        #expect(store.book.costs.isEmpty)
        #expect(store.book.senders[sender] == .someoneElse)
        store.undo()
        #expect(store.book.isEmpty)
        #expect(store.undoStack.isEmpty)
        store.undo()
        #expect(store.book.isEmpty)
    }

    @Test func redoBringsBackWhatUndoTookAndSaysWhatEachDoes() throws {
        let (store, _, _) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: wallet))
        store.setBook(Book(), action: "Forget All Answers")
        #expect(store.undoNames == ["Answer", "Forget All Answers"])
        store.undo()
        #expect(store.book.senders[sender] == .someoneElse)
        #expect(store.redoNames == ["Forget All Answers"])
        store.redo()
        #expect(store.book.isEmpty)
        #expect(store.undoNames == ["Answer", "Forget All Answers"])
        #expect(store.redoStack.isEmpty)
        store.undo()
        // Something new happening means there's nothing left to redo.
        store.setBook(store.book.enteringCost("k", Money(micros: "5", currency: .USD)))
        #expect(store.redoStack.isEmpty)
        store.redo()
        #expect(store.book.costs["k"] != nil)
        #expect(store.undoNames == ["Answer", "Answer"])
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
        store.setBook(Book(costs: ["k": Money(micros: "1", currency: .USD)]))
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
        await source.answerPreviews([BookPreview(pnlMicros: "12400000", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false), BookPreview(pnlMicros: nil, pnlStatus: .unavailable, estimatedMicros: "0", unresolvedMicros: "5000000", open: 1, pending: false, failed: false)])
        await model.loadPreviews()
        #expect(model.previews[.mine].map { Wording.consequence($0, .USD) } == "+$12.40")
        #expect(model.previews[.someoneElse].map { Wording.consequence($0, .USD) } == "PnL still unavailable")
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
        await source.answerPreviews([BookPreview(pnlMicros: "1000000", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false)])
        await model.previewCost(["USDC": "$1,234.50"])
        #expect(model.costPreview.map { Wording.consequence($0, .USD) } == "+$1.00")
        #expect(store.book.senders[try #require(first.sender)]?.costs == nil, "typing isn't answering")
        await model.previewCost(["USDC": "nope"])
        #expect(model.costPreview == nil)
        #expect(model.enterCost(["USDC": "$1,234.50"]))
        let firstSender = try #require(first.sender)
        let cost = try #require(store.book.senders[firstSender]?.costs?.first)
        #expect(cost.micros == "1234500000")
        #expect(cost.currency == .USD)
        #expect(cost.asset == "USDC")
        #expect(cost.receipts == first.receipts, "it covers what had arrived, and nothing that comes later")
    }

    @Test func isntBalancedWhileAWalletIsStillBeingRead() {
        #expect(Meter(open: 0, answered: 2, waiting: 0).isBalanced)
        #expect(!Meter(open: 0, answered: 2, waiting: 1).isBalanced)
        #expect(!Meter(open: 1, answered: 2, waiting: 0).isBalanced)
        #expect(!Meter(open: 0, answered: 0, waiting: 0).isBalanced)
    }

    @Test func anExchangeCostKeepsWhatEarlierAnswersCovered() throws {
        let earlier = CostReceipt(wallet: wallet, legId: "0x1:USDC", asset: "USDC", units: "5")
        let later = CostReceipt(wallet: wallet, legId: "0x2:USDC", asset: "USDC", units: "7")
        let other = CostReceipt(wallet: wallet, legId: "0x3:ETH", asset: "ETH", units: "9")
        let first = Book().enteringExchangeCosts(sender, receipts: [earlier], amounts: ["USDC": Money(micros: "1", currency: .USD)], focus: wallet)
        let second = first.enteringExchangeCosts(sender, receipts: [later, other], amounts: ["USDC": Money(micros: "2", currency: .CAD), "ETH": Money(micros: "3", currency: .CAD)], focus: wallet)
        let costs = try #require(second.senders[sender]?.costs)
        #expect(costs.map(\.micros) == ["1", "3", "2"])
        #expect(costs.map(\.receipts) == [[earlier], [other], [later]], "each asset's cost only covers its own")
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
        #expect(store.book.costs[try #require(question.costKey)] == Money(micros: "250000000", currency: .USD))
    }

    @Test func importingKeepsWhatItFoundAndSaysWhatItCouldnt() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let imported = await model.importCoinbase(csv: "anything")
        #expect(imported?.withdrawals.count == 1)
        #expect(store.book.withdrawals.count == 1)
        #expect(model.lastImport?.skipped == 1)
        #expect(model.lastImport?.needsALook == true)
        #expect(model.failure == nil)
    }

    private func withdrawal(_ at: String, cost: String = "5", to: String? = nil) -> ExchangeWithdrawal {
        ExchangeWithdrawal(exchange: "Coinbase", asset: "ETH", units: "1", at: at, cost: Money(micros: cost, currency: .USD), toAddress: to)
    }

    @Test func aLaterImportAddsToAnEarlierOne() {
        let (earlier, later) = (withdrawal("2025-06-01T00:00:00.000Z"), withdrawal("2026-06-01T00:00:00.000Z"))
        #expect(Book(withdrawals: [earlier]).importing([later]).withdrawals == [earlier, later])
    }

    @Test func importingTheSameFileTwiceChangesNothing() {
        let (one, alike) = (withdrawal("2026-06-01T00:00:00.000Z"), withdrawal("2026-06-01T00:00:00.000Z"))
        let book = Book().importing([one, alike])
        #expect(book.withdrawals == [one, alike], "two alike in one file are two withdrawals")
        #expect(book.importing([one, alike]) == book)
    }

    @Test func aFileWithTheSameWithdrawalAgainTakesOver() {
        let (earlier, other) = (withdrawal("2026-06-01T00:00:00.000Z", cost: "5"), withdrawal("2026-07-01T00:00:00.000Z"))
        let corrected = withdrawal("2026-06-01T00:00:00.000Z", cost: "6")
        #expect(Book(withdrawals: [earlier, other]).importing([corrected]).withdrawals == [other, corrected])
    }

    @Test func aWithdrawalToAnotherAddressIsAnotherWithdrawal() {
        let (one, other) = (withdrawal("2026-06-01T00:00:00.000Z", to: "0xaa"), withdrawal("2026-06-01T00:00:00.000Z", to: "0xbb"))
        #expect(Book(withdrawals: [one]).importing([other]).withdrawals == [one, other])
    }

    @Test func aFileWithNothingInItKeepsWhatWasThereAndSaysSo() async throws {
        let (store, source, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store)
        await _ = model.importCoinbase(csv: "anything")
        let before = store.book
        #expect(!before.withdrawals.isEmpty)
        await source.answerImports(ExchangeImport(withdrawals: [], skipped: 0))
        await _ = model.importCoinbase(csv: "anything")
        #expect(store.book == before)
        #expect(model.lastImport?.needsALook == true)
        #expect(model.lastImport?.withdrawals.isEmpty == true)
        store.undo()
        #expect(store.book.withdrawals.isEmpty, "it changed nothing, so the only thing to undo is the first import")
    }

    @Test func whatAnImportFoundOutlastsTheQuestionItAnswered() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store)
        await _ = model.importCoinbase(csv: "anything")
        let first = try #require(model.current)
        model.skip()
        #expect(model.current?.id != first.id)
        #expect(model.lastImport != nil)
        model.undo()
        #expect(model.lastImport == nil, "undoing it takes back what it said")
    }

    /// `test/resolve.test.ts` hands this to `parseBook`, so what this encoder leaves out can't make the server refuse every read.
    /// Everything optional is nil, because that's what's left out. A new optional in a book belongs here too.
    @Test func aBookWithNothingOptionalIsWhatTheServerReads() throws {
        let book = Book(
            senders: ["0x00000000000000000000000000000000000000aa": SenderAnswer(kind: .myExchange)],
            costs: ["key": Money(micros: "5", currency: .USD)],
            withdrawals: [withdrawal("2026-11-04T00:00:00.000Z")],
            purchases: [Purchase(provider: "coinbase", order: "1", wallet: "0x00000000000000000000000000000000000000aa", asset: "ETH", units: "1", txHash: "0xabc", blockNum: nil, cost: Money(micros: "5", currency: .USD), costUsdMicros: nil)]
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        let text = String(decoding: try encoder.encode(book), as: UTF8.self) + "\n"
        let url = URL(filePath: #filePath).deletingLastPathComponent().appending(path: "Resources/mac-book.json")
        if ProcessInfo.processInfo.environment["UPDATE_FIXTURES"] != nil { try text.write(to: url, atomically: true, encoding: .utf8) }
        #expect(try String(contentsOf: url, encoding: .utf8) == text, "mac-book.json is out of date. Run with UPDATE_FIXTURES=1 if the change is on purpose, and run `pnpm check`.")
    }

    @Test func aWalletThatsNoLongerYoursStaysListed() throws {
        let (store, _, _) = try makeStore()
        store.setBook(store.book.answering(sender, .mine, focus: nil))
        let kind = { WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: nil).entry(for: sender)?.kind }
        #expect(kind() == .yours)
        store.moveToWatching(sender)
        #expect(store.book.senders[sender] == nil)
        #expect(kind() == .watching)
        store.undo()
        #expect(store.book.senders[sender]?.kind == .mine)
    }

    @Test func proofsAreForWhatsWatched() {
        let watched = "0x00000000000000000000000000000000000000cc"
        let list = WalletList(spending: nil, savings: [], linked: [sender], saved: [SavedWallet(address: watched, lastSeen: .distantPast)], current: watched)
        #expect(list.entry(for: watched)?.canMoveToYours == true)
        #expect(list.entry(for: watched)?.canMoveToWatching == false)
        #expect(list.entry(for: sender)?.canMoveToYours == false)
        #expect(list.entry(for: sender)?.canMoveToWatching == true)
    }

    @Test func writesTheNoteTheServerReads() throws {
        struct Vector: Decodable { let txHash: String; let asset: String; let usdMicros: String; let calldata: String }
        struct Vectors: Decodable { let note: Vector }
        let vector = try resource("format-vectors", as: Vectors.self).note
        let calldata = try #require(CostNote.calldata(txHash: vector.txHash, asset: vector.asset, usdMicros: vector.usdMicros))
        #expect("0x" + calldata.map { String(format: "%02x", $0) }.joined() == vector.calldata)
    }

    @Test func refusesANoteTheServerWouldntRead() {
        let tx = "0x" + String(repeating: "ab", count: 32)
        #expect(CostNote.calldata(txHash: "0xabc", asset: "USDC", usdMicros: "1") == nil)
        #expect(CostNote.calldata(txHash: tx.uppercased(), asset: "USDC", usdMicros: "1") == nil)
        #expect(CostNote.calldata(txHash: tx, asset: "US:DC", usdMicros: "1") == nil)
        #expect(CostNote.calldata(txHash: tx, asset: "USDC", usdMicros: "-1") == nil)
        #expect(CostNote.calldata(txHash: tx, asset: "USDC", usdMicros: "") == nil)
    }

    @Test func accountsInThisWalletGoInTheBookWithoutAQuestion() throws {
        let (store, _, _) = try makeStore()
        store.setLinkedWallets([wallet, sender])
        #expect(store.book.senders[wallet]?.kind == .mine)
        #expect(store.book.senders[sender]?.kind == .mine)
        #expect(store.undoStack.isEmpty, "nobody answered anything, so there's nothing to undo")
        #expect(!store.hasAnswers)
        store.setLinkedWallets([])
        #expect(store.book.senders[sender] == nil, "a mistyped savings wallet can't stay linked")
    }

    @Test func anAccountOutranksAnEarlierAnswerUntilItsRemoved() throws {
        let (store, _, _) = try makeStore()
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        store.setLinkedWallets([sender])
        #expect(store.book.senders[sender]?.kind == .mine)
        store.setBook(store.book.enteringCost("k", Money(micros: "5", currency: .USD)))
        store.setLinkedWallets([])
        #expect(store.book.senders[sender]?.kind == .someoneElse, "what was said before it was an account still stands")
    }

    @Test func undoCantBringBackARemovedAccount() throws {
        let (store, _, _) = try makeStore()
        store.setLinkedWallets([wallet])
        store.setBook(store.book.enteringCost("k", Money(micros: "5", currency: .USD)))
        store.setLinkedWallets([])
        #expect(store.book.senders[wallet] == nil)
        store.undo()
        #expect(store.book.senders[wallet] == nil)
        #expect(store.book.costs["k"] == nil)
    }

    @Test func accountsArentSavedAsAnswers() throws {
        let (store, _, defaults) = try makeStore()
        store.setLinkedWallets([wallet])
        store.setBook(store.book.enteringCost("k", Money(micros: "5", currency: .USD)))
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in BookSource([]) })
        #expect(reopened.book.costs["k"] != nil)
        #expect(reopened.book.senders[wallet] == nil, "whether it's still an account is for the wallet to say")
    }

    @Test func forgettingOrUndoingAnswersKeepsTheAccounts() throws {
        let (store, _, _) = try makeStore()
        store.setLinkedWallets([wallet])
        store.setBook(store.book.answering(sender, .someoneElse, focus: nil))
        #expect(store.hasAnswers)
        store.undo()
        #expect(store.book.senders[wallet]?.kind == .mine)
        store.setBook(Book())
        #expect(store.book.senders[wallet]?.kind == .mine)
    }

    @Test func aWatchedWalletIsntLinkedToTheseAccounts() async throws {
        let (store, source, _) = try makeStore()
        let watched = "0x00000000000000000000000000000000000000cc"
        store.setWallet(watched)
        store.stop()
        store.setLinkedWallets([wallet])
        #expect(store.linked(for: watched).isEmpty)
        await _ = store.poll()
        #expect(await source.books.last?.senders[watched] == nil, "the server goes by this, so it won't carry costs onto it")
        store.setBook(store.book.answering(wallet, .mine, focus: watched))
        store.stop()
        await _ = store.poll()
        #expect(await source.books.last?.senders[watched]?.kind == .mine, "they've said this one's theirs too")
    }

    @Test(arguments: [WalletAddress.demo, "0x00000000000000000000000000000000000de300", "0x00000000000000000000000000000000000de301"])
    func theDemoNeverGetsTheseAccounts(demo: String) async throws {
        let (store, source, _) = try makeStore()
        let saving = "0x00000000000000000000000000000000000de301"
        store.setWallet(demo)
        store.stop()
        store.setLinkedWallets([wallet])
        store.setBook(store.book.answering(saving, .mine, focus: nil))
        store.stop()
        let expected = Book().answering(saving, .mine, focus: nil)
        #expect(store.linked(for: demo).isEmpty)

        await _ = store.poll()
        #expect(await source.books.last == expected, "its own answer stays, and that's what it inherits from")
        _ = try await store.previews(of: [store.book])
        #expect(await source.previewed.last == [expected])
        _ = try await store.exportCSV()
        #expect(await source.books.last == expected)
        _ = try? await store.comparison()
        #expect(await source.books.last == expected)
        #expect(store.explanationRequest(for: .asset("ETH", .value))?.book == expected)
        #expect(store.book.senders[wallet]?.kind == .mine, "it's still an account, for anything that isn't the demo")
    }

    @Test func sayingAWatchedWalletGotItFromSomeoneElseLeavesYoursAlone() throws {
        let watched = "0x00000000000000000000000000000000000000cc"
        let book = Book().answering(sender, .mine, focus: wallet).answering(sender, .someoneElse, focus: watched)
        #expect(book.senders[sender]?.kind == .mine)
        #expect(book.senders[wallet]?.kind == .mine)
        #expect(book.senders[watched]?.kind == .someoneElse)
        #expect(book.answering(sender, .mine, focus: watched).senders[watched]?.kind == .mine, "they can still change their mind")
        #expect(Book().answering(sender, .someoneElse, focus: watched).senders == [sender: .someoneElse], "that's only about a sender already said to be theirs")
    }

    @Test func aSenderSaidToBeAWalletCantAlsoBeAnExchange() async throws {
        let portfolio = try demoPortfolio()
        let (store, source, _) = try makeStore([portfolio])
        await _ = store.poll()
        let model = ResolveModel(store: store)
        let first = try #require(model.current?.sender)
        #expect(model.options == Ownership.allCases)
        store.setBook(store.book.answering(first, .mine, focus: nil))
        await _ = store.poll()
        #expect(model.current?.sender == first, "this fixture keeps asking, as a wallet that isn't theirs would")
        #expect(model.options == [.mine, .someoneElse])
        model.answer(.myExchange)
        #expect(store.book.senders[first]?.kind == .mine)
        #expect(!model.isAskingCost)
        await source.answerPreviews([BookPreview(pnlMicros: "1", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false), BookPreview(pnlMicros: "2", pnlStatus: .complete, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: false, failed: false)])
        await model.loadPreviews()
        #expect(model.previews.keys.sorted { $0.rawValue < $1.rawValue } == [.mine, .someoneElse])
    }

    func question(receipts: [CostReceipt], noteAbout: String? = "0x" + String(repeating: "cd", count: 32)) -> Question {
        Question(id: "q", kind: .cost, wallet: wallet, sender: nil, known: nil, costKey: "k", noteAbout: noteAbout, needsCost: false, arrivals: [Arrival(asset: "USDC", decimals: 6, units: "5")], receipts: receipts, transfers: receipts.count, firstAt: "", lastAt: "", evidence: [], valueMicros: nil)
    }

    @Test func onlyAQuestionAboutOneTokenInOneTransactionCanBeANote() throws {
        let tx = "0x" + String(repeating: "cd", count: 32)
        let receipt = CostReceipt(wallet: wallet, legId: "\(tx):USDC", asset: "USDC", units: "5")
        #expect(question(receipts: [receipt]).noteDraft == CostNoteDraft(wallet: wallet, txHash: tx, asset: "USDC", decimals: 6, units: "5"))
        #expect(question(receipts: [receipt, receipt]).noteDraft == nil)
        #expect(question(receipts: [receipt], noteAbout: nil).noteDraft == nil, "the server says it's only part of what arrived")
        #expect(question(receipts: [receipt], noteAbout: "opening").noteDraft == nil)
    }

    @Test func aNoteIsOnlyOfferedForAWalletThatCanSignIt() async throws {
        let (store, _, _) = try makeStore()
        let tx = "0x" + String(repeating: "cd", count: 32)
        let open = question(receipts: [CostReceipt(wallet: wallet, legId: "\(tx):USDC", asset: "USDC", units: "5")])
        #expect(ResolveModel(store: store).noteDraft(for: open) == nil)
        #expect(ResolveModel(store: store, noteWriter: FakeNoteWriter(wallet: sender)).noteDraft(for: open) == nil)
        #expect(ResolveModel(store: store, noteWriter: FakeNoteWriter(wallet: wallet)).noteDraft(for: open) != nil)
    }

    @Test func aNoteOnADeviceIsOnlyOfferedForASavingsWallet() async throws {
        let (store, _, _) = try makeStore()
        let tx = "0x" + String(repeating: "cd", count: 32)
        let open = question(receipts: [CostReceipt(wallet: wallet, legId: "\(tx):USDC", asset: "USDC", units: "5")])
        #expect(ResolveModel(store: store).deviceNoteDraft(for: open) == nil)
        #expect(ResolveModel(store: store, noteWriter: FakeNoteWriter(wallet: wallet)).deviceNoteDraft(for: open) == nil)
        let writer = FakeNoteWriter(wallet: nil)
        writer.savings = wallet
        #expect(ResolveModel(store: store, noteWriter: writer).deviceNoteDraft(for: open) != nil)
    }

    /// The demo's question about VIRTUAL, which came in one transaction.
    func virtualDraft(_ store: PortfolioStore) async throws -> (ResolveModel, CostNoteDraft, Question, FakeNoteWriter) {
        await _ = store.poll()
        let writer = FakeNoteWriter(wallet: nil)
        let model = ResolveModel(store: store, firstAsset: "VIRTUAL", noteWriter: writer)
        let question = try #require(model.current)
        return (model, try #require(model.noteDraft(for: question)), question, writer)
    }

    @Test func aPublishedCostGoesOutThenStaysHereInUSD() async throws {
        let (store, _, _) = try makeStore()
        store.setCurrency(.CAD)
        store.stop()
        let (model, draft, question, writer) = try await virtualDraft(store)
        #expect(await model.publish(draft, usd: "250"))
        let note = String(decoding: try #require(writer.written.first), as: UTF8.self)
        #expect(note == "patina:cost:1:\(draft.txHash):VIRTUAL:250000000")
        #expect(store.book.costs[try #require(question.costKey)] == Money(micros: "250000000", currency: .USD), "a note's always in USD, whatever's on screen")
    }

    @Test func aCostThatDidntGetPublishedIsntKept() async throws {
        let (store, _, _) = try makeStore()
        let (model, draft, question, writer) = try await virtualDraft(store)
        writer.noteProblem = "No gas."
        #expect(await model.publish(draft, usd: "250") == false)
        #expect(store.book.costs[try #require(question.costKey)] == nil)
        #expect(model.failure == "No gas.")
        #expect(!model.isPublishing, "the sheet can close again")
    }

    @Test func publishingNeedsAnAmount() async throws {
        let (store, _, _) = try makeStore()
        let (model, draft, _, writer) = try await virtualDraft(store)
        #expect(await model.publish(draft, usd: "lots") == false)
        #expect(writer.written.isEmpty)
    }

    @Test func aDraftFromAWalletThatChangedDoesntPublish() async throws {
        let (store, _, _) = try makeStore()
        let (model, draft, question, writer) = try await virtualDraft(store)
        writer.wallet = "0x00000000000000000000000000000000000000dd"
        #expect(await model.publish(draft, usd: "250") == false)
        #expect(writer.written.isEmpty)
        #expect(model.failure != nil)
        #expect(store.book.costs[try #require(question.costKey)] == nil)
    }

    @Test func publishingKeepsAnswersGivenDuringTheWait() async throws {
        let (store, _, _) = try makeStore()
        let (model, draft, question, writer) = try await virtualDraft(store)
        var wasPublishing = false
        writer.onWrite = {
            wasPublishing = model.isPublishing
            store.setBook(store.book.answering("0x00000000000000000000000000000000000000ee", .someoneElse, focus: nil))
        }
        #expect(await model.publish(draft, usd: "250"))
        #expect(wasPublishing, "what keeps the sheet's Cancel and Escape from closing it on something that's still going out")
        #expect(!model.isPublishing)
        #expect(store.book.senders["0x00000000000000000000000000000000000000ee"]?.kind == .someoneElse)
        #expect(store.book.costs[try #require(question.costKey)] != nil)
    }

    @Test func aPendingPreviewSaysSo() {
        #expect(Wording.consequence(BookPreview(pnlMicros: nil, pnlStatus: .unavailable, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: true, failed: false), .USD) == "Reading that wallet…")
    }

    @Test func aFailedPreviewSaysSoRatherThanReading() {
        #expect(Wording.consequence(BookPreview(pnlMicros: nil, pnlStatus: .unavailable, estimatedMicros: "0", unresolvedMicros: "0", open: 0, pending: true, failed: true), .USD) == "Couldn't read that wallet")
    }

    @Test func aPartlyEstimatedOrUnresolvedConsequenceSaysSo() {
        #expect(Wording.consequence(BookPreview(pnlMicros: "1000000", pnlStatus: .partial, estimatedMicros: "5", unresolvedMicros: "45000000", open: 1, pending: false, failed: false), .USD) == "≈+$1.00 · $45.00 cost unknown")
    }

    @Test func aCostInCADIsKeptInCAD() async throws {
        let (store, _, _) = try makeStore()
        store.setCurrency(.CAD)
        await _ = store.poll()
        let model = ResolveModel(store: store, firstAsset: "DAI")
        let question = try #require(model.current)
        #expect(model.enterCost(["DAI": "340"]))
        #expect(store.book.costs[try #require(question.costKey)] == Money(micros: "340000000", currency: .CAD))
    }

    @Test func warnsAboutACostFarFromWhatItWasWorth() async throws {
        let (store, _, _) = try makeStore()
        await _ = store.poll()
        let model = ResolveModel(store: store, firstAsset: "DAI")
        let question = try #require(model.current)
        #expect(model.costWarning(["DAI": "250"], for: question) == nil)
        #expect(model.costWarning(["DAI": "121360"], for: question)?.contains("Double-check") == true)
        #expect(model.costWarning(["DAI": "1"], for: question) != nil)
        #expect(model.costWarning(["DAI": "nope"], for: question) == nil)
    }

    @Test func readsDollarsAsTyped() {
        #expect(Format.micros(fromDollars: "$1,234.50") == "1234500000")
        #expect(Format.micros(fromDollars: "0") == "0")
        #expect(Format.micros(fromDollars: ".5") == "500000")
        #expect(Format.micros(fromDollars: "12.") == "12000000")
        #expect(Format.micros(fromDollars: "1.1234567") == "1123456")
        for bad in ["", "-5", "abc", "1.2.3", "1e5"] { #expect(Format.micros(fromDollars: bad) == nil, "\(bad)") }
    }

    @Test func aDecimalCommaIsntThousands() {
        #expect(Format.micros(fromDollars: "46,20") == "46200000")
        #expect(Format.micros(fromDollars: "$46,2") == "46200000")
        #expect(Format.micros(fromDollars: "1 234,50 $") == "1234500000")
        #expect(Format.micros(fromDollars: "1,234") == "1234000000")
        #expect(Format.micros(fromDollars: "1,234,567.50") == "1234567500000")
        for bad in ["1.234,50", "12,3456", "1,23,456", "0,125", ",5"] { #expect(Format.micros(fromDollars: bad) == nil, "\(bad)") }
    }

    @Test func aCostTakesEveryMarkOfTheMainCurrency() {
        for currency in CurrencyCode.allCases {
            for mark in Set([currency.rawValue, currency.symbol, currency.label].map { $0.trimmingCharacters(in: .whitespaces) }) {
                #expect(Format.micros(fromDollars: "\(mark)46", in: currency) == "46000000", "\(mark)46")
                #expect(Format.micros(fromDollars: "46 \(mark)", in: currency) == "46000000", "46 \(mark)")
            }
        }
        #expect(Format.micros(fromDollars: "46 ZAR", in: .ZAR) == "46000000")
    }

    @Test func aCostTakesOnlyTheMainCurrencysOwnSymbol() {
        #expect(Format.micros(fromDollars: "€46,20", in: .EUR) == "46200000")
        #expect(Format.micros(fromDollars: "46,20 €", in: .EUR) == "46200000")
        #expect(Format.micros(fromDollars: "CHF 46", in: .CHF) == "46000000")
        #expect(Format.micros(fromDollars: "A$46", in: .AUD) == "46000000")
        #expect(Format.micros(fromDollars: "$46", in: .AUD) == "46000000")
        // Another currency's amount isn't one in this currency, and a note's USD stays in dollars.
        #expect(Format.micros(fromDollars: "$46", in: .EUR) == nil)
        #expect(Format.micros(fromDollars: "US$46", in: .CAD) == nil)
        #expect(Format.micros(fromDollars: "€46") == nil)
    }
}

@MainActor
final class FakeNoteWriter: CostNoteWriter {
    var wallet: String?
    var written: [[UInt8]] = []
    var noteProblem: String?
    var onWrite: (() -> Void)?

    init(wallet: String?) {
        self.wallet = wallet
    }

    func canWriteNote(from wallet: String) -> Bool { wallet == self.wallet || self.wallet == nil }
    var savings: String?
    func canWriteNoteOnDevice(from wallet: String) -> Bool { wallet == savings }
    func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool {
        written.append(calldata)
        onWrite?()
        return noteProblem == nil
    }
}
