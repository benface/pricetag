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
}

/// What the server sends: see `TaxReportResponse` in `src/core/api.ts`.
public struct TaxReport: Codable, Sendable, Equatable {
    public struct Defaults: Codable, Sendable, Equatable {
        public let method: CostMethod
        public let scope: TaxScope
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
    public let selfReportedCount: Int
    /// Only rows whose gain is known, and nil when none is. Read it next to `unresolvedCount`.
    public let gainMicros: String?
    public let disclaimer: String
    public let warnings: [String]
    public let notes: [String]
    public let preview: [TaxPreviewRow]
    public let filename: String
    public let csv: String

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
    public let otherWallets: [String]
    /// The wallets this app already knows are the user's, like its hot and cold ones.
    public let linked: [String]
    public let serverURL: URL
    public let book: Book

    /// What goes with the request. A post, because answers don't belong in a URL, where they'd end up in logs.
    var body: Body {
        var seen = Set<String>()
        return Body(country: country, method: method, scope: scope, year: year, currency: currency, also: (otherWallets + linked).filter { seen.insert($0).inserted }, book: book)
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
    public private(set) var otherWalletsText: String
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
        otherWalletsText = defaults.string(forKey: Keys.otherWallets) ?? ""
        // An override only makes sense for the country it was made on, and that's the one remembered.
        chosenMethod = defaults.string(forKey: Keys.method).flatMap(CostMethod.init(rawValue:))
        chosenScope = defaults.string(forKey: Keys.scope).flatMap(TaxScope.init(rawValue:))
    }

    public var method: CostMethod { chosenMethod ?? country.defaultMethod }
    public var scope: TaxScope { chosenScope ?? country.defaultScope }

    public var otherWallets: [String] {
        otherWalletsText.split(whereSeparator: { $0.isWhitespace || $0 == "," }).map { $0.lowercased() }
    }

    /// The first thing typed that can't be a wallet. Nothing's asked of the server until it's fixed. The demo wallet can't
    /// be combined with anything, so what's saved from another wallet is ignored there: its field for fixing it isn't shown.
    public func badWallet(for address: String?) -> String? {
        address == WalletAddress.demo ? nil : otherWallets.first { !WalletAddress.isValid($0) }
    }

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

    public func setOtherWalletsText(_ next: String) {
        otherWalletsText = next
        defaults.set(next, forKey: Keys.otherWallets)
    }

    public func addOtherWallet(_ address: String) {
        let address = address.lowercased()
        if !otherWallets.contains(address) { setOtherWalletsText((otherWallets + [address]).joined(separator: "\n")) }
    }

    public func removeOtherWallet(_ address: String) {
        setOtherWalletsText(otherWallets.filter { $0 != address }.joined(separator: "\n"))
    }

    /// Whether adding this one would change anything. The wallet showing and the ones linked to it are already in the report.
    public func offers(_ wallet: WalletEntry, showing: String?, linked: [String]) -> Bool {
        wallet.address != showing && !linked.contains(wallet.address) && !otherWallets.contains(wallet.address)
    }

    /// nil with no wallet, or while what's typed can't be sent.
    public func request(address: String?, currency: CurrencyCode, serverURL: URL, book: Book = Book(), linked: [String] = []) -> TaxReportRequest? {
        guard let address, badWallet(for: address) == nil else { return nil }
        let isDemo = address == WalletAddress.demo
        return TaxReportRequest(address: address, country: country, method: method, scope: scope, year: year, currency: currency, otherWallets: isDemo ? [] : otherWallets, linked: isDemo ? [] : linked, serverURL: serverURL, book: book)
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
            state = .failed(Self.message(for: error))
        }
    }

    private static func message(for error: any Error) -> String {
        switch error as? FetchError {
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): message
        case .timedOut: Wording.serverTooSlow
        case .unreachable, nil: "Can't reach the server."
        }
    }

    private enum Keys {
        static let country = "taxCountry"
        static let method = "taxMethod"
        static let scope = "taxScope"
        static let otherWallets = "taxOtherWallets"
    }
}
