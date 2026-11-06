import Foundation
@testable import PricetagKit
import Testing

@Suite struct OtherTokenTests {
    private struct Vectors: Decodable {
        struct One: Decodable { let token: OtherToken; let name: String; let amount: String }
        struct LeftOut: Decodable { let count: Int; let sentence: String? }
        struct NoMarket: Decodable { let listed: [String]; let others: Int; let sentence: String? }
        let title: String
        let note: String
        let spamTitle: String
        let spamRule: String
        let tokens: [One]
        let leftOut: [LeftOut]
        let noMarket: [NoMarket]
    }

    @Test func theWordsMatchTheWebApp() throws {
        let vectors = try resource("other-token-vectors", as: Vectors.self)
        #expect(Wording.otherTokensTitle == vectors.title)
        #expect(Wording.otherTokensNote == vectors.note)
        #expect(Wording.possibleSpamTitle == vectors.spamTitle)
        #expect(Wording.possibleSpamRule == vectors.spamRule)
        for vector in vectors.tokens {
            #expect(Wording.otherTokenName(vector.token) == vector.name)
            #expect(Wording.otherTokenAmount(vector.token) == vector.amount)
        }
        for vector in vectors.leftOut { #expect(Wording.otherTokensLeftOut(vector.count) == vector.sentence) }
        for vector in vectors.noMarket { #expect(Wording.noMarket(listed: vector.listed, others: vector.others) == vector.sentence) }
    }

    @Test func tucksAwayWhatTheServerSaysToAndStillHasIt() throws {
        let portfolio = try resource("demo-portfolio", as: Portfolio.self)
        #expect(portfolio.shownOtherTokens.map(\.symbol) == ["JACK"])
        #expect(portfolio.tuckedOtherTokens.map(\.symbol) == ["USDC"])
        #expect(portfolio.hasOtherTokens)
    }

    @Test func aTokenThatCopiesAnotherNeverBecomesAHolding() throws {
        let portfolio = try resource("demo-portfolio", as: Portfolio.self)
        let realUsdc = portfolio.positions.first { $0.asset == "USDC" }
        #expect(realUsdc?.values.qty != "5000000000")
        #expect(!portfolio.positions.contains { $0.asset == "JACK" })
    }

    @Test func aWalletHoldingNothingElseDoesntSayZero() throws {
        let url = try #require(Bundle.module.url(forResource: "demo-portfolio", withExtension: "json", subdirectory: "Resources"))
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        json["positions"] = [Any]()
        json["unreadAssets"] = [String]()
        let portfolio = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(!portfolio.isEmpty)
        #expect(portfolio.holdsOnlyOtherTokens)
    }

    @Test func aPortfolioSavedBeforeTheseExistedStillReads() throws {
        let url = try #require(Bundle.module.url(forResource: "demo-portfolio", withExtension: "json", subdirectory: "Resources"))
        var json = try #require(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        json["otherTokens"] = nil
        json["otherTokensLeftOut"] = nil
        let old = try JSONDecoder().decode(Portfolio.self, from: JSONSerialization.data(withJSONObject: json))
        #expect(!old.hasOtherTokens)
        #expect(old.shownOtherTokens.isEmpty)
    }
}
