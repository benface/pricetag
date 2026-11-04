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
    public let rowCount: Int
    public let unresolvedCount: Int
    public let estimatedCount: Int
    /// Only rows whose gain is known, and nil when none is. Read it next to `unresolvedCount`.
    public let gainMicros: String?
    public let disclaimer: String
    public let warnings: [String]
    public let notes: [String]
    public let filename: String
    public let csv: String
}

/// One report, in full context, because the same choices mean something else on another wallet or currency.
public struct TaxReportRequest: Hashable, Sendable {
    public let address: String
    public let country: TaxCountry
    public let method: CostMethod
    public let scope: TaxScope
    public let currency: CurrencyCode
    public let otherWallets: [String]
    public let serverURL: URL

    var queryItems: [URLQueryItem] {
        var items = [
            URLQueryItem(name: "country", value: country.rawValue),
            URLQueryItem(name: "method", value: method.rawValue),
            URLQueryItem(name: "scope", value: scope.rawValue),
            URLQueryItem(name: "currency", value: currency.rawValue),
        ]
        if !otherWallets.isEmpty { items.append(URLQueryItem(name: "also", value: otherWallets.joined(separator: ","))) }
        return items
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

    /// The first thing typed that can't be a wallet. Nothing's asked of the server until it's fixed.
    public var badWallet: String? {
        otherWallets.first { !WalletAddress.isValid($0) }
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

    public func setOtherWalletsText(_ next: String) {
        otherWalletsText = next
        defaults.set(next, forKey: Keys.otherWallets)
    }

    /// nil with no wallet, or while what's typed can't be sent. The demo wallet can't be combined with anything.
    public func request(address: String?, currency: CurrencyCode, serverURL: URL) -> TaxReportRequest? {
        guard let address, badWallet == nil else { return nil }
        let isDemo = address == WalletAddress.demo
        return TaxReportRequest(address: address, country: country, method: method, scope: scope, currency: currency, otherWallets: isDemo ? [] : otherWallets, serverURL: serverURL)
    }

    /// What's on screen goes as soon as the choices change, because it's about the old ones.
    public func load(_ request: TaxReportRequest) async {
        state = .loading
        do {
            let report = try await fetch(request)
            guard !Task.isCancelled else { return }
            state = .ready(report)
        } catch {
            guard !Task.isCancelled, !(error is CancellationError) else { return }
            state = .failed(Self.message(for: error))
        }
    }

    private static func message(for error: any Error) -> String {
        switch error as? FetchError {
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): message
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
