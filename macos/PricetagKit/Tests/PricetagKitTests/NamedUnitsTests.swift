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

private let flow = "0123456789abcdef0123456789abcdef"

/// `test/cold.test.ts` writes this with `unitChoiceLink`.
private let written = "patina://unit-choice?flow=0123456789abcdef0123456789abcdef&wallet=0x00000000000000000000000000000000000000c1&tx=0xabababababababababababababababababababababababababababababababab&asset=ETH&recorded=2026-11-07T12%3A00%3A00.000Z&takes=2026-01-02T00%3A00%3A00.000Z%7E500000000000000000%2C2026-03-04T05%3A06%3A07.890Z%7E1"

/// `test/cold.test.ts` reads this.
private let macTopUp = "http://127.0.0.1:8787?topup=0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&usd=20#flow=0123456789abcdef0123456789abcdef&currency=CAD&held=%7B%220x00000000000000000000000000000000000000c1%22:%7B%22ETH%22:%7B%22purchases%22:%5B%7B%22allOnly%22:false,%22boughtAt%22:%222026-01-02T00:00:00.000Z%22,%22costMicros%22:%222000000000%22,%22units%22:%221000000000000000000%22%7D,%7B%22allOnly%22:true,%22boughtAt%22:%222026-03-04T05:06:07.890Z%22,%22units%22:%222000000000000000000%22%7D%5D,%22unnamed%22:%220%22%7D%7D%7D"

/// `count` purchases of 1 ETH, an hour apart.
private func purchases(_ count: Int) -> HeldUnits {
    HeldUnits(purchases: (0..<count).map { i in
        .init(boughtAt: NamedUnits.moment(Date(timeIntervalSince1970: 1_735_689_600 + Double(i) * 3600)), units: String(eth), costMicros: "2000000000", allOnly: false)
    }, unnamed: "0")
}

private func wallet(_ i: Int) -> String {
    let hex = String(i + 1, radix: 16)
    return "0x" + String(repeating: "0", count: 40 - hex.count) + hex
}

