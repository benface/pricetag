import Foundation
import Testing
@testable import PricetagKit

/// `test/portfolio.test.ts` writes the vectors from the web app's wording, so both say the same thing.
struct WordingVectors: Decodable {
    struct UnseenEthVector: Decodable {
        let unseen: [UnseenEth]
        let text: String
    }
    struct Action: Decodable {
        let kind: String
        let incoming: Bool
        let label: String
    }
    struct PriceSource: Decodable { let source, label: String }
    struct Cost: Decodable { let cost, tag: String }
    struct Activity: Decodable {
        let count, shown: Int
        let title: String
    }
    struct CoverageVector: Decodable {
        let fromBlock, toBlock, trackedTokens: Int
        let openingUnread: Bool
        let text: String
    }
    struct FeesUnknown: Decodable {
        let count: Int
        let text: String
    }
    struct Behind: Decodable {
        let ms: Int
        let text: String
    }
    struct PnlHelp: Decodable {
        let text: String
        let help: String?
    }
    struct Sentences: Decodable {
        let methodName, methodHelp, averagePricePaid, networkFees, balanceCheck, startingBalance, pnlHelp, realizedHelp, unrealizedHelp, returnHelp: String
        let notStarted, unpricedFees, demo, pnlUnavailable, nothingToChart, reading, notAnAddress, rulesTitle, rulesHelp: String
        let holdTitle, holdWallet, holdEth, holdPast: String
    }
    let manifestHash: String
    let methods: [String: String]
    let modes: [String: String]
    let actions: [Action]
    let priceSources: [PriceSource]
    let costs: [Cost]
    let activity: [Activity]
    let excluded: String
    let coverage: [CoverageVector]
    let networkFeeUnknown: [FeesUnknown]
    let checkLabels: [String: String]
    let feesUnknown: [FeesUnknown]
    let behind: [Behind]
    let stale: String
    let unseenEth: [UnseenEthVector]
    let feedDetail: [String]
    let pnlHelp: [PnlHelp]
    let linkedFailed: [FeesUnknown]
    let withheld: String
    let sentences: Sentences
}

@Suite struct WordingTests {
    let vectors: WordingVectors

    init() throws {
        vectors = try resource("wording-vectors", as: WordingVectors.self)
    }

