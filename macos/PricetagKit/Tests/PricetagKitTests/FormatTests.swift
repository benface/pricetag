import Foundation
import Testing
@testable import PricetagKit

/// `test/portfolio.test.ts` writes the vectors from the web app's formatters, so both print the same thing.
struct FormatVectors: Decodable {
    struct USD: Decodable { let micros, usd, signed: String }
    struct Price: Decodable { let micros, price, cad: String }
    struct Amount: Decodable {
        let units: String
        let decimals: Int
        let amount, signed: String
    }
    struct LabeledUSD: Decodable { let text, usd, cad: String }
    struct Span: Decodable {
        let ms: Int
        let duration: String
    }
    struct ChartTick: Decodable { let value: Double; let label: String }
    struct ChartTicks: Decodable {
        let values: [Double]
        let usd, cad: [ChartTick]
    }
    struct BlockSpan: Decodable {
        let from, to, ms: Int
    }
    struct BlocksBefore: Decodable {
        let block, ms, before: Int
    }
    struct PlainAmount: Decodable {
        let text: String
        let plain: String?
    }
    struct Other: Decodable {
        struct OtherPrice: Decodable { let micros, price: String }
        struct OtherTicks: Decodable {
            let values: [Double]
            let ticks: [ChartTick]
        }
        let currency: CurrencyCode
        let label: String
        let paid: String
        let money: [USD]
        let price: [OtherPrice]
        let chartTicks: [OtherTicks]
    }
    struct Typed: Decodable {
        let currency: CurrencyCode
        let text: String
        let micros: String?
    }
    let usd: [USD]
    let cad: [USD]
    let price: [Price]
    let others: [Other]
    let labeledUsd: [LabeledUSD]
    let amount: [Amount]
    let chartTicks: [ChartTicks]
    let duration: [Span]
    let blockSpans: [BlockSpan]
    let blocksBefore: [BlocksBefore]
    let plainAmount: [PlainAmount]
    let typed: [Typed]
    let presetFiat: [CurrencyCode]
    struct Return: Decodable { let bps, text: String }
    let returns: [Return]
}

@Suite struct FormatTests {
    @Test func elapsedTimeTicksBySeconds() {
        #expect(Format.elapsed(seconds: 0) == "0 s")
        #expect(Format.elapsed(seconds: 42) == "42 s")
        #expect(Format.elapsed(seconds: 60) == "1 min")
        #expect(Format.elapsed(seconds: 72) == "1 min 12 s")
        #expect(Format.elapsed(seconds: 3720) == "1 h 2 min")
    }

    let vectors: FormatVectors

    init() throws {
        vectors = try resource("format-vectors", as: FormatVectors.self)
    }

    @Test func usdMatchesTheWebApp() {
        for vector in vectors.usd {
            #expect(Format.money(vector.micros, .USD) == vector.usd, "\(vector.micros)")
            #expect(Format.signedMoney(vector.micros, .USD) == vector.signed, "\(vector.micros)")
        }
    }

    @Test func cadMatchesTheWebApp() {
        for vector in vectors.cad {
            #expect(Format.money(vector.micros, .CAD) == vector.usd, "\(vector.micros)")
            #expect(Format.signedMoney(vector.micros, .CAD) == vector.signed, "\(vector.micros)")
        }
    }

    @Test func aTypedCostMatchesTheWebApp() {
        #expect(vectors.typed.contains { $0.currency == .EUR && $0.text == "$46" && $0.micros == nil })
        for vector in vectors.typed {
            #expect(Format.micros(fromDollars: vector.text, in: vector.currency) == vector.micros, "\(vector.currency) \(vector.text)")
        }
    }

    @Test func theBuySheetKnowsWhatCoinbaseCanStartFrom() {
        #expect(PurchaseWording.startsFromAmountIn == Set(vectors.presetFiat), "PRESET_FIAT in server/coinbase.ts")
    }

    @Test func returnsMatchTheWebApp() {
        #expect(vectors.returns.contains { $0.bps == "1234" && $0.text == "+12.3%" })
        for vector in vectors.returns {
            #expect(Format.percent(bps: vector.bps) == vector.text, "\(vector.bps)")
        }
    }

    @Test func plainAmountMatchesTheWebApp() {
        #expect(vectors.plainAmount.contains { $0.text == "46,20" && $0.plain == "46.20" })
        for vector in vectors.plainAmount {
            #expect(Format.plainAmount(vector.text) == vector.plain, "\(vector.text)")
        }
    }

