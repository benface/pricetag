import Foundation
import Testing
@testable import PricetagKit

/// `test/portfolio.test.ts` writes the vectors from the web app's wording, so both say the same thing.
struct WordingVectors: Decodable {
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
        let blocks: Int
        let text: String
    }
    struct PnlHelp: Decodable {
        let text: String
        let help: String?
    }
    struct Sentences: Decodable {
        let methodName, methodHelp, averagePricePaid, networkFees, balanceCheck, startingBalance, pnlHelp, realizedHelp, unrealizedHelp: String
        let notStarted, unpricedFees, demo, pnlUnavailable, nothingToChart, reading, notAnAddress, rulesTitle, rulesHelp: String
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
    let feedDetail: [String]
    let pnlHelp: [PnlHelp]
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
        for vector in vectors.behind { #expect(Wording.behind(blocks: vector.blocks) == vector.text) }
        #expect(Wording.stale(lastUpdate: "Nov 4 at 5:40 AM") == vectors.stale)
        #expect([Mode.demo, .raw, .dataset].map { Wording.feedDetail($0, block: 1000) } == vectors.feedDetail)
        for vector in vectors.pnlHelp { #expect(Wording.pnlHelp(for: vector.text) == vector.help) }
        let sentences = vectors.sentences
        #expect(Wording.methodName == sentences.methodName)
        #expect(Wording.rulesTitle == sentences.rulesTitle)
        #expect(Wording.rulesHelp == sentences.rulesHelp)
        #expect(Wording.methodHelp == sentences.methodHelp)
        #expect(Wording.averagePricePaid == sentences.averagePricePaid)
        #expect(Wording.networkFees == sentences.networkFees)
        #expect(Wording.balanceCheck == sentences.balanceCheck)
        #expect(Wording.startingBalance == sentences.startingBalance)
        #expect(Wording.pnlHelp == sentences.pnlHelp)
        #expect(Wording.realizedHelp == sentences.realizedHelp)
        #expect(Wording.unrealizedHelp == sentences.unrealizedHelp)
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
        #expect(!comparison.warnings.isEmpty)
    }

    @Test func anUnavailableNumberIsNeverZero() {
        #expect(Format.ruleValue(nil, format: "signed", currency: .USD) == "Unavailable")
        #expect(Format.ruleDifference(nil, format: "signed", currency: .USD) == "—")
    }

    @Test func aDifferenceIsSigned() {
        #expect(Format.ruleDifference("0", format: "money", currency: .USD) == "Same")
        #expect(Format.ruleDifference("1500000", format: "money", currency: .USD) == "+$1.50")
        #expect(Format.ruleDifference("-24000000", format: "usdPrice", currency: .CAD) == "-$24.00")
        #expect(Format.ruleValue("2376000000", format: "usdPrice", currency: .CAD) == "$2,376.00")
    }
}