    @Test func labelsMatchTheWebApp() {
        for method in CostMethod.allCases { #expect(vectors.methods[method.rawValue] == method.label) }
        for mode in [Mode.demo, .raw, .dataset] { #expect(vectors.modes[mode.rawValue] == mode.label) }
        for vector in vectors.actions { #expect(Wording.action(kind: vector.kind, isIncoming: vector.incoming) == vector.label) }
        for vector in vectors.priceSources { #expect(Wording.priceSource(vector.source) == vector.label) }
        for vector in vectors.costs { #expect(Wording.costTag(vector.cost) == vector.tag) }
        for vector in vectors.activity { #expect(Wording.activityTitle(count: vector.count, shown: vector.shown) == vector.title) }
    }

    @Test func sentencesMatchTheWebApp() {
        let excluded = [Exclusion(asset: "USDC", reason: "unknown cost"), Exclusion(asset: "AERO", reason: "no current price"), Exclusion(asset: "ETH", reason: "unknown cost")]
        #expect(Wording.excluded(excluded) == vectors.excluded)
        for vector in vectors.coverage {
            let span = Coverage(fromBlock: vector.fromBlock, toBlock: vector.toBlock)
            #expect(Wording.coverage(span, trackedTokens: vector.trackedTokens, openingUnread: vector.openingUnread) == vector.text)
        }
        for vector in vectors.networkFeeUnknown { #expect(Wording.networkFeeUnknown(vector.count) == vector.text) }
        for status in [Reconciliation.Status.reconciled, .incomplete, .unchecked] { #expect(Wording.checkLabel(status) == vectors.checkLabels[status.rawValue]) }
        for vector in vectors.feesUnknown { #expect(Wording.feesUnknown(vector.count) == vector.text) }
        for vector in vectors.behind { #expect(Wording.behind(ms: vector.ms) == vector.text) }
        #expect(Wording.stale(lastUpdate: "Nov 4 at 5:40 AM") == vectors.stale)
        for vector in vectors.unseenEth { #expect(Wording.unseenEthCause(vector.unseen) == vector.text) }
        #expect([Mode.demo, .raw, .dataset].map { Wording.feedDetail($0, block: 1000) } == vectors.feedDetail)
        for vector in vectors.pnlHelp { #expect(Wording.pnlHelp(for: vector.text) == vector.help) }
        let sentences = vectors.sentences
        for vector in vectors.linkedFailed { #expect(Wording.linkedFailed(vector.count) == vector.text) }
        #expect(Wording.withheld(wallet: "0x1234567890abcdef1234567890abcdef12345678", asset: "ETH") == vectors.withheld)
        #expect(Wording.methodName == sentences.methodName)
        #expect(Wording.rulesTitle == sentences.rulesTitle)
        #expect(Wording.rulesHelp == sentences.rulesHelp)
        #expect(Wording.holdTitle == sentences.holdTitle)
        #expect(Wording.holdWallet == sentences.holdWallet)
        #expect(Wording.holdEth == sentences.holdEth)
        #expect(Wording.holdPast == sentences.holdPast)
        #expect(Wording.methodHelp == sentences.methodHelp)
        #expect(Wording.averagePricePaid == sentences.averagePricePaid)
        #expect(Wording.networkFees == sentences.networkFees)
        #expect(Wording.balanceCheck == sentences.balanceCheck)
        #expect(Wording.startingBalance == sentences.startingBalance)
        #expect(Wording.pnlHelp == sentences.pnlHelp)
        #expect(Wording.realizedHelp == sentences.realizedHelp)
        #expect(Wording.unrealizedHelp == sentences.unrealizedHelp)
        #expect(Wording.returnHelp == sentences.returnHelp)
        #expect(Wording.notStarted == sentences.notStarted)
        #expect(Wording.unpricedFees == sentences.unpricedFees)
        #expect(Wording.demo == sentences.demo)
        #expect(Wording.pnlUnavailable == sentences.pnlUnavailable)
        #expect(Wording.nothingToChart == sentences.nothingToChart)
        #expect(Wording.reading == sentences.reading)
        #expect(Wording.notAnAddress == sentences.notAnAddress)
    }
}

@Suite struct RuleWordingTests {
    @Test func aManifestHashReadsTheSameOnBothSides() throws {
        let vectors = try resource("wording-vectors", as: WordingVectors.self)
        #expect(Wording.shortManifestHash("bea12f7575e74575f2f0318213d61d421706eea0314e5d7116edebd4e77818a1") == vectors.manifestHash)
    }

    @Test func aComparisonDecodes() throws {
        let comparison = try resource("demo-rule-comparison", as: RuleComparison.self)
        #expect(comparison.a.name == "Market price")
        #expect(comparison.b.name == "Cautious ETH")
        #expect(comparison.rows.first?.label == "ETH price")
        #expect(comparison.changedTxs > 0)
        #expect(comparison.rows.first { $0.label == "Total PnL" }?.aPartial == true)
        #expect(comparison.rows.first { $0.label == "Total PnL" }?.aEstimated == true)
        #expect(comparison.rows.first?.aEstimated == false)
        #expect(!comparison.warnings.isEmpty)
    }

    @Test func anUnavailableNumberIsNeverZero() {
        #expect(Format.ruleValue(nil, format: "signed", currency: .USD) == "Unavailable")
        #expect(Format.ruleDifference(nil, format: "signed", currency: .USD) == "—")
    }

    @Test func aDifferenceIsSigned() {
        #expect(Format.ruleDifference("0", format: "money", currency: .USD) == "Same")
        #expect(Format.ruleDifference("1500000", format: "money", currency: .USD) == "+$1.50")
        // ETH's price is always in USD, so beside another kind of dollar it says which.
        #expect(Format.ruleDifference("-24000000", format: "usdPrice", currency: .USD) == "-$24.00")
        #expect(Format.ruleValue("2376000000", format: "usdPrice", currency: .USD) == "$2,376.00")
        #expect(Format.ruleDifference("-24000000", format: "usdPrice", currency: .CAD) == "-US$24.00")
        #expect(Format.ruleDifference("24000000", format: "usdPrice", currency: .CAD) == "+US$24.00")
        #expect(Format.ruleDifference("24000000", format: "usdPrice", currency: .CAD, isEstimate: true) == "≈+US$24.00")
        #expect(Format.ruleValue("2376000000", format: "usdPrice", currency: .CAD) == "US$2,376.00")
        #expect(Format.ruleValue("2376000000", format: "usdPrice", currency: .CAD, isEstimate: true) == "≈US$2,376.00")
        #expect(Format.ruleValue("1500000", format: "money", currency: .CAD) == "$1.50")
        // An estimate looks like one, and so does a difference from it. What isn't a number stays as it is.
        #expect(Format.ruleValue("1500000", format: "money", currency: .USD, isEstimate: true) == "≈$1.50")
        #expect(Format.ruleValue("1500000", format: "signed", currency: .USD, isEstimate: true) == "≈+$1.50")
        #expect(Format.ruleValue(nil, format: "signed", currency: .USD, isEstimate: true) == "Unavailable")
        #expect(Format.ruleDifference("1500000", format: "money", currency: .USD, isEstimate: true) == "≈+$1.50")
        #expect(Format.ruleDifference("0", format: "money", currency: .USD, isEstimate: true) == "Same")
        #expect(Format.ruleDifference(nil, format: "money", currency: .USD, isEstimate: true) == "—")
    }
}

/// `test/hold.test.ts` writes these from the same comparison the server sends.
struct HoldComparisonTests {
    private struct Vector: Decodable {
        let currency: CurrencyCode
        let comparison: HoldComparison
        let difference: String?
        let aboutDifference: String?
        let caveat: String?
    }

    @Test func saysTheSameAsTheWeb() throws {
        let vectors = try resource("hold-vectors", as: [Vector].self)
        #expect(vectors.count == 9)
        for vector in vectors {
            #expect(Wording.holdCaveat(vector.comparison, vector.currency) == vector.caveat)
            #expect(vector.comparison.differenceMicros.map { Wording.holdDifference($0, vector.currency) } == vector.difference)
            #expect(vector.comparison.differenceMicros.map { Wording.holdDifference($0, vector.currency, estimated: true) } == vector.aboutDifference)
        }
    }

    @Test func neverShowsADifferenceUnlessItCoversTheSameMoney() throws {
        for vector in try resource("hold-vectors", as: [Vector].self) {
            #expect((vector.comparison.differenceMicros != nil) == (vector.comparison.status == .complete))
            if vector.comparison.status == .unavailable { #expect(vector.comparison.holdMicros == nil) }
        }
    }
}

@Suite struct AttentionTests {
    @Test func saysWhatTheNumbersLeaveOutOnce() throws {
        let portfolio = try demoPortfolio()
        let attention = try #require(portfolio.attention)
        #expect(attention.title.hasPrefix("$3,603.42 has an unknown cost, so it isn't in the PnL."))
        #expect(attention.title.hasSuffix("$899.98 is estimated."))
        #expect(attention.fullList == Wording.excluded(portfolio.totals.excluded))
        // What "has an unknown cost" doesn't cover, said where it's seen rather than only in a tooltip.
        #expect(attention.details == ["PnL also leaves out USDC, ETH, and cbBTC."])
    }

    @Test func seeWhyOpensTheBalanceThatDoesntMatch() throws {
        #expect(try demoPortfolio().attentionTarget == .asset("cbBTC", .onchain))
    }

    @Test func answeringCountsItsQuestions() {
        #expect(Wording.answerQuestions(1) == "Answer 1 Question")
        #expect(Wording.answerQuestions(5) == "Answer 5 Questions")
    }

    private func changing(_ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// One position that matches, and another with no row at all because it couldn't be read.
    private func onlyReconciledPlusUnread() throws -> Portfolio {
        try changing { object in
            let positions = object["positions"] as! [[String: Any]]
            object["positions"] = positions.filter { ($0["reconciliation"] as? [String: Any])?["status"] as? String == "reconciled" && $0["noMarket"] as? Bool == false }
            object["unreadAssets"] = ["USDC"]
        }
    }

    @Test func aBalanceThatCouldntBeReadStopsTheAssurance() throws {
        #expect(Wording.allBalancesMatch(try onlyReconciledPlusUnread()) == nil)
    }

    @Test func aBalanceWithNoRowStaysOnScreen() throws {
        let attention = try #require(try onlyReconciledPlusUnread().attention)
        #expect(attention.details.contains("Couldn't read the USDC balance."))
    }

    @Test func onlySaysBalancesMatchWhenTheyAllDo() throws {
        // The demo has one that doesn't.
        #expect(Wording.allBalancesMatch(try demoPortfolio()) == nil)
    }

    @Test func aBoughtCostSaysWhichTransactionItsOrderIsFor() {
        #expect(Wording.costTag("paid", source: "Bought on Coinbase") == "Cost: Bought on Coinbase")
        #expect(Wording.costTag("inherited", source: "Bought on Coinbase") == "Cost: Bought on Coinbase, from your other wallet")
        #expect(Wording.costProof(source: "Bought on Coinbase", label: "paid").contains("matches this transaction exactly"))
        let moved = Wording.costProof(source: "Bought on Coinbase", label: "inherited")
        #expect(!moved.contains("matches this transaction"))
        #expect(moved.contains("your other wallet"))
    }
}
