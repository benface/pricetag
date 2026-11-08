#if DEBUG
import Foundation
import HotWalletKit
import KeyVault
import PricetagKit
import Synchronization

/// Stands in for the server, with the same demo wallet the tests read.
final class FixtureSource: PortfolioSource {
    enum Feed { case demo, allYours, allYoursBehind, costBecomesKnown, missingPrice, unreadBalance, neverAnswers, updating, serverDown, stopsAnswering, pricesDown, pricesStop, tooSlow, retrying, retryingWithNumbers, notStartedFails, linkedFails, costWithheld, costOnSavings, smallAmounts, longHistory, chartGaps, busy, answeredWallet, allAnswered, nothingLeft, empty, emptyReadingLinked, notStarted, firstRun }

    private let feed: Feed
    private let hasRate: Bool
    private let pricingRules: [PricingRule]
    enum RulesAnswer { case rules, never, needsInvite, unreachable }
    private let rulesAnswer: RulesAnswer
    private let progress: FirstReadProgress?
    private let progressDelay: Duration
    private let reads = Mutex(0)
    /// For `motion-cost-known`: whether what you paid has come in yet.
    static let costIsKnown = Mutex(false)

    func rules() async throws -> [PricingRule] {
        switch rulesAnswer {
        case .rules: return pricingRules
        case .never:
            try await Task.sleep(for: .seconds(600))
            return pricingRules
        case .needsInvite: throw FetchError.needsInvite("This server needs an invite.")
        case .unreachable: throw FetchError.unreachable
        }
    }

    /// Three USDC purchases, one with no cost anyone knows, and some nothing can name.
    func held(_ read: ReadContext) async throws -> HeldByAsset {
        HeldByAsset(assets: ["USDC": HeldUnits(purchases: [
            .init(boughtAt: "2026-02-14T15:20:00.000Z", units: "10000000", costMicros: "10010000", allOnly: false),
            .init(boughtAt: "2026-06-03T09:45:00.000Z", units: "8000000", costMicros: nil, allOnly: false),
            .init(boughtAt: "2026-10-28T18:05:00.000Z", units: "6000000", costMicros: "6000000", allOnly: true),
        ], unnamed: "1500000")])
    }

    func readProgress(address: String) async throws -> FirstReadProgress? {
        try await Task.sleep(for: progressDelay)
        return progress
    }

    init(feed: Feed, hasRate: Bool = true, rules: [PricingRule] = [], rulesAnswer: RulesAnswer = .rules, progress: FirstReadProgress? = nil, progressDelay: Duration = .zero) {
        self.progressDelay = progressDelay
        pricingRules = rules
        self.rulesAnswer = rulesAnswer
        self.progress = progress
        self.feed = feed
        self.hasRate = hasRate
    }

    /// The same rate as the demo's CAD portfolio.
    func currentRate(currency: CurrencyCode) async throws -> String? { hasRate ? "1398601" : nil }

