// The tax report: see `src/core/tax.ts`. The server works it out and writes the file, and this only asks and saves.
// A test checks the defaults against what the server sends.

import Foundation
import Observation

public enum TaxCountry: String, Codable, Sendable, CaseIterable, Identifiable {
    case CA, US

    public var id: Self { self }

    public var name: String {
        switch self {
        case .CA: "Canada"
        case .US: "United States"
        }
    }

    public var defaultMethod: CostMethod {
        switch self {
        case .CA: .average
        case .US: .fifo
        }
    }

    public var defaultScope: TaxScope {
        switch self {
        case .CA: .pooled
        case .US: .perWallet
        }
    }

    /// Whose rules, in a sentence.
    public var rules: String {
        switch self {
        case .CA: "Canada's rules"
        case .US: "US rules"
        }
    }

    /// Until one is chosen, the main currency is the best guess.
    static func guess(from currency: CurrencyCode) -> TaxCountry {
        currency == .CAD ? .CA : .US
    }
}

public enum TaxScope: String, Codable, Sendable, CaseIterable, Identifiable {
    case pooled
    case perWallet = "per-wallet"

    public var id: Self { self }

    public var label: String {
        switch self {
        case .pooled: "All wallets together"
        case .perWallet: "Each wallet on its own"
        }
    }
}

/// Which year a report lists. Costs always come from all the history there is.
public enum TaxYear: Hashable, Sendable, Encodable {
    /// The newest year with some history.
    case latest
    case all
    case year(Int)

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .latest: try container.encode("latest")
        case .all: try container.encode("all")
        case .year(let year): try container.encode(year)
        }
    }
}

/// One of the file's first rows: see `TaxPreviewRow` in `src/core/tax.ts`.
public struct TaxPreviewRow: Codable, Sendable, Equatable {
    public let timestamp: String
    /// "Sold", "Network fee" or "Sent".
    public let type: String
    public let asset: String
    public let amount: String
    public let decimals: Int
    /// nil is unknown, which is never 0.
    public let gainMicros: String?
    public let status: String

    /// An estimate reads as one here too. nil when the gain is unknown.
    public func gainText(_ currency: CurrencyCode) -> String? {
        gainMicros.map { Format.estimate(Format.signedMoney($0, currency), status == "estimated") }
    }
}

/// What the server sends: see `TaxReportResponse` in `src/core/api.ts`.
public struct TaxReport: Codable, Sendable, Equatable {
    public struct Defaults: Codable, Sendable, Equatable {
        public let method: CostMethod
        public let scope: TaxScope
    }

    /// The same rows in the shape of the country's own form, like Form 8949 or Schedule 3.
    public struct Form: Codable, Sendable, Equatable {
        public let name: String
        public let filename: String
        public let csv: String
    }

    public let wallets: [String]
    public let country: TaxCountry
    public let method: CostMethod
    public let scope: TaxScope
    public let currency: CurrencyCode
    public let defaults: Defaults
    /// nil when it lists every year.
    public let year: Int?
    /// Newest first.
    public let years: [Int]
    /// Why the year's history isn't all here, when it isn't.
    public let partialYear: String?
    public let rowCount: Int
    /// Each sale, fee and send once, where `rowCount` counts one split into a known and an unknown part twice.
    public let soldCount: Int
    public let feeCount: Int
    public let sentCount: Int
    /// Of those, how many have an unknown gain, in whole or in part.
    public let unknownCount: Int
    /// The wallets with something unknown, in the order of `wallets`.
    public let unknownWallets: [String]
    public let unresolvedCount: Int
    public let estimatedCount: Int
    /// Only rows whose gain is known, and nil when none is. Read it next to `unresolvedCount`.
    public let gainMicros: String?
    public let disclaimer: String
    public let warnings: [String]
    public let notes: [String]
    public let preview: [TaxPreviewRow]
    public let filename: String
    public let csv: String
    public let form: Form?

    /// The total, marked when any row in it rests on an estimate. nil when it's unknown.
    public var gainText: String? {
        gainMicros.map { Format.estimate(Format.signedMoney($0, currency), estimatedCount > 0) }
    }

    /// Sales, fees and sends, each counted once.
    public var eventCount: Int { soldCount + feeCount + sentCount }
}

/// One report, in full context, because the same choices mean something else on another wallet or currency.
public struct TaxReportRequest: Hashable, Sendable {
    public let address: String
    public let country: TaxCountry
    public let method: CostMethod
    public let scope: TaxScope
    public let year: TaxYear
    public let currency: CurrencyCode
    /// The wallets this app already knows are the user's, like its hot and cold ones, or All Yours' other wallets. The server adds
    /// the ones the answers say are theirs.
    public let linked: [String]
    public let serverURL: URL
    public let book: Book

    /// What goes with the request. A post, because answers don't belong in a URL, where they'd end up in logs.
    var body: Body {
        var seen = Set<String>()
        return Body(country: country, method: method, scope: scope, year: year, currency: currency, also: linked.filter { $0 != address && seen.insert($0).inserted }, book: book)
    }

    struct Body: Encodable, Equatable {
        let country: TaxCountry
        let method: CostMethod
        let scope: TaxScope
        let year: TaxYear
        let currency: CurrencyCode
        let also: [String]
        let book: Book
    }
}

