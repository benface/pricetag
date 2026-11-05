// The currencies a portfolio can be shown in: see `packages/sdk/src/currency.ts`. The server does the converting, and this only
// says how to ask for one and how to print it. A test checks the printing against the web app.

import Foundation

public enum CurrencyCode: String, Codable, Sendable, CaseIterable, Identifiable {
    case USD, CAD

    public var id: Self { self }

    public var name: String {
        switch self {
        case .USD: "US dollar"
        case .CAD: "Canadian dollar"
        }
    }

    var locale: Locale {
        switch self {
        case .USD: Locale(identifier: "en_US")
        case .CAD: Locale(identifier: "en_CA")
        }
    }

    /// Printed by hand before amounts too small for two decimals.
    var symbol: String {
        switch self {
        case .USD, .CAD: "$"
        }
    }

    /// Printed instead of `symbol` beside amounts in another currency, where a bare "$" doesn't say which.
    var label: String {
        switch self {
        case .USD: "US$"
        case .CAD: "CA$"
        }
    }
}

/// USD amounts as someone should read them right now: in their main currency at the current rate, or labelled as USD when
/// there's no rate. Never a guess. It's only for reading: the cap, sweeps and what's signed stay in USD, so a rate decides none of them.
public struct MoneyDisplay: Equatable, Sendable {
    private static let million: UInt128 = 1_000_000

    public let main: CurrencyCode
    /// What one USD buys, in millionths. Nil in USD, or with no current rate.
    private let rateMicros: UInt128?

    public init(main: CurrencyCode, rateMicros: String? = nil) {
        self.main = main
        let rate = rateMicros.flatMap { UInt128($0) }
        self.rateMicros = main == .USD || rate == 0 ? nil : rate
    }

    /// The currency amounts read and are typed in: the main one, or USD without a rate.
    public var currency: CurrencyCode { rateMicros == nil ? .USD : main }

    /// Whether the numbers here have been through a rate, so they can move while the USD behind them stays put.
    public var isConverted: Bool { rateMicros != nil }

    /// What goes before a number someone types.
    public var symbol: String { currency == main ? main.symbol : currency.label }

    public func money(_ usdMicros: UInt128) -> String {
        guard let rateMicros else { return Format.usd(Format.money(String(usdMicros), .USD), beside: main) }
        return Format.money(String(Self.scale(usdMicros, by: rateMicros, over: Self.million)), main)
    }

    /// In whole units, for a slider or a limit, where cents would only say what the rate did. Rounded to the nearest unless a limit needs otherwise.
    public func whole(_ usdMicros: UInt128, rounding: FloatingPointRoundingRule = .toNearestOrAwayFromZero) -> String {
        "\(symbol)\(wholeAmount(usdMicros, rounding: rounding))"
    }

    public func whole(dollars: Int) -> String {
        whole(UInt128(max(dollars, 0)) * Self.million)
    }

    /// A cap keeps its cents in USD, and in another currency they'd only say what the rate did.
    public func cap(_ usdMicros: UInt128) -> String {
        isConverted ? whole(usdMicros) : money(usdMicros)
    }

    /// How many whole units this is, in what's shown.
    public func wholeAmount(_ usdMicros: UInt128, rounding: FloatingPointRoundingRule = .toNearestOrAwayFromZero) -> Int {
        let units = rateMicros.map { Self.scale(usdMicros, by: $0, over: Self.million) } ?? usdMicros
        let (whole, part) = units.quotientAndRemainder(dividingBy: Self.million)
        let isUp = switch rounding {
        case .down: false
        case .up: part > 0
        default: part >= Self.million / 2
        }
        return Int(clamping: whole + (isUp ? 1 : 0))
    }

    /// What an amount typed in whole units is in USD. Nothing below zero.
    public func usdMicros(ofWhole amount: Int) -> UInt128 {
        let units = UInt128(max(amount, 0)) * Self.million
        return rateMicros.map { Self.scale(units, by: Self.million, over: $0) } ?? units
    }

    /// a × b ÷ c, through 256 bits. Saturates rather than trapping, which only something absurd could reach.
    private static func scale(_ a: UInt128, by b: UInt128, over c: UInt128) -> UInt128 {
        let product = a.multipliedFullWidth(by: b)
        return product.high < c ? c.dividingFullWidth(product).quotient : .max
    }
}
