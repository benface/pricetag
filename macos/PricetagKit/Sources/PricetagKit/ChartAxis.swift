// Where a chart's axes are marked, and what each mark says. No two marks may read the same, however small the amounts or short the time.
// The money axis prints the same as `chartMoneyTicks` in `packages/sdk/src/format.ts`: a test runs both on the same inputs.

import Foundation

enum ChartAxis {
    struct MoneyTick: Equatable {
        let value: Double
        let label: String
    }

    /// Marks for these values and zero, each as precise as the distance between them, so a chart of fractions of a cent doesn't label every line $0.
    /// Without zero, they only span the values, for something that's never below it and moves little next to its size, like what's held.
    static func moneyTicks(_ values: [Double], _ currency: CurrencyCode, includingZero: Bool = true) -> [MoneyTick] {
        let low = includingZero ? min(0, values.min() ?? 0) : values.min() ?? 0
        let high = includingZero ? max(0, values.max() ?? 0) : values.max() ?? 0
        let raw = (high > low ? high - low : 1) / 4
        let magnitude = pow(10, floor(log10(raw)))
        // PnL comes in millionths of a dollar, so nothing's finer than that.
        let step = max(0.000001, [1, 2, 2.5, 5, 10].map { $0 * magnitude }.first { $0 >= raw } ?? raw)
        return (Int(floor(low / step))...Int(ceil(high / step))).map { index in
            let value = Double(index) * step
            return MoneyTick(value: value, label: moneyLabel(value, step: step, currency))
        }
    }

    /// What the chart spans, which has to have some height even when there's only one mark.
    static func moneyDomain(_ ticks: [MoneyTick]) -> ClosedRange<Double> {
        let low = ticks.first?.value ?? 0
        let high = ticks.last?.value ?? 0
        return low < high ? low...high : (low - 1)...(high + 1)
    }

    private static func moneyLabel(_ value: Double, step: Double, _ currency: CurrencyCode) -> String {
        let style = Decimal.FormatStyle.Currency(code: currency.rawValue).locale(currency.locale).rounded(rule: .toNearestOrAwayFromZero)
        let amount = Decimal(string: String(format: "%.9f", value)) ?? 0
        if step >= 1000 { return amount.formatted(style.notation(.compactName).precision(.fractionLength(0...2))) }
        let digits = (0...8).first { digits in
            let shifted = step * pow(10, Double(digits))
            return abs(shifted - shifted.rounded()) < 0.000001
        } ?? 8
        // Money doesn't read right with one decimal.
        return amount.formatted(style.precision(.fractionLength(digits == 1 ? 2 : digits)))
    }

    /// Marks on round times for a span of dates, and how to label them.
    struct TimeAxis {
        enum Label: Equatable { case second, minute, dayAndHour, day, month }

        let ticks: [Date]
        let label: Label
        /// What the chart spans, which has to have some width even for a single moment.
        let domain: ClosedRange<Date>
        /// Only where times would otherwise read the same, in the hour that repeats when the clocks go back.
        let showsTimeZone: Bool

        private static let minute = 60.0
        private static let hour = 3600.0
        private static let day = 86400.0
        private static let month = 30.44 * day
        private static let steps: [(unit: Calendar.Component, count: Int, seconds: TimeInterval)] =
            [1, 2, 5, 10, 15, 30].map { (.second, $0, Double($0)) }
            + [1, 2, 5, 10, 15, 30].map { (.minute, $0, Double($0) * minute) }
            + [1, 2, 3, 6, 12].map { (.hour, $0, Double($0) * hour) }
            + [1, 2, 5, 7, 14].map { (.day, $0, Double($0) * day) }
            + [1, 2, 3, 6, 12, 24, 60, 120].map { (.month, $0, Double($0) * month) }

        init(dates: [Date], calendar: Calendar = .current) {
            guard let start = dates.first, let end = dates.last, start < end else {
                let moment = dates.first ?? .now
                ticks = [moment]
                label = .minute
                domain = moment.addingTimeInterval(-30)...moment.addingTimeInterval(30)
                showsTimeZone = false
                return
            }
            let span = end.timeIntervalSince(start)
            let step = Self.steps.first { span / $0.seconds <= 5 } ?? Self.steps[Self.steps.count - 1]
            var ticks: [Date] = []
            var tick = Self.roundedDown(start, to: step.unit, count: step.count, calendar)
            while tick <= end {
                if tick >= start { ticks.append(tick) }
                guard let next = calendar.date(byAdding: step.unit, value: step.count, to: tick), next > tick else { break }
                tick = next
            }
            self.ticks = ticks.isEmpty ? [start] : ticks
            domain = start...end
            switch step.unit {
            case .second: label = .second
            // Across more than a day, the same time of day comes around again.
            case .minute, .hour: label = span < Self.day ? .minute : .dayAndHour
            case .day: label = .day
            default: label = .month
            }
            var plain = Self.format(label, showsTimeZone: false)
            plain.timeZone = calendar.timeZone
            plain.locale = Locale(identifier: "en_US")
            showsTimeZone = Set(self.ticks.map { $0.formatted(plain) }).count < self.ticks.count
        }

        private static func roundedDown(_ date: Date, to unit: Calendar.Component, count: Int, _ calendar: Calendar) -> Date {
            let kept: [Calendar.Component]
            switch unit {
            case .second: kept = [.year, .month, .day, .hour, .minute, .second]
            case .minute: kept = [.year, .month, .day, .hour, .minute]
            case .hour: kept = [.year, .month, .day, .hour]
            case .day: kept = [.year, .month, .day]
            default: kept = [.year, .month]
            }
            var parts = calendar.dateComponents(Set(kept), from: date)
            switch unit {
            case .second: parts.second = (parts.second ?? 0) / count * count
            case .minute: parts.minute = (parts.minute ?? 0) / count * count
            case .hour: parts.hour = (parts.hour ?? 0) / count * count
            case .month: parts.month = ((parts.month ?? 1) - 1) / count * count + 1
            default: break
            }
            return calendar.date(from: parts) ?? date
        }

        var format: Date.FormatStyle {
            Self.format(label, showsTimeZone: showsTimeZone)
        }

        private static func format(_ label: Label, showsTimeZone: Bool) -> Date.FormatStyle {
            let style: Date.FormatStyle
            switch label {
            case .second: style = .dateTime.hour().minute().second()
            case .minute: style = .dateTime.hour().minute()
            case .dayAndHour: style = .dateTime.month(.abbreviated).day().hour()
            case .day: style = .dateTime.month(.abbreviated).day()
            case .month: style = .dateTime.month(.abbreviated).year()
            }
            return showsTimeZone ? style.timeZone(.specificName(.short)) : style
        }
    }
}