    @Test func everyCurrencyCanBeChosenAsTheMainCurrency() {
        #expect(CurrencyCode.mainChoices == CurrencyCode.allCases, "Beside MAIN_CURRENCY_CODES in currency.ts")
    }

    @Test func otherCurrenciesMatchTheWebApp() {
        #expect(vectors.others.map(\.currency) == CurrencyCode.allCases.filter { $0 != .USD && $0 != .CAD })
        for other in vectors.others {
            #expect(other.currency.label == other.label, "\(other.currency)")
            #expect(Format.money(Money(micros: "25810000", currency: other.currency), beside: .USD) == other.paid, "\(other.currency)")
            for vector in other.money {
                #expect(Format.money(vector.micros, other.currency) == vector.usd, "\(other.currency) \(vector.micros)")
                #expect(Format.signedMoney(vector.micros, other.currency) == vector.signed, "\(other.currency) \(vector.micros)")
            }
            for vector in other.price {
                #expect(Format.price(vector.micros, other.currency) == vector.price, "\(other.currency) \(vector.micros)")
            }
            for vector in other.chartTicks {
                #expect(ChartAxis.moneyTicks(vector.values, other.currency).map(\.label) == vector.ticks.map(\.label), "\(other.currency) \(vector.values)")
            }
        }
    }

    @Test func priceMatchesTheWebApp() {
        for vector in vectors.price {
            #expect(Format.price(vector.micros, .USD) == vector.price, "\(vector.micros)")
            #expect(Format.price(vector.micros, .CAD) == vector.cad, "\(vector.micros)")
        }
    }

    @Test func labeledUSDMatchesTheWebApp() {
        for vector in vectors.labeledUsd {
            #expect(Format.usd(vector.text, beside: .USD) == vector.usd, "\(vector.text)")
            #expect(Format.usd(vector.text, beside: .CAD) == vector.cad, "\(vector.text)")
        }
    }

    @Test func amountMatchesTheWebApp() {
        for vector in vectors.amount {
            #expect(Format.amount(vector.units, decimals: vector.decimals) == vector.amount, "\(vector.units)")
            #expect(Format.signedAmount(vector.units, decimals: vector.decimals) == vector.signed, "\(vector.units)")
        }
    }

    @Test func chartTicksMatchTheWebApp() {
        for vector in vectors.chartTicks {
            for (currency, expected) in [(CurrencyCode.USD, vector.usd), (.CAD, vector.cad)] {
                let ticks = ChartAxis.moneyTicks(vector.values, currency)
                #expect(ticks.map(\.label) == expected.map(\.label), "\(vector.values)")
                #expect(ticks.map(\.value).elementsEqual(expected.map(\.value)) { abs($0 - $1) < 1e-9 }, "\(vector.values)")
            }
        }
    }

    @Test func durationMatchesTheWebApp() {
        for vector in vectors.duration {
            #expect(Format.duration(ms: vector.ms) == vector.duration, "\(vector.ms)")
        }
    }

    @Test func blockTimesMatchTheWebApp() {
        for vector in vectors.blockSpans {
            #expect(BlockTime.msBetween(vector.from, vector.to) == vector.ms, "\(vector.from) \(vector.to)")
        }
        for vector in vectors.blocksBefore {
            #expect(BlockTime.blockBefore(vector.block, ms: vector.ms) == vector.before, "\(vector.block) \(vector.ms)")
        }
    }

    @Test func shortensHashes() {
        #expect(Format.shortHash("0x1234567890abcdef") == "0x1234…cdef")
        #expect(Format.groupedAddress("0x52908400098527886E0F7030069857D2E4169EE7") == ["0x5290 8400 0985 2788 6E0F", "7030 0698 57D2 E416 9EE7"])
        // Every character is still there, in order, so nothing is lost by grouping.
        #expect(Format.groupedAddress("0x52908400098527886E0F7030069857D2E4169EE7").joined().filter { !$0.isWhitespace } == "0x52908400098527886E0F7030069857D2E4169EE7")
    }
}

