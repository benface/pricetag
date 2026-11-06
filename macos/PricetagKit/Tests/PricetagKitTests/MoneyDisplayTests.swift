import Foundation
import Testing
@testable import PricetagKit

struct MoneyDisplayTests {
    private let usd = MoneyDisplay(main: .USD)
    private let cad = MoneyDisplay(main: .CAD, rateMicros: "1400000")
    private let noRate = MoneyDisplay(main: .CAD)

    @Test func inUSDNothingChanges() {
        #expect(usd.money(50_000_000) == "$50.00")
        #expect(usd.money(4000) == "$0.004")
        #expect(usd.whole(dollars: 25) == "$25")
        #expect(usd.cap(50_000_000) == "$50.00")
        #expect(usd.symbol == "$")
        #expect(usd.currency == .USD)
        #expect(!usd.isConverted)
        #expect(usd.usdMicros(ofWhole: 20) == 20_000_000)
        #expect(MoneyDisplay(main: .USD, rateMicros: "1400000") == usd, "USD never goes through a rate")
    }

    @Test func aRateConverts() {
        #expect(cad.money(50_000_000) == "$70.00")
        #expect(cad.money(4000) == "$0.0056")
        #expect(cad.whole(dollars: 25) == "$35")
        #expect(cad.cap(50_000_000) == "$70")
        #expect(cad.symbol == "$")
        #expect(cad.currency == .CAD)
        #expect(cad.isConverted)
        #expect(cad.usdMicros(ofWhole: 28) == 20_000_000)
    }

    @Test func noRateIsLabelledUSDAndNeverAGuess() {
        for display in [noRate, MoneyDisplay(main: .CAD, rateMicros: "0"), MoneyDisplay(main: .CAD, rateMicros: "lots")] {
            #expect(display.money(50_000_000) == "US$50.00")
            #expect(display.money(4000) == "US$0.004")
            #expect(display.whole(dollars: 25) == "US$25")
            #expect(display.cap(50_000_000) == "US$50.00")
            #expect(display.symbol == "US$")
            #expect(display.currency == .USD)
            #expect(!display.isConverted)
            #expect(display.usdMicros(ofWhole: 20) == 20_000_000)
        }
    }

    @Test func wholeAmountsRoundAsAsked() {
        #expect(cad.wholeAmount(3_000_000) == 4)
        #expect(cad.wholeAmount(3_000_000, rounding: .up) == 5)
        #expect(cad.wholeAmount(3_000_000, rounding: .down) == 4)
        #expect(cad.wholeAmount(5_000_000, rounding: .up) == 7, "Already whole, so it stays")
        #expect(cad.whole(3_000_000) == "$4")
        #expect(cad.whole(3_000_000, rounding: .up) == "$5", "A minimum has to be enough to clear it")
        #expect(usd.whole(3_000_000, rounding: .up) == "$3")
    }

    @Test func negativeAndAbsurdAmountsDontTrap() {
        #expect(cad.usdMicros(ofWhole: -5) == 0)
        #expect(usd.usdMicros(ofWhole: -5) == 0)
        #expect(cad.usdMicros(ofWhole: .max) > 0)
        #expect(MoneyDisplay(main: .CAD, rateMicros: "1").usdMicros(ofWhole: .max) > 0)
        #expect(cad.wholeAmount(.max) == .max)
        #expect(!cad.money(.max).isEmpty)
    }
}

private actor Rates: PortfolioSource {
    var answer: Result<String?, FetchError>
    /// What it says from its second answer on.
    let then: Result<String?, FetchError>?
    var asked: [CurrencyCode] = []
    var askedAt: [ContinuousClock.Instant] = []

    init(_ answer: Result<String?, FetchError>, then: Result<String?, FetchError>? = nil) {
        self.answer = answer
        self.then = then
    }

    func say(_ answer: Result<String?, FetchError>) { self.answer = answer }

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio { throw FetchError.unreachable }
    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation { throw FetchError.unreachable }
    func currentRate(currency: CurrencyCode) async throws -> String? {
        asked.append(currency)
        askedAt.append(.now)
        defer { if let then { answer = then } }
        return try answer.get()
    }
}

private final class Clock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 1_000_000)
}

