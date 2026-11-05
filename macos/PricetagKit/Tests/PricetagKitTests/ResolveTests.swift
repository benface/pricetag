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

    init(_ portfolios: [Portfolio]) {
        self.portfolios = portfolios
    }

    func answerPreviews(_ answers: [BookPreview]) {
        previewAnswers = answers
    }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        books.append(book)
        return portfolios.count > 1 ? portfolios.removeFirst() : portfolios[0]
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        previewed.append(candidates)
        previewRules.append(rule)
        return previewAnswers
    }

    func importCoinbase(csv: String) async throws -> ExchangeImport {
        ExchangeImport(withdrawals: [ExchangeWithdrawal(exchange: "Coinbase", asset: "ETH", units: "1", at: "2026-11-04T00:00:00.000Z", cost: Money(micros: "5", currency: .USD), toAddress: nil)], skipped: 1)
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
        let caveat = try #require(Wording.headlineCaveat(portfolio.totals, portfolio.currency))
        #expect(caveat.contains("unresolved"))
        #expect(caveat.contains("estimated"))
        #expect(FeedSummary(feed: .live, portfolio: portfolio).text.contains("≈"))
    }

    @Test func saysWhatHasNoMarket() throws {
        let text = try #require(Wording.noMarket(try demoPortfolio()))
        #expect(text.contains("DEGEN"))
        #expect(text.contains("2 tokens"))
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
        #expect(model.failure?.contains("1 had no usable cost") == true)
    }

    @Test func aSignatureOnlyLinksWhenItHoldsUp() async throws {
        let (store, _, _) = try makeStore()
        #expect(try await store.linkProved(sender, signature: "bad") == false)
        #expect(store.book.isEmpty)
        #expect(try await store.linkProved(sender, signature: "good") == true)
        #expect(store.book.linkedWallets.contains(sender))
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
        #expect(Wording.consequence(BookPreview(pnlMicros: "1000000", pnlStatus: .partial, estimatedMicros: "5", unresolvedMicros: "45000000", open: 1, pending: false, failed: false), .USD) == "≈+$1.00 · $45.00 unresolved")
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

    @Test func signsTheSameWordsTheServerChecks() throws {
        struct Vector: Decodable { let owner: String; let address: String; let message: String }
        struct Vectors: Decodable { let linkMessage: Vector }
        let vector = try resource("format-vectors", as: Vectors.self).linkMessage
        #expect(Wording.linkMessage(owner: vector.owner, address: vector.address) == vector.message)
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
    func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool {
        written.append(calldata)
        onWrite?()
        return noteProblem == nil
    }
}
