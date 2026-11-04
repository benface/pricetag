// Display only, and the same output as `src/core/format.ts`: a test runs both on the same inputs.
// Amounts are cut as strings, because a token amount can be far bigger than any number type here.

import Foundation

public enum Format {
    private static let locale = Locale(identifier: "en_US")

    private static func whole(_ micros: String) -> Decimal {
        (Decimal(string: micros) ?? 0) / 1_000_000
    }

    private static func twoDecimals(_ value: Decimal, _ currency: CurrencyCode) -> String {
        value.formatted(.currency(code: currency.rawValue).locale(currency.locale).rounded(rule: .toNearestOrAwayFromZero))
    }

    private static func significant(_ value: Decimal, _ digits: Int, _ currency: CurrencyCode) -> String {
        value.formatted(.number.locale(currency.locale).precision(.significantDigits(1...digits)).rounded(rule: .toNearestOrAwayFromZero))
    }

    public static func money(_ micros: String, _ currency: CurrencyCode) -> String {
        let value = whole(micros)
        let size = abs(value)
        if size == 0 { return twoDecimals(0, currency) }
        // Small amounts matter here: gas is often a fraction of a cent, and "$0.00" would read as nothing.
        if size < Decimal(string: "0.01")! { return "\(value < 0 ? "-" : "")\(currency.symbol)\(significant(size, 2, currency))" }
        return twoDecimals(value, currency)
    }

    public static func price(_ micros: String, _ currency: CurrencyCode) -> String {
        let value = whole(micros)
        return value >= 1 ? twoDecimals(value, currency) : "\(currency.symbol)\(significant(value, 4, currency))"
    }

    public static func signedMoney(_ micros: String, _ currency: CurrencyCode) -> String {
        isPositive(micros) ? "+\(money(micros, currency))" : money(micros, currency)
    }

    /// Whole tokens from smallest units, cut to a readable length. Cuts instead of rounding, so it never shows more than there is.
    public static func amount(_ units: String, decimals: Int) -> String {
        let negative = units.hasPrefix("-")
        let digits = negative ? String(units.dropFirst()) : units
        let padded = String(repeating: "0", count: max(0, decimals + 1 - digits.count)) + digits
        let whole = String(padded.dropLast(decimals))
        let fraction = String(padded.suffix(decimals))
        let leadingZeros = fraction.prefix { $0 == "0" }.count
        let shown = whole.count >= 4 ? 2 : whole != "0" ? 4 : leadingZeros + 3
        var cut = String(fraction.prefix(shown))
        while cut.hasSuffix("0") { cut.removeLast() }
        return "\(negative ? "-" : "")\(grouped(whole))\(cut.isEmpty ? "" : ".\(cut)")"
    }

    public static func signedAmount(_ units: String, decimals: Int) -> String {
        isPositive(units) ? "+\(amount(units, decimals: decimals))" : amount(units, decimals: decimals)
    }

    /// An estimate has to look different from an exact value, wherever it's shown.
    public static func estimate(_ text: String, _ isEstimate: Bool) -> String {
        isEstimate ? "≈\(text)" : text
    }

    /// Micro-USD from what someone typed, like "$1,234.50". nil when it isn't an amount. Cents past six places are cut.
    public static func micros(fromDollars text: String) -> String? {
        let clean = text.filter { !" $,".contains($0) }
        guard clean.wholeMatch(of: /\d+(\.\d*)?|\.\d+/) != nil else { return nil }
        let parts = clean.split(separator: ".", omittingEmptySubsequences: false)
        let whole = parts.first.map(String.init) ?? ""
        let fraction = parts.count > 1 ? String(parts[1].prefix(6)) : ""
        let digits = (whole + fraction.padding(toLength: 6, withPad: "0", startingAt: 0)).drop { $0 == "0" }
        return digits.isEmpty ? "0" : String(digits)
    }

    public static func block(_ number: Int) -> String {
        number.formatted(.number.locale(locale))
    }

    public static func shortHash(_ hash: String) -> String {
        "\(hash.prefix(6))…\(hash.suffix(4))"
    }

    public static func time(_ date: Date) -> String {
        date.formatted(.dateTime.month(.abbreviated).day().hour().minute().locale(locale))
    }

    public static func duration(blocks: Int) -> String {
        let minutes = Int((Double(blocks * 2) / 60).rounded())
        if minutes < 120 { return "\(minutes) min" }
        return "\(Int((Double(minutes) / 60).rounded())) h"
    }

    /// For charts, which need a position and not a value to show. Never used to compute anything.
    static func chartValue(_ micros: String) -> Double {
        (Double(micros) ?? 0) / 1_000_000
    }

    private static func grouped(_ whole: String) -> String {
        var result = ""
        for (index, digit) in whole.enumerated() {
            if index > 0, (whole.count - index) % 3 == 0 { result.append(",") }
            result.append(digit)
        }
        return result
    }
}