@MainActor
struct CurrentRateTests {
    private func store(_ source: Rates, currency: CurrencyCode = .CAD, clock: Clock = Clock()) -> PortfolioStore {
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set(currency.rawValue, forKey: "currency")
        return PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { clock.now })
    }

    @Test func aReadRateConverts() async {
        let store = store(Rates(.success("1400000")))
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD))
        await store.readRate()
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD, rateMicros: "1400000"))
    }

    @Test func usdNeverAsks() async {
        let source = Rates(.success("1400000"))
        let store = store(source, currency: .USD)
        await store.readRate()
        #expect(store.moneyDisplay == MoneyDisplay(main: .USD))
        #expect(await source.asked.isEmpty)
    }

    @Test func noCurrentRateCountsStraightAway() async {
        let source = Rates(.success("1400000"))
        let store = store(source)
        await store.readRate()
        await source.say(.success(nil))
        await store.readRate()
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD))
    }

    @Test func aFailedReadKeepsTheRateOnlyForAWhile() async {
        let source = Rates(.success("1400000"))
        let clock = Clock()
        let store = store(source, clock: clock)
        await store.readRate()
        await source.say(.failure(.unreachable))
        clock.now += 30 * 60
        await store.readRate()
        #expect(store.moneyDisplay.isConverted)
        clock.now += 31 * 60
        await store.readRate()
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD))
    }

    @Test func aFirstReadThatFailsIsTriedAgainSoon() async throws {
        let source = Rates(.failure(.unreachable))
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set("CAD", forKey: "currency")
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, rateRetryDelay: .milliseconds(10))
        store.start()
        defer { store.stop() }
        for _ in 0..<2000 where await source.asked.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
        #expect(await !source.asked.isEmpty)
        #expect(!store.moneyDisplay.isConverted)
        await source.say(.success("1400000"))
        for _ in 0..<400 where !store.moneyDisplay.isConverted { try await Task.sleep(for: .milliseconds(5)) }
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD, rateMicros: "1400000"))
    }

    @Test func aServerThatSaysToWaitIsLeftAloneUntilThen() async throws {
        let source = Rates(.failure(.rateLimited("Too many requests.", retryAfter: 1)), then: .success("1400000"))
        let defaults = UserDefaults(suiteName: UUID().uuidString)!
        defaults.set("CAD", forKey: "currency")
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, rateRetryDelay: .milliseconds(10))
        store.start()
        defer { store.stop() }
        for _ in 0..<2000 where !store.moneyDisplay.isConverted { try await Task.sleep(for: .milliseconds(5)) }
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD, rateMicros: "1400000"))
        let askedAt = await source.askedAt
        #expect(askedAt.count == 2)
        #expect(askedAt[1] - askedAt[0] >= .seconds(1))
    }

    @Test func aRateGoesWhenItsTimeRunsOutDuringAWait() async throws {
        let source = Rates(.success("1400000"))
        let clock = Clock()
        let store = store(source, clock: clock)
        await store.readRate()
        await source.say(.failure(.rateLimited("Too many requests.", retryAfter: 600)))
        clock.now += 60 * 60 - 0.1
        await store.readRate()
        #expect(store.moneyDisplay.isConverted)
        for _ in 0..<400 where store.moneyDisplay.isConverted { try await Task.sleep(for: .milliseconds(5)) }
        #expect(!store.moneyDisplay.isConverted)
        #expect(await source.asked.count == 2)
        store.stop()
    }

    @Test func stoppingEndsARatesCountdown() async throws {
        let source = Rates(.success("1400000"))
        let clock = Clock()
        let store = store(source, clock: clock)
        await store.readRate()
        await source.say(.failure(.rateLimited("Too many requests.", retryAfter: 600)))
        clock.now += 60 * 60 - 0.05
        await store.readRate()
        store.stop()
        try await Task.sleep(for: .milliseconds(150))
        #expect(store.moneyDisplay.isConverted)
    }

    @Test func aRateIsOnlyForItsOwnCurrency() async {
        let source = Rates(.success("1400000"))
        let store = store(source)
        await store.readRate()
        store.setCurrency(.USD)
        #expect(store.moneyDisplay == MoneyDisplay(main: .USD))
        store.stop()
    }

    @Test func anotherServerStartsWithoutARate() async {
        let source = Rates(.success("1400000"))
        let store = store(source)
        await store.readRate()
        await source.say(.failure(.unreachable))
        store.setServerURL(URL(string: "http://127.0.0.1:1")!)
        #expect(store.moneyDisplay == MoneyDisplay(main: .CAD))
        store.stop()
    }
}

@Suite struct ShownMoneyTests {
    @Test func whatsTypedComesBackAsUSD() {
        let cad = MoneyDisplay(main: .CAD, rateMicros: "1400000")
        #expect(cad.usdMicros(ofShown: 14_000_000) == 10_000_000)
        #expect(cad.shownMicros(10_000_000) == 14_000_000)
        let noRate = MoneyDisplay(main: .CAD)
        #expect(noRate.usdMicros(ofShown: 14_000_000) == 14_000_000, "without a rate it's typed in USD, and says so")
    }
}

@Suite struct LookalikeTests {
    private let real = "0x1234567890123456789012345678901234567890"

    @Test func sameEndsButNotTheSameIsALookalike() {
        #expect(Lookalike.match(for: "0x123aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa890", among: [real]) == real)
        #expect(Lookalike.match(for: "0x123AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA890", among: [real]) == real, "case doesn't hide it")
    }

    @Test func theSameAddressOrDifferentEndsIsnt() {
        #expect(Lookalike.match(for: real, among: [real]) == nil)
        #expect(Lookalike.match(for: real.uppercased().replacing("0X", with: "0x"), among: [real]) == nil)
        #expect(Lookalike.match(for: "0x12aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa890", among: [real]) == nil)
        #expect(Lookalike.match(for: "0x123aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa89f", among: [real]) == nil)
        #expect(Lookalike.match(for: "0x123", among: [real]) == nil)
    }

    @Test func differencesAreWhereTheyDiffer() {
        #expect(Lookalike.differences(between: "0x12ab", and: "0x12cb") == [4])
        #expect(Lookalike.differences(between: "0xAB", and: "0xab").isEmpty)
    }
}
