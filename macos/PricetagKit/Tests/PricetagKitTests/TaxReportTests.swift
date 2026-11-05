import Foundation
import Testing
@testable import PricetagKit

@MainActor
@Suite struct TaxReportTests {
    private func model(currency: CurrencyCode = .USD, defaults: UserDefaults? = nil, fetch: @escaping @MainActor (TaxReportRequest) async throws -> TaxReport = { _ in throw FetchError.unreachable }) -> TaxReportModel {
        TaxReportModel(defaults: defaults ?? freshDefaults(), currency: currency, fetch: fetch)
    }

    private func freshDefaults() -> UserDefaults {
        let name = "tax-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    private let server = URL(string: "http://127.0.0.1:8787")!

    @Test func readsWhatTheServerSends() throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        #expect(report.country == .CA)
        #expect(report.method == .average)
        #expect(report.scope == .pooled)
        #expect(report.csv.hasPrefix("Date (UTC),Type,Asset,"))
        #expect(report.unresolvedCount > 0)
    }

    @Test func eachCountrysDefaultsMatchTheServer() throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        #expect(report.defaults.method == report.country.defaultMethod)
        #expect(report.defaults.scope == report.country.defaultScope)
        #expect(TaxCountry.US.defaultMethod == .fifo)
        #expect(TaxCountry.US.defaultScope == .perWallet)
    }

    @Test func guessesTheCountryFromTheCurrencyUntilOneIsChosen() {
        #expect(model(currency: .CAD).country == .CA)
        #expect(model(currency: .USD).country == .US)
        let defaults = freshDefaults()
        model(currency: .USD, defaults: defaults).setCountry(.CA)
        #expect(model(currency: .USD, defaults: defaults).country == .CA)
    }

    @Test func aCountryPicksTheDefaultsUntilOverridden() {
        let model = model()
        model.setCountry(.CA)
        #expect(model.method == .average)
        #expect(model.scope == .pooled)
        model.setMethod(.fifo)
        model.setScope(.perWallet)
        #expect(model.method == .fifo)
        #expect(model.scope == .perWallet)
        // A new country goes back to what it calls for.
        model.setCountry(.US)
        #expect(model.method == .fifo)
        #expect(model.scope == .perWallet)
        model.setCountry(.CA)
        #expect(model.method == .average)
        #expect(model.scope == .pooled)
    }

    @Test func remembersAnOverride() {
        let defaults = freshDefaults()
        let first = model(defaults: defaults)
        first.setCountry(.CA)
        first.setMethod(.fifo)
        first.setOtherWalletsText("0x\(String(repeating: "a", count: 40))")
        let second = model(defaults: defaults)
        #expect(second.country == .CA)
        #expect(second.method == .fifo)
        #expect(second.scope == .pooled)
        #expect(second.otherWallets.count == 1)
    }

    @Test func addsAndRemovesWalletsOneAtATime() {
        let a = "0x\(String(repeating: "a", count: 40))"
        let b = "0x\(String(repeating: "b", count: 40))"
        let model = model()
        model.addOtherWallet(a.uppercased().replacingOccurrences(of: "0X", with: "0x"))
        model.addOtherWallet(b)
        model.addOtherWallet(a)
        #expect(model.otherWallets == [a, b])
        model.removeOtherWallet(a)
        #expect(model.otherWallets == [b])
    }

    @Test func aTypoCanBeRemovedOnItsOwn() {
        let a = "0x\(String(repeating: "a", count: 40))"
        let model = model()
        model.setOtherWalletsText("0xnope\n\(a)")
        model.removeOtherWallet("0xnope")
        #expect(model.otherWallets == [a])
        #expect(model.badWallet(for: a) == nil)
    }

    @Test func offersOnlyWhatWouldChangeTheReport() {
        let showing = "0x\(String(repeating: "a", count: 40))"
        let linked = "0x\(String(repeating: "b", count: 40))"
        let added = "0x\(String(repeating: "c", count: 40))"
        let other = "0x\(String(repeating: "d", count: 40))"
        let model = model()
        model.addOtherWallet(added)
        let offered = [showing, linked, added, other].filter { model.offers(WalletEntry(address: $0, name: nil, kind: .watching), showing: showing, linked: [linked]) }
        #expect(offered == [other])
    }

    @Test func aBadWalletAsksTheServerNothing() {
        let model = model()
        model.setOtherWalletsText("0xnope")
        let real = "0x\(String(repeating: "a", count: 40))"
        #expect(model.badWallet(for: real) == "0xnope")
        #expect(model.request(address: real, currency: .USD, serverURL: server) == nil)
    }

    @Test func aSavedTypoDoesntBlockTheDemoWallet() {
        let defaults = freshDefaults()
        model(defaults: defaults).setOtherWalletsText("0xnope")
        // Reopened on the demo wallet, where the field for fixing it isn't shown.
        let reopened = model(defaults: defaults)
        #expect(reopened.otherWalletsText == "0xnope")
        #expect(reopened.badWallet(for: WalletAddress.demo) == nil)
        #expect(reopened.request(address: WalletAddress.demo, currency: .USD, serverURL: server)?.otherWallets == [])
    }

    @Test func readsSeveralWalletsHoweverTheyreSeparated() {
        let a = "0x\(String(repeating: "A", count: 40))"
        let b = "0x\(String(repeating: "b", count: 40))"
        let model = model()
        model.setOtherWalletsText("\(a)\n \(b), ")
        #expect(model.otherWallets == [a.lowercased(), b])
        let request = model.request(address: b, currency: .USD, serverURL: server)
        #expect(request?.body.also == [a.lowercased(), b])
        // The demo wallet can't be combined, so what's remembered doesn't get in its way.
        #expect(model.request(address: WalletAddress.demo, currency: .USD, serverURL: server)?.otherWallets == [])
    }

    @Test func theAnswersAndTheWalletsItKnowsGoWithTheRequest() {
        let a = "0x\(String(repeating: "a", count: 40))"
        let b = "0x\(String(repeating: "b", count: 40))"
        let model = model()
        model.setOtherWalletsText(a)
        let book = Book(senders: [b: .someoneElse])
        let request = model.request(address: "0x\(String(repeating: "c", count: 40))", currency: .USD, serverURL: server, book: book, linked: [a, b])
        #expect(request?.body.also == [a, b], "A wallet that's both typed and known only counts once")
        #expect(request?.body.book == book)
        #expect(model.request(address: WalletAddress.demo, currency: .USD, serverURL: server, book: book, linked: [a])?.body.also == [], "The demo wallet can't be combined")
    }

    @Test func aFailedReadSaysWhy() async {
        let model = model(fetch: { _ in throw FetchError.noAmpConfigured("Only the demo wallet is available.") })
        await model.load(model.request(address: "demo", currency: .USD, serverURL: server)!)
        #expect(model.state == .failed("Only the demo wallet is available."))
    }

    @Test func aReportReplacesAnEarlierFailure() async throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        var answer: Result<TaxReport, FetchError> = .failure(.unreachable)
        let model = model(fetch: { _ in try answer.get() })
        let request = model.request(address: "demo", currency: .CAD, serverURL: server)!
        await model.load(request)
        #expect(model.state == .failed("Can't reach the server."))
        answer = .success(report)
        await model.load(request)
        #expect(model.state == .ready(report))
    }

    @Test func startsOnTheNewestYearAndShowsWhichOneThatIs() async throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        let model = model(fetch: { _ in report })
        #expect(model.year == .latest)
        #expect(model.shownYear == .latest, "Until a report says which years there are")
        let request = model.request(address: "demo", currency: .CAD, serverURL: server)!
        #expect(request.year == .latest)
        await model.load(request)
        #expect(model.years == report.years)
        #expect(model.shownYear == .year(2026))
        model.setYear(.year(2026))
        #expect(model.year == .latest, "Picking the year already showing asks nothing new")
        model.setYear(.all)
        #expect(model.request(address: "demo", currency: .CAD, serverURL: server)?.year == .all)
    }

    @Test func sendsTheYearTheServerReads() throws {
        let encode = { (year: TaxYear) in String(decoding: try JSONEncoder().encode(year), as: UTF8.self) }
        #expect(try encode(.latest) == "\"latest\"")
        #expect(try encode(.all) == "\"all\"")
        #expect(try encode(.year(2026)) == "2026")
    }

    @Test func readsTheCountsAndPreview() throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        // A sale split into a known and an unknown part is two rows in the file, and one sale here.
        #expect(report.eventCount == 15)
        #expect(report.rowCount == 23)
        #expect(report.unknownCount <= report.eventCount)
        #expect(report.unknownWallets == report.wallets)
        #expect(report.preview.count == min(5, report.rowCount))
        #expect(report.years == [2026])
    }

    @Test func previewTimesAreInUTCLikeTheFile() throws {
        // 8 PM on December 31 in Toronto, and already the next year in the file.
        let date = try #require(parseTimestamp("2027-01-01T01:00:00.000Z"))
        #expect(Format.utcDateTime(date) == "Jan 1, 2027 at 1:00\u{202F}AM UTC")
        var toronto = Calendar(identifier: .gregorian)
        toronto.timeZone = try #require(TimeZone(identifier: "America/Toronto"))
        #expect(toronto.component(.year, from: date) == 2026, "The case this guards against")
    }

    @Test func theFileIsTheServersWordForWord() throws {
        let report = try resource("demo-tax-report", as: TaxReport.self)
        let document = TaxReportDocument(report)
        #expect(document.csv == report.csv)
        #expect(document.filename == report.filename)
    }
}
