import Foundation
@testable import PricetagKit
import Testing

/// The headline's numbers carry no marks of their own, so the one line under them has to say whatever they leave out or estimate,
/// in the window and in the popover, even when something else takes its title.
@Suite struct HeadlineTests {
    private func changed(_ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func totals(_ object: inout [String: Any], _ change: (inout [String: Any]) -> Void) {
        var totals = object["totals"] as! [String: Any]
        change(&totals)
        object["totals"] = totals
    }

    private func coverage(_ totals: inout [String: Any], _ key: String, known: Int, missing: Int) {
        var coverage = totals["coverage"] as! [String: Any]
        coverage[key] = ["known": known, "missing": missing]
        totals["coverage"] = coverage
    }

    private let nothingEstimated: [String: Any] = ["value": false, "realized": false, "unrealized": false]

    @Test func theNumbersAreBare() throws {
        let portfolio = try demoPortfolio()
        #expect(portfolio.totalValueText == "$7,571.03")
        #expect(portfolio.totalPnlText == "+$149.30")
        #expect(portfolio.totalStats.allSatisfy { $0.text?.hasPrefix("≈") != true })
        #expect(portfolio.attention != nil)
    }

    /// The review's case: a sale at an unknown cost, and an estimate that takes the title.
    @Test func aPnlThatLeavesOutASaleSaysSoBesideAnEstimate() throws {
        let portfolio = try changed { object in
            totals(&object) { totals in
                totals["unresolvedMicros"] = "0"
                totals["estimatedMicros"] = "199980000"
                totals["excluded"] = [["asset": "USDC", "reason": "sold or spent at an unknown cost"]]
            }
        }
        #expect(portfolio.pnlStatus == .partial)
        let attention = try #require(portfolio.attention)
        #expect(attention.title == "$199.98 is estimated.")
        #expect(attention.details.first == "PnL leaves out USDC.")
        #expect(portfolio.shortAttention == "PnL leaves out USDC")
    }

    /// A holding with no price, beside unknown costs that take the title.
    @Test func aValueThatLeavesOutAHoldingSaysWhich() throws {
        let portfolio = try changed { object in
            var positions = object["positions"] as! [[String: Any]]
            let index = positions.firstIndex { $0["asset"] as? String == "AERO" }!
            var values = positions[index]["values"] as! [String: Any]
            values["valueMicros"] = NSNull()
            positions[index]["values"] = values
            object["positions"] = positions
            totals(&object) { totals in
                coverage(&totals, "value", known: 6, missing: 1)
                totals["excluded"] = (totals["excluded"] as! [[String: Any]]) + [["asset": "AERO", "reason": "no current price"]]
            }
        }
        #expect(portfolio.isValuePartial)
        let attention = try #require(portfolio.attention)
        #expect(attention.title.hasPrefix("$3,603.42 has an unknown cost"))
        #expect(attention.details.first == "The value leaves out AERO, which has no price right now.")
        #expect(attention.details.contains { $0.hasPrefix("PnL also leaves out") && $0.contains("AERO") })
        #expect(portfolio.shortAttention == "The value leaves out AERO")
    }

    @Test func anUnknownCostAloneSaysEnough() throws {
        let portfolio = try changed { object in
            totals(&object) { totals in
                totals["estimatedMicros"] = "0"
                totals["excluded"] = [["asset": "DAI", "reason": "unknown cost"]]
            }
        }
        let attention = try #require(portfolio.attention)
        #expect(attention.title == "$3,603.42 has an unknown cost, so it isn't in the PnL.")
        #expect(!attention.details.contains { $0.contains("leaves out") })
        #expect(portfolio.shortAttention == "$3,603.42 has an unknown cost")
    }

    @Test func aValueFromTheMarketIsSaidToBeAnEstimate() throws {
        let portfolio = try changed { object in
            totals(&object) { totals in
                totals["estimatedMicros"] = "0"
                totals["unresolvedMicros"] = "0"
                totals["excluded"] = [Any]()
            }
        }
        #expect(portfolio.totals.estimated.value)
        let attention = try #require(portfolio.attention)
        #expect(([attention.title] + attention.details).contains(Wording.marketEstimates))
    }

    @Test func aPartialValueIsSaidEvenWhenNothingNamesIt() throws {
        let portfolio = try changed { object in
            totals(&object) { totals in
                totals["estimatedMicros"] = "0"
                totals["unresolvedMicros"] = "0"
                totals["excluded"] = [Any]()
                totals["estimated"] = nothingEstimated
                coverage(&totals, "value", known: 6, missing: 1)
            }
        }
        #expect(portfolio.isValuePartial)
        #expect(portfolio.attention?.title == "The value isn't complete.")
        #expect(portfolio.shortAttention == "The value isn't complete")
    }

    /// The review's second case: a balance that couldn't be read keeps its value, so it isn't left out.
    @Test func aBalanceThatCouldntBeCheckedIsInTheValueAndSaidToBeUncertain() throws {
        let portfolio = try changed { object in
            var positions = object["positions"] as! [[String: Any]]
            let index = positions.firstIndex { $0["asset"] as? String == "USDC" }!
            var reconciliation = positions[index]["reconciliation"] as! [String: Any]
            reconciliation["status"] = "unchecked"
            reconciliation["heldIsCurrent"] = false
            positions[index]["reconciliation"] = reconciliation
            object["positions"] = positions
            totals(&object) { totals in
                coverage(&totals, "value", known: 6, missing: 1)
                totals["excluded"] = (totals["excluded"] as! [[String: Any]]) + [["asset": "USDC", "reason": "not checked against its actual balance"]]
            }
        }
        #expect(portfolio.isValuePartial)
        #expect(portfolio.totalValueText == "$7,571.03")
        let attention = try #require(portfolio.attention)
        #expect(attention.details.first == "Couldn't check the balance of USDC, so its value is an estimate.")
        #expect(!([attention.title] + attention.details).contains { $0.contains("value leaves out USDC") })
        #expect(portfolio.shortAttention == "Couldn't check the balance of USDC")
    }

    /// Fees that couldn't be worked out leave the PnL partial with nothing in the list, beside an estimate that takes the title.
    @Test func missingFeesKeepThePnlIncompleteAheadOfAnEstimate() throws {
        let portfolio = try changed { object in
            object["gasUnknownTxs"] = ["0x" + String(repeating: "ab", count: 32)]
            totals(&object) { totals in
                totals["unresolvedMicros"] = "0"
                totals["estimatedMicros"] = "199980000"
                totals["excluded"] = [Any]()
            }
        }
        #expect(portfolio.pnlStatus == .partial)
        let attention = try #require(portfolio.attention)
        #expect(attention.title == "$199.98 is estimated.")
        #expect(attention.details.contains(Wording.feesUnknown(1)))
        #expect(portfolio.shortAttention == "PnL leaves out some network fees")
    }

    @Test func aPartialPnlWithNothingNamedStillSaysSo() throws {
        let portfolio = try changed { object in
            totals(&object) { totals in
                totals["unresolvedMicros"] = "0"
                totals["estimatedMicros"] = "199980000"
                totals["excluded"] = [Any]()
            }
        }
        let attention = try #require(portfolio.attention)
        #expect(attention.details.first == "PnL isn't complete.")
        #expect(portfolio.shortAttention == "PnL isn't complete")
        let bare = try changed { object in
            totals(&object) { totals in
                totals["unresolvedMicros"] = "0"
                totals["estimatedMicros"] = "0"
                totals["excluded"] = [Any]()
                totals["estimated"] = nothingEstimated
            }
        }
        #expect(bare.attention?.title == "PnL isn't complete.")
    }
}
