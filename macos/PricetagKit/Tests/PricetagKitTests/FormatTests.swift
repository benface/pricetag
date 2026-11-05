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
    struct Span: Decodable {
        let ms: Int
        let duration: String
    }
    struct BlockSpan: Decodable {
        let from, to, ms: Int
    }
    struct BlocksBefore: Decodable {
        let block, ms, before: Int
    }
    let usd: [USD]
    let cad: [USD]
    let price: [Price]
    let amount: [Amount]
    let duration: [Span]
    let blockSpans: [BlockSpan]
    let blocksBefore: [BlocksBefore]
}

@Suite struct FormatTests {
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

    @Test func priceMatchesTheWebApp() {
        for vector in vectors.price {
            #expect(Format.price(vector.micros, .USD) == vector.price, "\(vector.micros)")
            #expect(Format.price(vector.micros, .CAD) == vector.cad, "\(vector.micros)")
        }
    }

    @Test func amountMatchesTheWebApp() {
        for vector in vectors.amount {
            #expect(Format.amount(vector.units, decimals: vector.decimals) == vector.amount, "\(vector.units)")
            #expect(Format.signedAmount(vector.units, decimals: vector.decimals) == vector.signed, "\(vector.units)")
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
    }
}
