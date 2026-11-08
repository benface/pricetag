import Foundation
import Testing
@testable import PricetagKit

private let eth: UInt128 = 1_000_000_000_000_000_000
private let first = "2026-01-02T00:00:00.000Z"
private let second = "2026-03-04T05:06:07.890Z"
private let cold = "0x00000000000000000000000000000000000000c1"
private let tx = "0x" + String(repeating: "ab", count: 32)
private func format(_ units: UInt128) -> String { "\(Format.amount(String(units), decimals: 18)) ETH" }

private let held = HeldUnits(purchases: [
    .init(boughtAt: first, units: String(eth), costMicros: "2000000000", allOnly: false),
    .init(boughtAt: second, units: String(2 * eth), costMicros: nil, allOnly: true),
], unnamed: "0")

/// `test/cold.test.ts` writes this with `unitChoiceLink`.
private let written = "patina://unit-choice?wallet=0x00000000000000000000000000000000000000c1&tx=0xabababababababababababababababababababababababababababababababab&asset=ETH&recorded=2026-11-07T12%3A00%3A00.000Z&takes=2026-01-02T00%3A00%3A00.000Z%7E500000000000000000%2C2026-03-04T05%3A06%3A07.890Z%7E1"

@Suite struct NamedUnitsTests {
    @Test func picksFitWhenTheyAddUpToWhatsSentFromWhatsHeld() {
        #expect(NamedUnits.problem(held: held, picks: [first: eth / 2], units: eth / 2, format: format) == nil)
        #expect(NamedUnits.problem(held: held, picks: [first: eth / 2, second: 0], units: eth / 2, format: format) == nil)
        #expect(NamedUnits.problem(held: held, picks: [first: eth / 2], units: eth, format: format) == "Those add up to 0.5 ETH, and this sends 1 ETH.")
        #expect(NamedUnits.problem(held: held, picks: [first: 2 * eth], units: 2 * eth, format: format) == "That's more than is left of one purchase, which has 1 ETH.")
        #expect(NamedUnits.problem(held: held, picks: ["2026-01-01T00:00:00.000Z": eth], units: eth, format: format) == "One of those purchases isn't held anymore.")
        #expect(NamedUnits.problem(held: held, picks: [second: eth], units: eth, format: format)?.contains("all 2 ETH or none") == true)
        #expect(NamedUnits.problem(held: held, picks: [second: 2 * eth], units: 2 * eth, format: format) == nil)
    }

    @Test func aChoiceNamesOnlyWhatsPicked() throws {
        let choice = try #require(UnitChoice(wallet: cold.uppercased().replacing("0X", with: "0x"), txHash: tx.uppercased().replacing("0X", with: "0x"), asset: "ETH", recordedAt: "2026-11-07T12:00:00.000Z", picks: [second: 2 * eth, first: 0]))
        #expect(choice.wallet == cold)
        #expect(choice.txHash == tx)
        #expect(choice.takes == [UnitChoice.Take(boughtAt: second, units: String(2 * eth))])
        #expect(UnitChoice(wallet: cold, txHash: tx, asset: "ETH", recordedAt: "2026-11-07T12:00:00.000Z", picks: [first: 0]) == nil)
    }

    @Test func aMomentIsWrittenTheWayTheWebWritesIt() {
        #expect(NamedUnits.moment(Date(timeIntervalSince1970: 1_762_516_800.25)) == "2025-11-07T12:00:00.250Z")
    }

    @Test func readsTheLinkThePageWrites() throws {
        let link = try #require(UnitChoiceLink(url: URL(string: written)!))
        #expect(link.choice == UnitChoice(wallet: cold, txHash: tx, asset: "ETH", recordedAt: "2026-11-07T12:00:00.000Z", takes: [.init(boughtAt: first, units: "500000000000000000"), .init(boughtAt: second, units: "1")]))
        for bad in [
            written.replacing("unit-choice", with: "add-savings"),
            written.replacing("wallet=0x", with: "wallet=0y"),
            written.replacing("%7E1", with: "%7E0"),
            written.replacing("%7E1", with: "%7Elots"),
            written.replacing("recorded=2026", with: "recorded=soon"),
            written.replacing("%2C2026-03-04T05%3A06%3A07.890Z%7E1", with: "%2C2026-01-02T00%3A00%3A00.000Z%7E1"),
        ] {
            #expect(UnitChoiceLink(url: URL(string: bad)!) == nil, "\(bad)")
        }
    }

    /// Anyone can make the link, so it's only kept for a top-up this app opened, from a wallet it said what was held in, and made since.
    @MainActor @Test func onlyKeepsWhatATopUpThisOpenedHandsBack() throws {
        let link = try #require(UnitChoiceLink(url: URL(string: written)!))
        let recorded = try #require(NamedUnits.date("2026-11-07T12:00:00.000Z"))
        let handoff = UnitChoiceHandoff()
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(30)) == nil, "nothing was opened")
        handoff.opened(wallets: ["0x00000000000000000000000000000000000000d1"], at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(30)) == nil, "not a wallet it said anything about")
        handoff.opened(wallets: [cold.uppercased().replacing("0X", with: "0x")], at: recorded.addingTimeInterval(60))
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(90)) == nil, "made before the page was opened")
        handoff.opened(wallets: [cold], at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(-120)) == nil, "made after it came back")
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(2 * 3600)) == nil, "the page has long stopped")
        #expect(handoff.accept(link, at: recorded.addingTimeInterval(30)) == link.choice)
    }

    /// `test/cold.test.ts` reads the same shape: the server's, with an unknown cost left out.
    @Test func aTopUpLinkSaysWhatTheSavingsHold() throws {
        let url = try #require(DeviceFlow.topUp(server: URL(string: "http://127.0.0.1:8787")!, to: cold, dollars: 20, held: [cold: ["ETH": held]]))
        let query = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
        let text = try #require(query.first { $0.name == "held" }?.value)
        #expect(text == #"{"0x00000000000000000000000000000000000000c1":{"ETH":{"purchases":[{"allOnly":false,"boughtAt":"2026-01-02T00:00:00.000Z","costMicros":"2000000000","units":"1000000000000000000"},{"allOnly":true,"boughtAt":"2026-03-04T05:06:07.890Z","units":"2000000000000000000"}],"unnamed":"0"}}}"#)
        #expect(try JSONDecoder().decode([String: [String: HeldUnits]].self, from: Data(text.utf8)) == [cold: ["ETH": held]])
        #expect(DeviceFlow.topUp(server: URL(string: "http://127.0.0.1:8787")!, to: cold, dollars: 20)?.query()?.contains("held") == false)
    }

    @Test func readsWhatTheServerSaysIsHeld() throws {
        let json = #"{"assets":{"ETH":{"purchases":[{"boughtAt":"2026-01-02T00:00:00.000Z","units":"1000000000000000000","costMicros":null,"allOnly":false}],"unnamed":"5"}}}"#
        let read = try JSONDecoder().decode(HeldByAsset.self, from: Data(json.utf8))
        #expect(read.assets["ETH"]?.purchases.first?.costMicros == nil)
        #expect(read.assets["ETH"]?.purchases.first?.amount == eth)
        #expect(read.assets["ETH"]?.unnamed == "5")
    }
}