/// The report sheet's choices, remembered across restarts, and the report they give.
@MainActor
@Observable
public final class TaxReportModel {
    public enum State: Equatable, Sendable {
        case loading
        case ready(TaxReport)
        case failed(String)
    }

    public private(set) var country: TaxCountry
    /// nil follows what the country calls for. Choosing another country goes back to that.
    private var chosenMethod: CostMethod?
    private var chosenScope: TaxScope?
    /// Not remembered: opening the report again starts on the newest year.
    public private(set) var year: TaxYear = .latest
    /// Every year with some history, newest first, from the last report.
    public private(set) var years: [Int] = []
    public private(set) var state: State = .loading

    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private let fetch: @MainActor (TaxReportRequest) async throws -> TaxReport

    public init(defaults: UserDefaults = .standard, currency: CurrencyCode, fetch: @escaping @MainActor (TaxReportRequest) async throws -> TaxReport) {
        self.defaults = defaults
        self.fetch = fetch
        country = defaults.string(forKey: Keys.country).flatMap(TaxCountry.init(rawValue:)) ?? .guess(from: currency)
        // An override only makes sense for the country it was made on, and that's the one remembered.
        chosenMethod = defaults.string(forKey: Keys.method).flatMap(CostMethod.init(rawValue:))
        chosenScope = defaults.string(forKey: Keys.scope).flatMap(TaxScope.init(rawValue:))
    }

    public var method: CostMethod { chosenMethod ?? country.defaultMethod }
    public var scope: TaxScope { chosenScope ?? country.defaultScope }

    public func setCountry(_ next: TaxCountry) {
        guard next != country else { return }
        country = next
        chosenMethod = nil
        chosenScope = nil
        defaults.set(next.rawValue, forKey: Keys.country)
        defaults.removeObject(forKey: Keys.method)
        defaults.removeObject(forKey: Keys.scope)
    }

    public func setMethod(_ next: CostMethod) {
        chosenMethod = next == country.defaultMethod ? nil : next
        defaults.set(chosenMethod?.rawValue, forKey: Keys.method)
        // What's remembered has to say which country this override is for.
        defaults.set(country.rawValue, forKey: Keys.country)
    }

    public func setScope(_ next: TaxScope) {
        chosenScope = next == country.defaultScope ? nil : next
        defaults.set(chosenScope?.rawValue, forKey: Keys.scope)
        defaults.set(country.rawValue, forKey: Keys.country)
    }

    /// The year on screen, which for the newest one is the year itself once a report has said which that is.
    public var shownYear: TaxYear {
        if year == .latest, let newest = years.first { return .year(newest) }
        return year
    }

    public func setYear(_ next: TaxYear) {
        // Picking the year already showing changes nothing, so it doesn't ask again.
        guard next != shownYear else { return }
        year = next
    }

    /// What the report used to let people type in as their other wallets, which it kept here. Saying so said they're the user's, so whoever
    /// calls this links them, and they're gone from here. Anything that isn't an address was a typo, and goes too.
    public func takeTypedWallets() -> [String] {
        guard let text = defaults.string(forKey: Keys.otherWallets) else { return [] }
        defaults.removeObject(forKey: Keys.otherWallets)
        var seen = Set<String>()
        return text.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map { $0.lowercased() }.filter { WalletAddress.isValid($0) && seen.insert($0).inserted }
    }

    /// The wallets a report on `address` covers, the way the server picks them: with any of the user's own, every wallet the answers say is
    /// theirs. A wallet nobody's said is theirs is only itself, and so is the demo, whose report stays its own.
    public static func wallets(address: String, linked: [String], book: Book) -> [String] {
        guard !WalletAddress.isDemo(address) else { return [address] }
        let answered = book.linkedWallets.filter { !WalletAddress.isDemo($0) }
        guard !linked.isEmpty || answered.contains(address) else { return [address] }
        var seen = Set<String>()
        return ([address] + linked + answered).filter { seen.insert($0).inserted }
    }

    /// Whether adding this one would change anything. The ones the report already covers are in it.
    public static func offers(_ wallet: WalletEntry, covered: [String]) -> Bool {
        !covered.contains(wallet.address)
    }

    /// nil with no wallet.
    public func request(address: String?, currency: CurrencyCode, serverURL: URL, book: Book = Book(), linked: [String] = []) -> TaxReportRequest? {
        guard let address else { return nil }
        return TaxReportRequest(address: address, country: country, method: method, scope: scope, year: year, currency: currency, linked: address == WalletAddress.demo ? [] : linked, serverURL: serverURL, book: book)
    }

    /// What's on screen goes as soon as the choices change, because it's about the old ones.
    public func load(_ request: TaxReportRequest) async {
        state = .loading
        do {
            let report = try await fetch(request)
            guard !Task.isCancelled else { return }
            years = report.years
            state = .ready(report)
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            state = .failed(failureMessage(for: error))
        }
    }

    private enum Keys {
        static let country = "taxCountry"
        static let method = "taxMethod"
        static let scope = "taxScope"
        /// Only read to carry what's there over: see `takeTypedWallets`.
        static let otherWallets = "taxOtherWallets"
    }
}
