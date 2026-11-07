import Foundation
import Testing
@testable import PricetagKit

@Suite struct MenuTests {
    @Test func copiesAHoldingAsItsRowShowsIt() throws {
        let portfolio = try demoPortfolio()
        let usdc = try #require(portfolio.positions.first { $0.asset == "USDC" })
        let cells = usdc.copyText(currency: portfolio.currency).components(separatedBy: "\t")
        #expect(cells.count == 6)
        #expect(cells[0] == "USDC")
        #expect(cells[1] == Format.amount(usdc.values.qty, decimals: usdc.decimals))
        #expect(cells[2] == usdc.price.map { Format.estimate(Format.price($0.micros, portfolio.currency), usdc.estimates.value) })
        // Unknown stays unknown, and never reads as $0 or 0%.
        #expect(cells[4] == "Cost unknown")
        #expect(cells[5] == Wording.unknown)
    }

    @Test func copiesAHoldingsReturn() throws {
        let portfolio = try demoPortfolio()
        let known = try #require(portfolio.positions.first { $0.isHeld && $0.returnBps != nil })
        let cells = known.copyText(currency: portfolio.currency).components(separatedBy: "\t")
        #expect(cells[5] == known.returnText)
        #expect(cells[5].contains("%"))
    }

    @Test func aHoldingNoLongerHeldHasNoValueOrReturn() throws {
        let portfolio = try demoPortfolio()
        let aero = try #require(portfolio.positions.first { $0.asset == "AERO" })
        var json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(aero)) as? [String: Any])
        var values = try #require(json["values"] as? [String: Any])
        values["qty"] = "0"
        json["values"] = values
        let sold = try JSONDecoder().decode(Position.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(!sold.isHeld)
        let cells = sold.copyText(currency: portfolio.currency).components(separatedBy: "\t")
        #expect(cells[3] == "—")
        #expect(cells[5] == "—")
    }

    @Test func findsAHoldingByItsTokenOrNote() throws {
        let portfolio = try demoPortfolio()
        let usdc = try #require(portfolio.positions.first { $0.asset == "USDC" })
        #expect(usdc.matches(""))
        #expect(usdc.matches("  "))
        #expect(usdc.matches("usd"))
        #expect(!usdc.matches("aero"))
        #expect(!usdc.matches("usd aero"))
        let noted = try #require(portfolio.positions.first { $0.note != nil })
        #expect(noted.matches("wrapped"))
    }

    @Test func linksOnlyToPagesThatExist() {
        let hash = "0x" + String(repeating: "ab", count: 32)
        #expect(Basescan.transaction(hash)?.absoluteString == "https://basescan.org/tx/\(hash)")
        #expect(Basescan.transaction("") == nil)
        #expect(Basescan.transaction("0x1234") == nil)
        let address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
        #expect(Basescan.address(address)?.absoluteString == "https://basescan.org/address/\(address)")
        #expect(Basescan.address(WalletAddress.demo) == nil)
    }
}