@MainActor private final class Failing {
    var wallets: Set<String>
    var reads: [String] = []
    init(wallets: Set<String>) { self.wallets = wallets }
    func read(_ wallet: String) async throws -> [String: HeldUnits] {
        reads.append(wallet)
        if wallets.contains(wallet) { throw URLError(.timedOut) }
        return ["ETH": held]
    }
}

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
        #expect(link.flow == flow)
        #expect(link.choice == UnitChoice(wallet: cold, txHash: tx, asset: "ETH", recordedAt: "2026-11-07T12:00:00.000Z", takes: [.init(boughtAt: first, units: "500000000000000000"), .init(boughtAt: second, units: "1")]))
        for bad in [
            written.replacing("unit-choice", with: "add-savings"),
            written.replacing("flow=0123456789abcdef0123456789abcdef&", with: ""),
            written.replacing("flow=0123456789abcdef", with: "flow=0123456789ABCDEF"),
            written.replacing("flow=0123456789abcdef0123456789abcdef", with: "flow=0123"),
            written.replacing("wallet=0x", with: "wallet=0y"),
            written.replacing("%7E1", with: "%7E0"),
            written.replacing("%7E1", with: "%7E01"),
            written.replacing("%7E1", with: "%7Elots"),
            written.replacing("recorded=2026", with: "recorded=soon"),
            // The server only takes a moment as `toISOString` writes it, so anything else would make the whole book unreadable to it.
            written.replacing("recorded=2026-11-07T12%3A00%3A00.000Z", with: "recorded=2026-11-07T12%3A00%3A00.0Z"),
            written.replacing("recorded=2026-11-07T12%3A00%3A00.000Z", with: "recorded=2026-11-07T12%3A00%3A00Z"),
            written.replacing("recorded=2026-11-07T12%3A00%3A00.000Z", with: "recorded=2026-02-30T12%3A00%3A00.000Z"),
            written.replacing("takes=2026-01-02T00%3A00%3A00.000Z", with: "takes=2026-01-02"),
            written.replacing("%2C2026-03-04T05%3A06%3A07.890Z%7E1", with: "%2C2026-01-02T00%3A00%3A00.000Z%7E1"),
            written.replacing("%2C2026-03-04T05%3A06%3A07.890Z%7E1", with: "%2C"),
        ] {
            #expect(UnitChoiceLink(url: URL(string: bad)!) == nil, "\(bad)")
        }
    }

    @Test func aMomentIsOnlyOneTheWayTheServerTakesIt() {
        #expect(NamedUnits.isMoment("2026-11-07T12:00:00.000Z"))
        for bad in ["2026-11-07T12:00:00.0Z", "2026-11-07T12:00:00Z", "2026-11-07T12:00:00.000+00:00", "2026-02-30T00:00:00.000Z", "2026-11-07", " 2026-11-07T12:00:00.000Z"] {
            #expect(!NamedUnits.isMoment(bad), "\(bad)")
        }
        #expect(NamedUnits.isMoment(NamedUnits.moment(.now)))
    }

    /// Anyone can make the link, so it's only kept if it brings back a top-up's flow, once, and fits what that top-up said was held.
    @MainActor @Test func onlyKeepsWhatATopUpThisOpenedHandsBack() throws {
        let link = try #require(UnitChoiceLink(url: URL(string: written)!))
        let recorded = try #require(NamedUnits.date("2026-11-07T12:00:00.000Z"))
        // The link takes 1 unit of the second purchase, so here it's one that can be split.
        let splittable = HeldUnits(purchases: [held.purchases[0], .init(boughtAt: second, units: String(2 * eth), costMicros: nil, allOnly: false)], unnamed: "0")
        let naming = TopUpNaming(currency: .USD, held: [cold: ["ETH": splittable]], flow: flow)
        let soon = recorded.addingTimeInterval(30)

        let handoff = UnitChoiceHandoff()
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "nothing was opened")
        handoff.opened(TopUpNaming(currency: .USD, held: [cold: ["ETH": splittable]]), at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "another top-up, with its own flow")
        handoff.opened(TopUpNaming(currency: .USD, held: ["0x00000000000000000000000000000000000000d1": ["ETH": splittable]], flow: flow), at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "not a wallet it said anything about")
        handoff.opened(TopUpNaming(currency: .USD, held: [cold: ["USDC": splittable]], flow: flow), at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "not a token it said that wallet holds")
        let less = HeldUnits(purchases: [splittable.purchases[0]], unnamed: "0")
        handoff.opened(TopUpNaming(currency: .USD, held: [cold: ["ETH": less]], flow: flow), at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "a purchase it didn't list")
        handoff.opened(naming, at: recorded.addingTimeInterval(60))
        #expect(handoff.accept(link, existing: [], at: recorded.addingTimeInterval(90)) == nil, "made before the page was opened")
        handoff.opened(naming, at: recorded.addingTimeInterval(-60))
        #expect(handoff.accept(link, existing: [], at: recorded.addingTimeInterval(-120)) == nil, "made after it came back")
        #expect(handoff.accept(link, existing: [], at: recorded.addingTimeInterval(2 * 3600)) == nil, "the page has long stopped")
        let earlier = UnitChoice(wallet: cold, txHash: tx, asset: "ETH", recordedAt: "2026-11-07T11:00:00.000Z", takes: [.init(boughtAt: first, units: "1")])
        #expect(handoff.accept(link, existing: [earlier], at: soon) == nil, "a record for that send is already kept")
        #expect(handoff.accept(link, existing: [], at: soon) == link.choice)
        #expect(handoff.accept(link, existing: [], at: soon) == nil, "the same link again")
    }

    /// The second purchase was bought at different prices at once, so it's all or none, and none can take more than is left.
    @MainActor @Test func aHandedBackChoiceFitsWhatWasHeld() throws {
        let recorded = "2026-11-07T12:00:00.000Z"
        let at = try #require(NamedUnits.date(recorded)).addingTimeInterval(30)
        for (takes, fits) in [("\(second)~\(2 * eth)", true), ("\(second)~\(eth)", false), ("\(first)~\(eth + 1)", false), ("\(first)~\(eth)", true)] {
            var parts = URLComponents(string: written)!
            parts.queryItems = parts.queryItems!.map { $0.name == "takes" ? URLQueryItem(name: "takes", value: takes) : $0 }
            let link = try #require(UnitChoiceLink(url: parts.url!))
            let handoff = UnitChoiceHandoff()
            handoff.opened(TopUpNaming(currency: .USD, held: [cold: ["ETH": held]], flow: flow), at: at.addingTimeInterval(-60))
            #expect((handoff.accept(link, existing: [], at: at) != nil) == fits, "\(takes)")
        }
    }

    @Test func eachTopUpHasItsOwnFlow() {
        let one = TopUpNaming.newFlow()
        #expect(TopUpNaming.isFlow(one))
        #expect(one != TopUpNaming.newFlow())
    }

    /// `test/cold.test.ts` reads exactly this. What's held goes after the `#`, so it never reaches a server.
    @Test func aTopUpLinkSaysWhatTheSavingsHoldAfterTheHash() throws {
        let server = URL(string: "http://127.0.0.1:8787")!
        let hot = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        let url = try #require(DeviceFlow.topUp(server: server, to: hot, dollars: 20, naming: TopUpNaming(currency: .CAD, held: [cold: ["ETH": held]], flow: flow)))
        #expect(url.absoluteString == macTopUp)
        #expect(url.query() == "topup=\(hot)&usd=20")
        let fragment = try #require(URLComponents(string: "?" + (url.fragment(percentEncoded: true) ?? ""))?.queryItems)
        let text = try #require(fragment.first { $0.name == "held" }?.value)
        #expect(try JSONDecoder().decode([String: [String: HeldUnits]].self, from: Data(text.utf8)) == [cold: ["ETH": held]])
        #expect(DeviceFlow.topUp(server: server, to: hot, dollars: 20)?.fragment() == nil)
        // The page this app serves itself gets the same, after the `#` too.
        let page = try #require(DeviceFlow.link(url, on: URL(string: "http://127.0.0.1:50123/device.html")!))
        #expect(page.absoluteString == macTopUp.replacing("http://127.0.0.1:8787", with: "http://127.0.0.1:50123/device.html"))
    }

    /// A long history stays out of the request line, which both page servers cap.
    @Test func aLongHistoryStaysOutOfTheRequestLine() throws {
        let many = HeldUnits(purchases: (0..<500).map { i in
            .init(boughtAt: NamedUnits.moment(Date(timeIntervalSince1970: 1_700_000_000 + Double(i) * 3600)), units: String(eth), costMicros: "2000000000", allOnly: false)
        }, unnamed: "0")
        let url = try #require(DeviceFlow.topUp(server: URL(string: "http://127.0.0.1:8787")!, to: cold, dollars: 20, naming: TopUpNaming(currency: .USD, held: [cold: ["ETH": many, "USDC": many]])))
        #expect(url.absoluteString.utf8.count > 64 * 1024)
        #expect((url.query()?.utf8.count ?? 0) < 100)
    }

    @MainActor @Test func aTopUpWaitsForWhatTheSavingsHold() async {
        let other = "0x00000000000000000000000000000000000000d1"
        let failing = Failing(wallets: [other])
        let holdings = TopUpHoldings(needed: true, wallets: [cold, other.uppercased().replacing("0X", with: "0x")], currency: .CAD) { try await failing.read($0) }
        #expect(holdings.state == .reading)
        #expect(!holdings.isSettled)
        #expect(holdings.naming() == nil)
        await holdings.load()
        #expect(holdings.state == .failed([other]))
        #expect(!holdings.isSettled, "a failure has to be tried again or let go")
        #expect(holdings.naming() == nil)
        // Trying again only reads the one that failed.
        failing.wallets = []
        await holdings.load()
        #expect(holdings.state == .ready)
        #expect(failing.reads == [cold, other, other])
        let naming = holdings.naming()
        #expect(naming?.currency == .CAD)
        #expect(naming?.held.keys.sorted() == [cold, other])
        #expect(naming?.flow != holdings.naming()?.flow, "each page it opens has its own")
    }

    @MainActor @Test func aTopUpCanGoWithoutWhatCouldntBeRead() async {
        let failing = Failing(wallets: [cold])
        let holdings = TopUpHoldings(needed: true, wallets: [cold], currency: .USD) { try await failing.read($0) }
        await holdings.load()
        #expect(holdings.state == .failed([cold]))
        holdings.goWithout()
        #expect(holdings.isSettled)
        #expect(holdings.naming() == nil, "with nothing read, there's nothing to choose from")
    }

    /// The page reads no more than this, as `test/cold.test.ts` pins on the web, so this app checks before it opens it.
    @Test func whatThePageCanListIsTheSameAsTheWebs() {
        #expect(NamedUnits.mostListedPurchases == 500)
        #expect(NamedUnits.mostHeldWallets == 16)
        #expect(NamedUnits.mostHeldCharacters == 200_000)
        #expect(TopUpNaming.fits([cold: ["ETH": purchases(500)]]))
        #expect(!TopUpNaming.fits([cold: ["ETH": purchases(501)]]))
        #expect(TopUpNaming.fits(Dictionary(uniqueKeysWithValues: (0..<16).map { (wallet($0), ["ETH": purchases(1)]) })))
        #expect(!TopUpNaming.fits(Dictionary(uniqueKeysWithValues: (0..<17).map { (wallet($0), ["ETH": purchases(1)]) })))
        // Four wallets of 500 each is too long altogether, though each fits.
        let four = Dictionary(uniqueKeysWithValues: (0..<4).map { (wallet($0), ["ETH": purchases(500)]) })
        #expect((TopUpNaming.text(four)?.utf16.count ?? 0) > NamedUnits.mostHeldCharacters)
        #expect(!TopUpNaming.fits(four))
        let three = Dictionary(uniqueKeysWithValues: (0..<3).map { (wallet($0), ["ETH": purchases(500)]) })
        #expect(TopUpNaming.fits(three))
    }

    @MainActor @Test func aTopUpSaysWhenItsSavingsHoldMoreThanThePageCanList() async {
        let holdings = TopUpHoldings(needed: true, wallets: [cold], currency: .USD) { _ in ["ETH": purchases(501)] }
        await holdings.load()
        #expect(holdings.state == .tooMuch)
        #expect(!holdings.isSettled, "it doesn't just open with nothing to choose from")
        #expect(holdings.naming() == nil)
        holdings.goWithout()
        #expect(holdings.isSettled)
        #expect(holdings.naming() == nil, "gone without on purpose, so the page doesn't choose")
        let fine = TopUpHoldings(needed: true, wallets: [cold], currency: .USD) { _ in ["ETH": purchases(500)] }
        await fine.load()
        #expect(fine.state == .ready)
        #expect(fine.naming()?.held[cold]?["ETH"]?.purchases.count == 500)
    }

    @MainActor @Test func goingWithoutAFailedReadStillChecksWhatsLeftFits() async {
        let other = "0x00000000000000000000000000000000000000d1"
        let failing = Failing(wallets: [other])
        let holdings = TopUpHoldings(needed: true, wallets: [cold, other], currency: .USD) { wallet in
            _ = try await failing.read(wallet)
            return ["ETH": purchases(501)]
        }
        await holdings.load()
        #expect(holdings.state == .failed([other]))
        holdings.goWithout()
        #expect(holdings.state == .tooMuch)
        holdings.goWithout()
        #expect(holdings.naming() == nil)
    }

    @MainActor @Test func aTopUpOutsideTheUSDoesntWait() async {
        let holdings = TopUpHoldings(needed: false, wallets: [cold], currency: .CAD) { _ in Issue.record("nothing to read"); return [:] }
        #expect(holdings.isSettled)
        await holdings.load()
        #expect(holdings.naming() == nil)
        #expect(TopUpHoldings(needed: true, wallets: [], currency: .USD) { _ in [:] }.isSettled)
    }

    @Test func readsWhatTheServerSaysIsHeld() throws {
        let json = #"{"assets":{"ETH":{"purchases":[{"boughtAt":"2026-01-02T00:00:00.000Z","units":"1000000000000000000","costMicros":null,"allOnly":false}],"unnamed":"5"}}}"#
        let read = try JSONDecoder().decode(HeldByAsset.self, from: Data(json.utf8))
        #expect(read.assets["ETH"]?.purchases.first?.costMicros == nil)
        #expect(read.assets["ETH"]?.purchases.first?.amount == eth)
        #expect(read.assets["ETH"]?.unnamed == "5")
    }
}
