import Foundation
import Testing
@testable import PricetagKit

@Suite struct TransactionLogTests {
    let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }()

    func log(signed: [SentTransaction] = [], names: [String: String] = [:]) throws -> TransactionLog {
        TransactionLog(points: try demoPortfolio().points, signed: signed, names: names, calendar: utc)
    }

    @Test func readsWhatTheServerSaysAboutEachTransaction() throws {
        let funded = try #require(try log().items.last)
        #expect(funded.summary == "Received 5,000 USDC")
        #expect(funded.amount == TransactionAmount(direction: .in, micros: "4999000000"))
        #expect(funded.unknownCost == ["USDC"])
        #expect(funded.gain == nil)
        let sale = try #require(try log().items.first { $0.summary == "Sold 300 AERO for 450 USDC" })
        #expect(sale.gain == TransactionGain(micros: "74985000", estimated: false))
    }

    @Test func listsNewestFirstWithoutTheLastPoint() throws {
        let items = try log().items
        #expect(items.count == 12)
        #expect(items.first?.summary == "Sent 0.002 ETH")
        #expect(items.allSatisfy { $0.isRead })
    }

    @Test func namesTheOtherPartyWhenTheWalletKnowsThem() throws {
        let savings = "0x00000000000000000000000000000000000de301"
        let items = try log(names: [savings: "Savings"]).items
        #expect(items.first?.counterpartyTitle == "Savings")
        // With no name, its address, short.
        #expect(items.first { $0.summary == "Received 0.02 ETH" }?.counterpartyTitle == "0x0000…be11")
        #expect(items.first { $0.summary == "Bought 1 ETH for 2,400 USDC" }?.counterpartyTitle == nil)
    }

    @Test func searchesWhatHappenedTokensNamesAddressesAndHashes() throws {
        let log = try log(names: ["0x00000000000000000000000000000000000de301": "Savings"])
        #expect(log.filtered(query: "aero", asset: nil).count == 2)
        #expect(log.filtered(query: "savings", asset: nil).count == 2)
        #expect(log.filtered(query: "be11", asset: nil).map(\.summary) == ["Received 0.02 ETH"])
        #expect(log.filtered(query: "0xde3000000000000000000000000000000000000000000000000000000000000c", asset: nil).count == 1)
        // Every word has to match, in any order.
        #expect(log.filtered(query: "usdc sold", asset: nil).map(\.summary) == ["Sold 0.5 ETH for 1,300 USDC", "Sold 300 AERO for 450 USDC"])
        #expect(log.filtered(query: "  ", asset: nil).count == 12)
    }

    @Test func filtersByToken() throws {
        let log = try log()
        #expect(log.assets == ["AERO", "cbBTC", "DEGEN", "ETH", "USDC", "USDT", "VIRTUAL"])
        #expect(log.filtered(query: "", asset: "cbBTC").map(\.summary) == ["Received 0.02 cbBTC"])
        #expect(log.filtered(query: "bought", asset: "USDC").count == 4)
        // A fee moved no token, so a token filter leaves it out.
        #expect(!log.filtered(query: "", asset: "ETH").contains { $0.summary == "Network fee of $0.10" })
    }

    @Test func groupsByDayWithTodayAndYesterdayByName() throws {
        let log = try log()
        let now = try #require(log.items.first?.date)
        let days = log.days(query: "", asset: nil, now: now, calendar: utc)
        #expect(days.map(\.title) == ["Today"])
        #expect(days[0].items.count == 12)
        #expect(log.days(query: "", asset: nil, now: now.addingTimeInterval(86400), calendar: utc).map(\.title) == ["Yesterday"])
        #expect(log.days(query: "", asset: nil, now: now.addingTimeInterval(3 * 86400), calendar: utc).map(\.title) == ["Wednesday, November 4"])
        #expect(log.days(query: "", asset: nil, now: now.addingTimeInterval(400 * 86400), calendar: utc).map(\.title) == ["Wednesday, November 4, 2026"])
    }

    @Test func showsWhatThisMacSentBeforeItsRead() throws {
        let sending = SentTransaction(txHash: "0xABC", date: .now, summary: "Sending 10 USDC", to: "0x00000000000000000000000000000000000DE301", asset: "USDC", status: .pending)
        let log = try log(signed: [sending], names: ["0x00000000000000000000000000000000000de301": "Savings"])
        let first = try #require(log.items.first)
        #expect(first.status == .pending)
        #expect(!first.isRead)
        #expect(first.counterpartyTitle == "Savings")
        #expect(log.filtered(query: "0xabc", asset: "USDC").count == 1)
    }

    @Test func putsWhatThisMacSentWhereItsDateFallsAmongTheRest() throws {
        let points = try demoPortfolio().points
        let between = try #require(points[5].date).addingTimeInterval(1)
        let failed = SentTransaction(txHash: "0xf00", date: between, summary: "Send 1 USDC", to: nil, asset: "USDC", status: .failed)
        let old = SentTransaction(txHash: "0xf01", date: .distantPast, summary: "Send 2 USDC", to: nil, asset: "USDC", status: .failed)
        let items = TransactionLog(points: points, signed: [old, failed], calendar: utc).items
        let index = try #require(items.firstIndex { $0.txHash == "0xf00" })
        #expect(items[index + 1].txHash == points[5].txHash)
        #expect(items.last?.txHash == "0xf01")
    }

    @Test func marksAReadTransactionThatFailed() throws {
        let fee = try #require(try demoPortfolio().points.first { $0.summary == "Network fee of $0.10" }?.txHash)
        let failed = SentTransaction(txHash: fee, date: .now, summary: "Send 1 USDC", to: nil, asset: "USDC", status: .failed)
        let log = try log(signed: [failed])
        #expect(log.items.count == 12)
        #expect(log.items.first { $0.txHash == fee }?.status == .failed)
        #expect(log.items.first { $0.txHash == fee }?.isRead == true)
    }

    @Test func aDayWithNoDateKeepsItsOwnPlace() {
        let points = [
            PnlPoint(blockNum: 1, timestamp: "2026-11-04T08:00:00.000Z", txHash: "0x1", pnlMicros: nil, excludedCount: 0),
            PnlPoint(blockNum: 2, timestamp: "not a date", txHash: "0x2", pnlMicros: nil, excludedCount: 0),
            PnlPoint(blockNum: 3, timestamp: "2026-11-04T09:00:00.000Z", txHash: "0x3", pnlMicros: nil, excludedCount: 0),
        ]
        let days = TransactionLog(points: points, calendar: utc).days(query: "", asset: nil, now: .distantFuture, calendar: utc)
        #expect(days.map(\.title).count == 3)
        #expect(Set(days.map(\.id)).count == 3)
    }

    @Test func saysWhichWayMoneyWentAndWhatASaleMade() throws {
        let log = try log(names: ["0x00000000000000000000000000000000000de301": "Savings"])
        func item(_ summary: String) throws -> TransactionItem { try #require(log.items.first { $0.summary == summary }) }
        #expect(try item("Received 5,000 USDC").amountText(.USD) == "+$4,999.00")
        #expect(try item("Received 5,000 USDC").counterpartyText == "From Savings")
        #expect(try item("Sent 0.002 ETH").amountText(.USD) == "-$5.24")
        #expect(try item("Sent 0.002 ETH").counterpartyText == "To Savings")
        #expect(try item("Network fee of $0.10").amountText(.USD) == "-$0.10")
        #expect(try item("Sold 300 AERO for 450 USDC").amountText(.USD) == "$449.91")
        #expect(try item("Sold 300 AERO for 450 USDC").gainText(.USD) == "+$74.99")
        // Unknown is never $0, and a send realizes nothing to show.
        #expect(try item("Sold 0.5 ETH for 1,300 USDC").gainText(.USD) == "Unknown")
        #expect(try item("Sent 0.002 ETH").gainText(.USD) == nil)
        // Paid next to nothing, which isn't an unknown amount.
        #expect(try item("Bought 50,000 DEGEN for 0.000001 USDC").amountText(.USD) == "$0.00")
    }

    /// A busy wallet has about 65,000 transactions. Reading them, then searching as someone types, has to stay quick.
    @Test func staysQuickWithABusyWallet() throws {
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        let points = (0..<65_000).map { i in
            var point = PnlPoint(blockNum: i, timestamp: start.addingTimeInterval(Double(i) * 97).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true)), txHash: String(format: "0x%064x", i), pnlMicros: "1000000", excludedCount: 0)
            point.summary = i.isMultiple(of: 3) ? "Bought 1 ETH for 2,400 USDC" : "Received 5 USDC"
            point.assets = i.isMultiple(of: 3) ? ["USDC", "ETH"] : ["USDC"]
            point.counterparty = String(format: "0x%040x", i % 50)
            return point
        }
        let clock = ContinuousClock()
        var log: TransactionLog?
        let building = clock.measure { log = TransactionLog(points: points, calendar: utc) }
        let built = try #require(log)
        var days: [TransactionDay] = []
        let searching = clock.measure { days = built.days(query: "eth", asset: "USDC", now: .now, calendar: utc) }
        let all = clock.measure { days = built.days(query: "", asset: nil, now: .now, calendar: utc) }
        print("65,000 transactions: built in \(building), searched in \(searching), grouped in \(all), \(days.count) days")
        #expect(days.reduce(0) { $0 + $1.items.count } == 65_000)
        // Alone in a debug build, about 0.4 s and 0.08 s. Other suites run beside this one and can slow it tenfold, so these only catch something far worse.
        #expect(building < .seconds(15))
        #expect(searching < .seconds(3))
    }
}
