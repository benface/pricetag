// The currencies a portfolio can be shown in, and what a purchase can be paid in: see `packages/sdk/src/currency.ts`. The server does the converting, and this only
// says how to ask for one and how to print it. A test checks the printing against the web app.

import Foundation

public enum CurrencyCode: String, Codable, Sendable, CaseIterable, Identifiable {
    case USD, CAD, EUR, GBP, CHF

    /// What a portfolio can be shown in. The rest are only what something was paid in, until the screens are ready for them.
    public static let mainChoices: [CurrencyCode] = [.USD, .CAD]

    public var id: Self { self }

    public var name: String {
        switch self {
        case .USD: "US dollar"
        case .CAD: "Canadian dollar"
        case .EUR: "Euro"
        case .GBP: "British pound"
        case .CHF: "Swiss franc"
        }
    }

    var locale: Locale {
        switch self {
        case .USD, .CHF: Locale(identifier: "en_US")
        case .CAD: Locale(identifier: "en_CA")
        case .EUR: Locale(identifier: "en_IE")
        case .GBP: Locale(identifier: "en_GB")
        }
    }

    /// Printed by hand before amounts too small for two decimals.
    var symbol: String {
        switch self {
        case .USD, .CAD: "$"
        case .EUR: "€"
        case .GBP: "£"
        case .CHF: "CHF\u{00A0}"
        }
    }
}