    func portfolio(_ context: ReadContext, timeout: Duration) async throws -> Portfolio {
        let read = reads.withLock { reads in
            reads += 1
            return reads
        }
        switch feed {
        case .demo: break
        case .allYours: return try allYours("all-yours-demo-portfolio")
        case .allYoursBehind: return try allYours("all-yours-demo-portfolio", behind: true)
        case .costBecomesKnown:
            guard Self.costIsKnown.withLock({ $0 }) else { break }
            return try demo(Self.knowEveryCost)
        case .missingPrice:
            // The demo, with no price for USDC right now. It's the largest holding, so its value is a big part of the total, and with no price it's listed last.
            return try demo { object in
                var positions = object["positions"] as? [[String: Any]] ?? []
                for index in positions.indices where positions[index]["asset"] as? String == "USDC" {
                    var values = positions[index]["values"] as? [String: Any] ?? [:]
                    values["valueMicros"] = NSNull()
                    positions[index]["values"] = values
                }
                object["positions"] = positions
                var totals = object["totals"] as? [String: Any] ?? [:]
                totals["valueMicros"] = "4321680200"
                var coverage = totals["coverage"] as? [String: Any] ?? [:]
                coverage["value"] = ["known": 6, "missing": 1]
                totals["coverage"] = coverage
                object["totals"] = totals
            }
        case .unreadBalance:
            // The demo, with every price known and a balance that couldn't be read.
            return try demo { object in
                object["unreadAssets"] = ["wstETH"]
                var totals = object["totals"] as? [String: Any] ?? [:]
                var coverage = totals["coverage"] as? [String: Any] ?? [:]
                coverage["value"] = ["known": 7, "missing": 1]
                totals["coverage"] = coverage
                object["totals"] = totals
            }
        case .linkedFails:
            // The demo, with one of its linked wallets unreadable.
            return try demo { $0["linkedFailed"] = ["0x00000000000000000000000000000000000de301"] }
        case .costWithheld, .costOnSavings:
            // The demo, with what one of its linked wallets sent left unknown. On savings, a note could answer it, and there's every way to answer it.
            return try demo { object in
                object["withheld"] = [["wallet": "0x00000000000000000000000000000000000de301", "asset": "USDC"]]
                let asked: [String: Any] = ["id": "cost:0xdemo:0xwithheld:USDC", "kind": "cost", "wallet": object["address"] ?? "", "receipts": [["wallet": object["address"] ?? "", "legId": "0xwithheld:USDC", "asset": "USDC", "units": "500000000"]], "costKey": "0xdemo:0xwithheld:USDC", "sender": feed == .costOnSavings ? "0x00000000000000000000000000000000000de301" : NSNull(), "noteAbout": feed == .costOnSavings ? "0x" + String(repeating: "ab", count: 32) : NSNull(), "needsCost": false, "arrivals": [["asset": "USDC", "decimals": 6, "units": "500000000"]], "transfers": 1, "firstAt": "2026-11-04T12:00:00.000Z", "lastAt": "2026-11-04T12:00:00.000Z", "evidence": ["0x0000…e301, your wallet, sent this, and its USDC history can't be confirmed"], "valueMicros": "500000000"]
                object["questions"] = [asked] + (object["questions"] as? [[String: Any]] ?? [])
                object["meter"] = ["open": (object["questions"] as? [[String: Any]])?.count ?? 0, "answered": 0, "waiting": 0]
            }
        case .smallAmounts:
            // A wallet's first minute: fractions of a cent in PnL, and the longest amounts a warning can sit beside.
            return try demo { object in
                object["points"] = Self.points(every: 15, pnl: [-1500, -2300, -2300, -2300, -2300])
                let amounts = ["ETH": "1648710000000000", "cbBTC": "123", "USDC": "1234567890000", "AERO": "123000000"]
                var positions = object["positions"] as? [[String: Any]] ?? []
                for index in positions.indices {
                    guard let asset = positions[index]["asset"] as? String, let amount = amounts[asset] else { continue }
                    var values = positions[index]["values"] as? [String: Any] ?? [:]
                    values["qty"] = amount
                    positions[index]["values"] = values
                    positions[index]["shortfallQty"] = "1"
                }
                object["positions"] = positions
            }
        case .longHistory:
            // Weeks of history, where a time of day on the axis would say nothing.
            return try demo {
                // Two deposits and a withdrawal, in whole dollars before and after each, with prices moving in between.
                let value = [(0, 1000), (1080, 2080), (2150, 2150), (2010, 2010), (1890, 1390), (1460, 1460), (1420, 1420)]
                let points = Self.points(every: 3 * 86_400, pnl: [1_000_000, 250_000_000, 1_250_000_000, 900_000_000, 400_000_000, 1_100_000_000, 800_000_000], value: value)
                $0["points"] = points
                // At 2 s a block, so what's offered goes back as far as these do.
                $0["coverage"] = ["fromBlock": 53_500_000 - points.count * 3 * 86_400 / 2, "toBlock": 53_500_000]
            }
        case .chartGaps:
            // Unknown on each chart somewhere the other one's known, so each has its own band and key.
            return try demo {
                let value = [(0, 1000), (1080, 2080), (2150, 2150), (2010, 2010), (1890, 1390), (1460, 1460), (1420, 1420)]
                var points = Self.points(every: 3 * 86_400, pnl: [1_000_000, 250_000_000, 1_250_000_000, 900_000_000, 400_000_000, 1_100_000_000, 800_000_000], value: value)
                points[2]["pnlMicros"] = NSNull()
                points[2]["excludedCount"] = 1
                points[4]["valueContinues"] = false
                points[5]["valueMicros"] = NSNull()
                points[5]["valueBeforeMicros"] = NSNull()
                points[5]["valueExcludedCount"] = 1
                $0["points"] = points
                $0["coverage"] = ["fromBlock": 53_500_000 - points.count * 3 * 86_400 / 2, "toBlock": 53_500_000]
            }
        case .busy:
            // A busy wallet's worth of transactions, about one a minute and a half, so the list has to stay quick.
            return try demo { object in
                let start = Date(timeIntervalSince1970: 1_793_800_000 - 65_000 * 97)
                let shapes: [[String: Any]] = (object["points"] as? [[String: Any]] ?? []).filter { $0["txHash"] is String }
                var points: [[String: Any]] = (0..<65_000).map { index in
                    var point = shapes[index % shapes.count]
                    point["blockNum"] = 53_500_000 + index
                    point["timestamp"] = start.addingTimeInterval(Double(index * 97)).formatted(.iso8601)
                    point["txHash"] = "0x" + String(format: "%064x", index)
                    return point
                }
                points.append(["blockNum": 53_565_000, "timestamp": start.addingTimeInterval(65_000 * 97).formatted(.iso8601), "txHash": NSNull(), "pnlMicros": NSNull(), "excludedCount": 0])
                object["points"] = points
            }
        case .answeredWallet:
            // What a wallet being read gets asked about one of the user's own wallets, which isn't what the demo itself would ask.
            return try demo { object in
                var questions = object["questions"] as? [[String: Any]] ?? []
                guard var first = questions.first else { return }
                first["evidence"] = ["You've said this is your wallet. Choose My wallet if the one you're looking at is yours too, or Someone else if it isn't."]
                questions[0] = first
                object["questions"] = questions
            }
        case .allAnswered:
            return try demo { object in
                Self.knowEveryCost(&object)
                object["meter"] = ["open": 0, "answered": 5, "waiting": 0]
            }
        // Nothing to ask, and nothing answered that could settle what's still unknown.
        case .nothingLeft:
            return try demo { object in
                object["questions"] = [Any]()
                object["meter"] = ["open": 0, "answered": 0, "waiting": 0]
            }
        case .empty: return try newWallet(started: true, readingLinked: false, address: context.address)
        case .emptyReadingLinked: return try newWallet(started: true, readingLinked: true, address: context.address)
        case .notStarted: return try newWallet(started: false, readingLinked: false, address: context.address)
        case .firstRun: return try firstRun(address: context.address)
        case .neverAnswers, .updating: try await Task.sleep(for: .seconds(600))
        case .serverDown: throw FetchError.unreachable
        case .stopsAnswering: if read > 1 { throw FetchError.unreachable }
        case .pricesDown: throw FetchError.ampUnavailable("Couldn't read this wallet's data.")
        case .pricesStop: if read > 1 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
        // The server still answers, so the store gives up on the read rather than calling it offline.
        case .tooSlow: throw FetchError.timedOut
        // Fails, then the retry after it takes a while.
        case .retrying:
            if read == 1 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
            try await Task.sleep(for: .seconds(600))
        case .retryingWithNumbers:
            if read == 2 { throw FetchError.ampUnavailable("Couldn't read this wallet's data.") }
            if read > 2 { try await Task.sleep(for: .seconds(600)) }
        case .notStartedFails: throw FetchError.ampUnavailable("Couldn't read this wallet's data.")
        }
        return try Self.decode(fixture("demo-portfolio", context.currency))
    }

