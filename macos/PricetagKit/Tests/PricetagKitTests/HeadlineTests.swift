import Foundation
@testable import PricetagKit
import Testing

/// The headline's numbers carry no marks of their own, so the one line under them has to say whatever they leave out or estimate.
@Suite struct HeadlineTests {
    private func changed(_ change: (inout [String: Any]) -> Void) throws -> Portfolio {
        var object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(demoPortfolio())) as! [String: Any]
        var totals = object["totals"] as! [String: Any]
        change(&totals)
        object["totals"] = totals
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    @Test func theNumbersAreBare() throws {
        let portfolio = try demoPortfolio()
        #expect(portfolio.totalValueText == "$7,571.03")
        #expect(portfolio.totalPnlText == "+$149.30")
        #expect(portfolio.totalStats.allSatisfy { $0.text?.hasPrefix("≈") != true })
        #expect(portfolio.attention != nil)
    }

    @Test func aValueFromTheMarketIsSaidToBeAnEstimate() throws {
        let portfolio = try changed { totals in
            totals["estimatedMicros"] = "0"
            totals["unresolvedMicros"] = "0"
            totals["excluded"] = [Any]()
        }
        #expect(portfolio.totals.estimated.value)
        let attention = try #require(portfolio.attention)
        #expect(([attention.title] + attention.details).contains(Wording.marketEstimates))
    }

    @Test func aPartialValueIsSaidEvenWhenNothingNamesIt() throws {
        let portfolio = try changed { totals in
            totals["estimatedMicros"] = "0"
            totals["unresolvedMicros"] = "0"
            totals["excluded"] = [Any]()
            totals["estimated"] = ["value": false, "realized": false, "unrealized": false]
            var coverage = totals["coverage"] as! [String: Any]
            coverage["value"] = ["known": 6, "missing": 1]
            totals["coverage"] = coverage
        }
        #expect(portfolio.isValuePartial)
        #expect(portfolio.attention?.title == portfolio.partialValueReason)
    }
}
