// Display only, and the same output as `packages/sdk/src/format.ts`: a test runs both on the same inputs.
// Amounts are cut as strings, because a token amount can be far bigger than any number type here.

import Foundation

public enum Format {
    private static let locale = Locale(identifier: "en_US")

    private static func whole(_ micros: String) -> Decimal {
        (Decimal(string: micros) ?? 0) / 1_000_000
    }

    private static func twoDecimals(_ value: Decimal, _ currency: CurrencyCode) -> String {
        let style = Decimal.FormatStyle.Currency(code: currency.rawValue).locale(currency.locale).rounded(rule: .toNearestOrAwayFromZero)
        return value.formatted(currency.isNarrow ? style.presentation(.narrow) : style)
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

    /// USD beside amounts in the main currency. If that's another kind of dollar, a bare "$" doesn't say which. Takes what's already formatted, sign and all.
    public static func usd(_ text: String, beside main: CurrencyCode) -> String {
        main == .USD ? text : text.replacing("$", with: "US$", maxReplacements: 1)
    }

    /// What someone actually paid, in what they paid it in. Beside another main currency, it says which.
    public static func money(_ money: Money, beside main: CurrencyCode) -> String {
        let text = Self.money(money.micros, money.currency)
        return money.currency == main ? text : text.replacing(money.currency.symbol, with: money.currency.label, maxReplacements: 1)
    }

    /// In plain digits for a provider, with no symbol or grouping.
    static func plainAmount(_ micros: String) -> String {
        "\(whole(micros))"
    }

    /// One side of a comparison. A nil is unavailable, not zero.
    public static func ruleValue(_ micros: String?, format: String, currency: CurrencyCode, isEstimate: Bool = false) -> String {
        guard let micros else { return "Unavailable" }
        switch format {
        case "usdPrice": return estimate(usd(price(micros, .USD), beside: currency), isEstimate)
        case "money": return estimate(money(micros, currency), isEstimate)
        default: return estimate(signedMoney(micros, currency), isEstimate)
        }
    }

    /// Always signed, so which way it went can be read at a glance. A price's is small, so it keeps its digits.
    public static func ruleDifference(_ micros: String?, format: String, currency: CurrencyCode, isEstimate: Bool = false) -> String {
        guard let micros else { return "—" }
        if whole(micros) == 0 { return "Same" }
        guard format == "usdPrice" else { return estimate(signedMoney(micros, currency), isEstimate) }
        let isNegative = micros.hasPrefix("-")
        return estimate(usd("\(isNegative ? "-" : "+")\(price(isNegative ? String(micros.dropFirst()) : micros, .USD))", beside: currency), isEstimate)
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

    /// A number as someone typed it, without its spaces and grouping, or nil when a comma in it can't be told apart. Whether what's left is a number is the caller's to check.
    /// A comma only groups thousands in threes, so "46,20" is 46.20, and dropping it would make that 4,620. Anything else with a comma is refused rather than guessed.
    public static func plainAmount(_ text: String) -> String? {
        let clean = text.filter { !$0.isWhitespace }
        if clean.wholeMatch(of: /[0-9]+,[0-9]{1,2}/) != nil { return clean.replacing(",", with: ".") }
        if clean.contains(","), clean.wholeMatch(of: /[1-9][0-9]{0,2}(,[0-9]{3})+(\.[0-9]*)?/) == nil { return nil }
        return clean.replacing(",", with: "")
    }

    /// A cost as someone typed it, without the main currency's own symbol or code, before or after. Any other symbol stays, so it isn't read as an amount in this currency.
    static func withoutCurrency(_ text: String, _ currency: CurrencyCode) -> String {
        let clean = text.trimmingCharacters(in: .whitespaces)
        // Longest first, so "46 ZAR" isn't read as "46 ZA" and an R.
        for mark in [currency.label, currency.symbol, currency.rawValue].map({ $0.trimmingCharacters(in: .whitespaces) }).sorted(by: { $0.count > $1.count }) {
            if clean.hasPrefix(mark) { return String(clean.dropFirst(mark.count)) }
            if clean.hasSuffix(mark) { return String(clean.dropLast(mark.count)) }
        }
        return clean
    }

    /// Millionths of `currency` from what someone typed, like "$1,234.50" or "46,20". nil when it isn't an amount, which includes one in another currency's symbol: "€46" isn't 46 dollars. Cents past six places are cut.
    public static func micros(fromDollars text: String, in currency: CurrencyCode = .USD) -> String? {
        guard let clean = plainAmount(withoutCurrency(text, currency)), clean.wholeMatch(of: /\d+(\.\d*)?|\.\d+/) != nil else { return nil }
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

    public static func duration(ms: Int) -> String {
        let minutes = Int((Double(ms) / 60_000).rounded())
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