struct DisplayFormatTests {
    @Test func splitsOnlyCentsOffABigAmount() {
        func joined(_ text: String) -> String {
            let parts = Format.amountParts(text)
            return parts.mark + parts.main + parts.cents
        }
        #expect(Format.amountParts("$7,571.03") == ("", "$7,571", ".03"))
        #expect(Format.amountParts("≈+$149.30") == ("≈", "+$149", ".30"))
        #expect(Format.amountParts("US$12.50") == ("", "US$12", ".50"))
        // On these, the decimals are the amount, or there aren't any.
        #expect(Format.amountParts("$0.0023") == ("", "$0.0023", ""))
        #expect(Format.amountParts("$1,234") == ("", "$1,234", ""))
        #expect(Format.amountParts("Unknown") == ("", "Unknown", ""))
        #expect(Format.amountParts("—") == ("", "—", ""))
        for text in ["$7,571.03", "≈-$0.81", "$0.0023", "≈$1,000,000.00", "No price", ""] {
            #expect(joined(text) == text)
        }
    }

    @Test func groupsAnAddressWithoutChangingIt() {
        let address = "0x00000000000000000000000000000000000dE302"
        let groups = Format.addressGroups(address)
        #expect(groups.first == "0x")
        #expect(groups.count == 11)
        #expect(groups.joined() == address)
    }

    @Test func onlyReadsADirectionFromNumbers() {
        #expect(Format.direction(of: "≈+$1,149.30") == 1149.30)
        #expect(Format.direction(of: "-$0.81") == -0.81)
        #expect(Format.direction(of: "Unknown") == nil)
        #expect(Format.direction(of: "—") == nil)
    }
}

struct CostArrivalTests {
    private func portfolio(_ change: (inout [String: Any]) -> Void = { _ in }) throws -> Portfolio {
        let url = try #require(Bundle.module.url(forResource: "demo-portfolio", withExtension: "json", subdirectory: "Resources"))
        var object = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        change(&object)
        return try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: object))
    }

    private func knowing(_ asset: String) -> (inout [String: Any]) -> Void {
        { object in
            var positions = object["positions"] as? [[String: Any]] ?? []
            for index in positions.indices where positions[index]["asset"] as? String == asset {
                var values = positions[index]["values"] as? [String: Any] ?? [:]
                values["unknownCostQty"] = "0"
                values["averageCostMicros"] = "1000000"
                positions[index]["values"] = values
            }
            object["positions"] = positions
        }
    }

    @Test func saysOnlyWhatJustBecameKnown() throws {
        let before = try portfolio().costWatch
        #expect(before.arrivals(since: before).isEmpty)
        #expect(try portfolio(knowing("DAI")).costWatch.arrivals(since: before) == ["DAI"])
        // Going the other way isn't an arrival.
        #expect(try before.arrivals(since: portfolio(knowing("DAI")).costWatch).isEmpty)
    }

    @Test func anotherWalletIsNotAnArrival() throws {
        let before = try portfolio().costWatch
        let other = try portfolio {
            knowing("DAI")(&$0)
            $0["address"] = "0x00000000000000000000000000000000000de999"
        }.costWatch
        #expect(other.arrivals(since: before).isEmpty)
    }
}

@Suite struct NewRowMarkTests {
    @Test func aRowThatArrivesInViewIsMarkedAtOnce() {
        var marks = NewRowMarks()
        marks.rowsChanged(from: ["a"], to: ["b", "a"], isCovered: false)
        #expect(marks.lit == ["b"])
        marks.fade()
        #expect(marks.lit.isEmpty)
    }

    @Test func aSendWaitingForItsReceiptIsMarkedOnlyOnceItsSheetCloses() {
        var marks = NewRowMarks()
        // Signed under the sheet, which stays until the receipt, then a moment more.
        marks.rowsChanged(from: [], to: ["sent"], isCovered: true)
        #expect(marks.lit.isEmpty)
        // Fading while it's covered has nothing to fade.
        marks.fade()
        // The receipt only changes the row's status, so nothing about the rows changes here.
        marks.rowsChanged(from: ["sent"], to: ["sent"], isCovered: true)
        marks.uncovered()
        #expect(marks.lit == ["sent"])
        // And only once.
        marks.fade()
        marks.uncovered()
        #expect(marks.lit.isEmpty)
    }

    @Test func closingTheSheetBeforeTheReceiptStillMarksIt() {
        var marks = NewRowMarks()
        marks.rowsChanged(from: [], to: ["sent"], isCovered: true)
        marks.uncovered()
        #expect(marks.lit == ["sent"])
    }

    @Test func aSweepOfSeveralIsMarkedTogether() {
        var marks = NewRowMarks()
        marks.rowsChanged(from: ["old"], to: ["old", "eth"], isCovered: true)
        marks.rowsChanged(from: ["old", "eth"], to: ["old", "eth", "usdc"], isCovered: true)
        marks.uncovered()
        #expect(marks.lit == ["eth", "usdc"])
    }
}