    func lastRead(_ read: ReadContext) async throws -> Portfolio? {
        switch feed {
        case .updating: try Self.decode(fixture("demo-portfolio", read.currency))
        // What the server last read, from before the data reached this wallet.
        case .notStartedFails: try newWallet(started: false, readingLinked: false, address: read.address)
        default: nil
        }
    }

    /// The demo, with what it was missing filled in.
    private static func knowEveryCost(_ object: inout [String: Any]) {
        var positions = object["positions"] as? [[String: Any]] ?? []
        for index in positions.indices {
            var values = positions[index]["values"] as? [String: Any] ?? [:]
            guard (values["unknownCostQty"] as? String) != "0" else { continue }
            values["unknownCostQty"] = "0"
            let value = Int64(values["valueMicros"] as? String ?? "") ?? 0
            let cost = value * 9 / 10
            let price = (positions[index]["price"] as? [String: Any])?["micros"] as? String
            values["costMicros"] = String(cost)
            values["averageCostMicros"] = String((Int64(price ?? "") ?? 0) * 9 / 10)
            values["realizedMicros"] = "0"
            values["unrealizedMicros"] = String(value - cost)
            positions[index]["values"] = values
            positions[index]["pnlMicros"] = String(value - cost)
            positions[index]["resolvable"] = false
        }
        object["positions"] = positions
        object["questions"] = [Any]()
        object["pnlStatus"] = "complete"
        var totals = object["totals"] as? [String: Any] ?? [:]
        totals["excluded"] = [Any]()
        totals["unresolvedMicros"] = "0"
        totals["pnlMicros"] = "361230000"
        totals["unrealizedMicros"] = "287050000"
        totals["coverage"] = ["value": ["known": 7, "missing": 0], "realized": ["known": 7, "missing": 0], "unrealized": ["known": 7, "missing": 0], "pnl": ["known": 7, "missing": 0]]
        object["totals"] = totals
    }

    /// Chart points this many seconds apart, the last one being now.
    private static func points(every seconds: Int, pnl: [Int], value: [(before: Int, after: Int)] = []) -> [[String: Any]] {
        let start = Date(timeIntervalSince1970: 1_793_800_000)
        return pnl.enumerated().map { index, micros in
            let isLast = index == pnl.count - 1
            var point: [String: Any] = [
                "blockNum": 53_500_000 + index,
                "timestamp": start.addingTimeInterval(Double(index * seconds)).formatted(.iso8601),
                "txHash": isLast ? NSNull() : "0xde3\(String(repeating: "0", count: 60))\(index)",
                "pnlMicros": String(micros),
                "excludedCount": 0,
            ]
            if value.indices.contains(index) {
                point["valueBeforeMicros"] = String(value[index].before * 1_000_000)
                point["valueMicros"] = String(value[index].after * 1_000_000)
                point["valueExcludedCount"] = 0
                point["valueContinues"] = index > 0
            }
            return point
        }
    }

    /// The demo, changed a little.
    private func demo(_ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        guard let url = Bundle.main.url(forResource: "demo-portfolio", withExtension: "json"), var object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw FetchError.rejected("There's no fixture called demo-portfolio.") }
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// The demo's two wallets as one, as this scene's Savings and Spending Money, with Treasury still being read.
    private func allYours<T: Decodable>(_ name: String, behind: Bool = false) throws -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { throw FetchError.rejected("There's no fixture called \(name).") }
        // The demo's first wallet stands in for savings. Its second is already this scene's Spending Money.
        // `HotWalletFixture.savings`, which is the main actor's.
        let text = try String(contentsOf: url, encoding: .utf8).replacing("0x00000000000000000000000000000000000de300", with: "0x00000000000000000000000000000000000de302")
        guard var object = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else { throw FetchError.rejected("\(name) isn't an object.") }
        if object["positions"] != nil {
            let treasury = "0x00000000000000000000000000000000c0ffee01"
            object["mode"] = "dataset"
            object["latest"] = ["blockNum": 53505400, "timestamp": Date.now.formatted(.iso8601)]
            object["linkedReading"] = [treasury]
            object["wallets"] = (object["wallets"] as? [Any] ?? []) + [["address": treasury, "state": "reading"]]
            // Savings can't be updated and spending money is taking its time, so both are in the numbers as they were last read.
            if behind {
                let wallets = (object["wallets"] as? [[String: Any]] ?? []).compactMap { $0["address"] as? String }
                object["linkedReading"] = [String]()
                object["wallets"] = wallets.enumerated().map { ["address": $1, "state": $0 == 0 ? "updating" : "outdated"] }
                object["linkedUpdating"] = Array(wallets.prefix(1))
                object["linkedOutdated"] = Array(wallets.dropFirst().prefix(1))
            }
        }
        return try JSONDecoder().decode(T.self, from: JSONSerialization.data(withJSONObject: object))
    }

    /// A real wallet with nothing in it yet, optionally waiting on another one, which is a notice above the empty state.
    private func newWallet(started: Bool, readingLinked: Bool, address: String) throws -> Portfolio {
        try demo {
            $0["address"] = address
            $0["mode"] = "dataset"
            $0["positions"] = [Any]()
            $0["points"] = [Any]()
            $0["questions"] = [Any]()
            $0["outgoingTxs"] = [Any]()
            $0["unlisted"] = [Any]()
            $0["progress"] = ["started": started, "behindBlocks": 0]
            // Up to date, so the only notice is the one asked for.
            $0["latest"] = ["blockNum": 53505400, "timestamp": Date.now.formatted(.iso8601)]
            if readingLinked { $0["linkedReading"] = ["0x00000000000000000000000000000000000de302"] }
        }
    }

    /// A real wallet minutes after it was funded, from benface's test in WORK-336: $4 of ETH that arrived with no transaction showing it, a swap to $1 of USDC, and its fee.
    /// It's what most people see first, and it's the demo. The rich demo wallet hides how this looks.
    private func firstRun(address: String) throws -> Portfolio {
        let now = Date.now
        let blockNum = 53_525_400
        func stamp(_ secondsAgo: Double) -> String { now.addingTimeInterval(-secondsAgo).formatted(.iso8601) }
        func position(_ asset: String, decimals: Int, note: Any, price: String, qty: String, unknownCostQty: String, averageCost: Any, value: String, realized: Any, unrealized: Any, pnl: Any, check: [String: Any], resolvable: Bool) -> [String: Any] {
            [
                "asset": asset, "decimals": decimals, "note": note,
                "price": ["micros": price, "source": "oracle", "blockNum": blockNum],
                "values": ["qty": qty, "unknownCostQty": unknownCostQty, "costMicros": averageCost is NSNull ? NSNull() : "1000000", "averageCostMicros": averageCost, "valueMicros": value, "realizedMicros": realized, "unrealizedMicros": unrealized, "estimatedCostMicros": "0", "estimatedRealizedMicros": "0"],
                "pnlMicros": pnl, "shortfallQty": "0", "legCount": 3, "reconciliation": check, "noMarket": false,
                "estimates": ["cost": false, "value": false, "realized": false, "unrealized": false],
                "resolvable": resolvable,
            ]
        }
        return try demo {
            $0["address"] = address
            $0["mode"] = "dataset"
            $0["coverage"] = ["fromBlock": 53_515_000, "toBlock": blockNum]
            $0["latest"] = ["blockNum": blockNum, "timestamp": stamp(0)]
            $0["progress"] = ["started": true, "behindBlocks": 0]
            $0["questions"] = [Any]()
            $0["unlisted"] = [Any]()
            $0["outgoingTxs"] = ["0x" + String(repeating: "a1", count: 32)]
            $0["meter"] = ["open": 0, "answered": 0, "waiting": 0]
            $0["positions"] = [
                position("ETH", decimals: 18, note: "incl. wrapped ETH", price: "2426000000", qty: "1648711832883181", unknownCostQty: "1648711832883181", averageCost: NSNull(), value: "4000000", realized: NSNull(), unrealized: NSNull(), pnl: NSNull(), check: ["status": "incomplete", "blockNum": blockNum, "computedQty": "-413118167116819", "actualQty": "1648711832883181", "differenceQty": "2061830000000000"], resolvable: false),
                position("USDC", decimals: 6, note: NSNull(), price: "1000000", qty: "1000000", unknownCostQty: "0", averageCost: "999800", value: "1000000", realized: "0", unrealized: "0", pnl: "0", check: ["status": "reconciled", "blockNum": blockNum, "computedQty": "1000000", "actualQty": "1000000", "differenceQty": "0"], resolvable: false),
            ]
            $0["totals"] = [
                "valueMicros": "5000000", "realizedMicros": NSNull(), "unrealizedMicros": "0", "gasMicros": "2300", "pnlMicros": "-2300",
                "excluded": [["asset": "ETH", "reason": "doesn't match its actual balance"]],
                "unpricedGas": false,
                "coverage": ["value": ["known": 2, "missing": 0], "realized": ["known": 0, "missing": 1], "unrealized": ["known": 1, "missing": 1], "pnl": ["known": 1, "missing": 1]],
                "unresolvedMicros": "4000000", "estimatedMicros": "0",
                "estimated": ["value": false, "realized": false, "unrealized": false],
                "noMarket": [Any](),
            ]
            $0["pnlStatus"] = "partial"
            $0["points"] = [
                ["blockNum": blockNum - 30, "timestamp": stamp(70), "txHash": "0x" + String(repeating: "a1", count: 32), "pnlMicros": "-2300", "excludedCount": 1],
                ["blockNum": blockNum, "timestamp": stamp(0), "txHash": NSNull(), "pnlMicros": "-2300", "excludedCount": 1],
            ]
            $0["holdComparison"] = [
                "walletMicros": "-2300", "gainThatLeftMicros": "0", "walletLeavesOut": true, "walletEstimated": false, "putInMicros": "0", "takenOutMicros": "0", "ethPriceMicros": "2426000000", "unknownAmounts": 1, "ranOut": false,
                "status": "unavailable", "unavailable": "nothing known put in", "holdMicros": NSNull(), "differenceMicros": NSNull(), "ethQty": "0", "ethValueMicros": "0", "estimated": false,
            ]
        }
    }

    func explanation(of target: ExplainTarget, _ read: ReadContext, shown: [String]?) async throws -> Explanation {
        if feed == .firstRun {
            // In the words `onchainLines` in `src/core/explain.ts` uses for this balance.
            let object: [String: Any] = ["currency": read.currency.rawValue, "title": "ETH: Balance check", "value": NSNull(), "sourceValue": NSNull(), "legCount": 0, "legs": [Any](), "lines": [
                "Worked out from its transactions: -0.00041 ETH.",
                "Actual balance at block 53,525,400: 0.00164 ETH.",
                "Difference: +0.00206 ETH.",
                "This wallet holds more ETH than its transactions explain. Most likely a contract sent it some, which we can't see yet.",
                "Value uses the actual balance. PnL is unavailable, because we know some of this wallet's activity is missing.",
            ]]
            return try JSONDecoder().decode(Explanation.self, from: JSONSerialization.data(withJSONObject: object))
        }
        if feed == .allYours { return try allYours("all-yours-demo-explanation") }
        return try Self.decode(target == .holdComparison ? "demo-hold-explanation" : fixture("demo-explanation", read.currency))
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        throw FetchError.unreachable
    }

    func verification(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Verification {
        throw FetchError.unreachable
    }

    func taxReport(_ request: TaxReportRequest) async throws -> TaxReport {
        try Self.decode("demo-tax-report")
    }

    /// The demo's, said of whichever wallet asks.
    func approvals(address: String) async throws -> WalletApprovals {
        (try Self.decode("demo-approvals") as WalletApprovals).said(of: address)
    }

    /// What each answer would do, as the demo's own numbers, so a card shows them in place.
    func previews(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], candidates: [Book]) async throws -> [BookPreview] {
        let totals = (try Self.decode(fixture("demo-portfolio", currency)) as Portfolio).totals
        return candidates.map { _ in BookPreview(pnlMicros: totals.pnlMicros, pnlStatus: .partial, estimatedMicros: totals.estimatedMicros, unresolvedMicros: totals.unresolvedMicros, open: 4, pending: false, failed: false) }
    }

    private func fixture(_ name: String, _ currency: CurrencyCode) -> String {
        currency == .USD ? name : "\(name)-\(currency.rawValue.lowercased())"
    }

    static func decode<T: Decodable>(_ name: String) throws -> T {
        guard let url = Bundle.main.url(forResource: name, withExtension: "json") else { throw FetchError.rejected("There's no fixture called \(name).") }
        return try JSONDecoder().decode(T.self, from: Data(contentsOf: url))
    }
}
#endif
