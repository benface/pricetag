import Charts
import SwiftUI

/// Total PnL after each transaction, or what was held then. PnL holds still between transactions, so it's drawn as steps. Value is only known at them, so it's dashed in between (see `ValueSeries`).
/// Point at it or drag across it for a value that follows, and click a step for its transaction.
/// The line stops where nothing is known. The same transactions are in `TransactionsTable`, for the keyboard and VoiceOver.
public struct PnlChartView: View {
    /// What's in view, which sets the scales and what you can point at.
    let points: [PnlPoint]
    /// The whole line, so going from one timeframe to another zooms the same line instead of swapping it for another. What's out of view is clipped.
    let history: [PnlPoint]
    let currency: CurrencyCode
    let isLive: Bool
    let metric: ChartMetric
    let onSelect: (String) -> Void
    /// How much of the line is showing, from the left. It's the same line whatever this is: it's only uncovered, never redrawn with other numbers.
    let reveal: CGFloat
    /// Which transaction a scene holds the pointer on, since a test can't point at anything.
    let scrubbedIndex: Int?
    /// Which transaction is pointed at. Only its ID, so what's shown for it is always what the points say now, after a refresh or an answer too.
    @State private var hoveredID: String?
    @Environment(\.colorSchemeContrast) private var contrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(points: [PnlPoint], history: [PnlPoint]? = nil, currency: CurrencyCode, isLive: Bool, metric: ChartMetric = .pnl, reveal: CGFloat = 1, scrubbedIndex: Int? = nil, onSelect: @escaping (String) -> Void) {
        self.points = points
        self.history = history ?? points
        self.currency = currency
        self.isLive = isLive
        self.metric = metric
        self.reveal = reveal
        self.scrubbedIndex = scrubbedIndex
        self.onSelect = onSelect
    }

    /// A Color, because a chart reads plain styles like `.secondary` as shades of its accent.
    private var lineColor: Color {
        // Value isn't good or bad, so it has no tone.
        if metric == .value { return isLive ? .accentColor : .secondary }
        let tone = Tone(signed: points.last { $0.pnlMicros != nil }?.pnlMicros)
        return isLive && tone != .neutral ? tone.color : .secondary
    }

    public var body: some View {
        let series = PnlSeries(points: points)
        let drawn = PnlSeries(points: history)
        let values = ValueSeries(points: points)
        let drawnValues = ValueSeries(points: history)
        let lookup: any PlottedSeries = metric == .value ? values : series
        let hovered = lookup.transaction(id: hoveredID)
        let moneyTicks = metric == .value ? ChartAxis.moneyTicks(values.values, currency, includingZero: false) : ChartAxis.moneyTicks(series.plotted.compactMap(\.value), currency)
        let timeAxis = ChartAxis.TimeAxis(dates: series.plotted.map(\.date))
        Chart {
            ForEach(Array((metric == .value ? drawnValues.gaps : drawn.gaps).enumerated()), id: \.offset) { _, gap in
                RectangleMark(xStart: .value("Unknown from", gap.lowerBound), xEnd: .value("Unknown to", gap.upperBound))
                    .foregroundStyle(Color.secondary.opacity(Self.gapOpacity(contrast)))
            }
            if metric == .value {
                valueMarks(drawnValues, hovered: hovered, showsEveryDot: values.plotted.count <= 60)
            } else {
                pnlMarks(drawn, hovered: hovered)
            }
            if let hovered {
                RuleMark(x: .value("Time", hovered.date)).foregroundStyle(Color.secondary.opacity(0.6))
                PointMark(x: .value("Time", hovered.date), y: .value(metric.label, hovered.value ?? 0))
                    // Only there to carry the tooltip when the value is unknown, not to mark a place on the axis.
                    .foregroundStyle(hovered.value == nil ? Color.clear : lineColor)
                    // Inside the plot sideways, so at either end it doesn't cover the axis's labels.
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .plot), y: .fit(to: .chart))) {
                        tooltip(hovered.point, date: hovered.date)
                    }
            }
        }
        .chartYScale(domain: ChartAxis.moneyDomain(moneyTicks))
        .chartXScale(domain: timeAxis.domain)
        .chartYAxis {
            AxisMarks(position: .trailing, values: moneyTicks.map(\.value)) { value in
                AxisGridLine().foregroundStyle(Color.primary.opacity(contrast == .increased ? 0.2 : 0.08))
                AxisValueLabel {
                    // Formatted first: `Text(_:format:)` would swap in the system's locale, and print US$ in Canada.
                    Text(moneyTicks[value.index].label).monospacedDigit()
                }
            }
        }
        .chartXAxis {
            AxisMarks(values: timeAxis.ticks) { _ in
                AxisValueLabel(format: timeAxis.format)
            }
        }
        .chartPlotStyle { plot in
            plot.mask {
                // Cuts off what's out of view, and is a little wider and taller than the plot so what sits on its edge, like the last point, stays whole.
                // Its soft edge, for drawing in, is past that.
                GeometryReader { area in
                    let width = area.size.width + Self.overscan + Self.softEdge
                    Rectangle()
                        .fill(LinearGradient(stops: [.init(color: .black, location: 1 - Self.softEdge / width), .init(color: .clear, location: 1)], startPoint: .leading, endPoint: .trailing))
                        .frame(width: width)
                        .offset(x: width * (reveal - 1))
                        .frame(width: width, height: area.size.height + Self.overscan * 2, alignment: .leading)
                        .clipped()
                        .offset(y: -Self.overscan)
                }
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geometry in
                Rectangle()
                    .fill(.clear)
                    .contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let location):
                            hover(date(at: location, proxy: proxy, geometry: geometry).flatMap(lookup.nearestTransaction)?.id)
                        case .ended:
                            hoveredID = nil
                        }
                    }
                    // Pressing and dragging does the same as pointing, because hover stops while a button is down.
                    .gesture(DragGesture(minimumDistance: 3).onChanged { drag in
                        hover(date(at: drag.location, proxy: proxy, geometry: geometry).flatMap(lookup.nearestTransaction)?.id)
                    })
                    .onTapGesture { location in
                        if let hash = date(at: location, proxy: proxy, geometry: geometry).flatMap(lookup.nearestTransaction)?.point.txHash {
                            onSelect(hash)
                        }
                    }
                    // For the transaction under the pointer, the one a click would open.
                    .contextMenu {
                        if let hash = hovered?.point.txHash {
                            TransactionActions(hash: hash) { onSelect(hash) }
                        }
                    }
            }
        }
        // A tick under the finger for each transaction passed, on a trackpad that can.
        .sensoryFeedback(.alignment, trigger: hovered?.id) { _, id in id != nil }
        .onChange(of: scrubbedIndex, initial: true) { _, index in
            let plotted = lookup.plotted.filter { $0.point.txHash != nil }
            hover(index.flatMap { plotted.indices.contains($0) ? plotted[$0].id : nil })
        }
        .opacity(isLive ? 1 : 0.6)
        .animation(Motion.state, value: isLive)
        .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        switch metric {
        case .value: "Value over time, ending at \(points.last?.valueMicros.map { Format.money($0, currency) } ?? "unavailable")"
        case .pnl: "Total PnL over time, ending at \(points.last?.pnlMicros.map { Format.signedMoney($0, currency) } ?? "unavailable")"
        }
    }

    @ChartContentBuilder
    private func valueMarks(_ drawn: ValueSeries, hovered: PnlSeries.Plotted?, showsEveryDot: Bool) -> some ChartContent {
        ForEach(drawn.lines) { line in
            ForEach(line.steps) { step in
                LineMark(x: .value("Time", step.date), y: .value("Value", step.value), series: .value("Line", line.id))
                    // Known where it's solid. Dashed where only prices moved and nobody read them.
                    .lineStyle(line.known ? StrokeStyle(lineWidth: 2, lineCap: .round) : StrokeStyle(lineWidth: 1.5, lineCap: .round, dash: [3, 4]))
                    .foregroundStyle(line.known ? lineColor : lineColor.opacity(0.75))
            }
        }
        // Each place it's known, so a line between two of them doesn't read as known too. With many in view they'd be a thick line, so then only where now is, and what nothing else shows.
        let isNow = { (item: PnlSeries.Plotted) in item.date == drawn.plotted.last?.date }
        ForEach(drawn.plotted.filter { $0.value != nil && (showsEveryDot || isNow($0) || drawn.isolated.contains($0.id)) }) { item in
            PointMark(x: .value("Time", item.date), y: .value("Value", item.value ?? 0))
                .symbolSize(isNow(item) && hovered == nil ? 40 : 14)
                .foregroundStyle(lineColor)
        }
    }

    @ChartContentBuilder
    private func pnlMarks(_ drawn: PnlSeries, hovered: PnlSeries.Plotted?) -> some ChartContent {
        RuleMark(y: .value("Zero", 0))
            .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
            .foregroundStyle(Color.secondary.opacity(0.5))
        ForEach(Array(drawn.segments.enumerated()), id: \.offset) { index, segment in
            ForEach(segment) { step in
                AreaMark(x: .value("Time", step.date), yStart: .value("Zero", 0), yEnd: .value("PnL", step.value), series: .value("Segment", index))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(LinearGradient(colors: [lineColor.opacity(0.18), lineColor.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                LineMark(x: .value("Time", step.date), y: .value("PnL", step.value), series: .value("Segment", index))
                    .interpolationMethod(.stepEnd)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round))
                    .foregroundStyle(lineColor)
            }
        }
        // Where it stands now, at a glance.
        if hovered == nil, let last = drawn.segments.last?.last, last.date == drawn.plotted.last?.date {
            PointMark(x: .value("Time", last.date), y: .value("PnL", last.value))
                .symbolSize(40)
                .foregroundStyle(lineColor)
        }
    }

    private func tooltip(_ point: PnlPoint, date: Date) -> some View {
        VStack(spacing: 1) {
            if let micros = metric.micros(point) {
                LiveNumber(metric == .value ? Format.money(micros, currency) : Format.signedMoney(micros, currency)).font(.callout.weight(.medium))
            } else {
                Text("Unavailable").font(.callout.weight(.medium)).foregroundStyle(.secondary)
            }
            Text(Format.time(date)).monospacedDigit().foregroundStyle(.secondary)
            let excluded = metric.excludedCount(point)
            if excluded > 0 {
                Group {
                    if metric == .value {
                        Text("Leaves out ^[\(excluded) holding](inflect: true)")
                    } else {
                        Text("Leaves out \(excluded) unknown")
                    }
                }
                .monospacedDigit()
                .foregroundStyle(.secondary)
            }
        }
        .font(.caption)
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
    }

    static func gapOpacity(_ contrast: ColorSchemeContrast) -> Double {
        contrast == .increased ? 0.22 : 0.1
    }

    private static var overscan: CGFloat { 8 }
    private static var softEdge: CGFloat { 40 }

    /// From one transaction to the next it glides, quickly enough to feel attached to the pointer. Arriving and leaving are immediate, so the resting point never flies across to where the pointer is.
    private func hover(_ next: String?) {
        guard next != hoveredID else { return }
        withAnimation(hoveredID == nil || next == nil || reduceMotion ? nil : Motion.scrub) { hoveredID = next }
    }

    private func date(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Date? {
        guard let frame = proxy.plotFrame else { return nil }
        return proxy.value(atX: location.x - geometry[frame].origin.x, as: Date.self)
    }
}

/// The chart with what makes it readable at a glance: what it shows, how much that moved, over how long, and which stretch of history this is.
public struct PnlHistorySection: View {
    let portfolio: Portfolio
    let isLive: Bool
    @Binding var range: ChartRange
    @Binding var metric: ChartMetric
    let scrubbedIndex: Int?
    let onSelect: (String) -> Void
    @Environment(\.colorSchemeContrast) private var contrast

    public init(portfolio: Portfolio, isLive: Bool, range: Binding<ChartRange>, metric: Binding<ChartMetric>, scrubbedIndex: Int? = nil, onSelect: @escaping (String) -> Void) {
        self.portfolio = portfolio
        self.isLive = isLive
        _range = range
        _metric = metric
        self.scrubbedIndex = scrubbedIndex
        self.onSelect = onSelect
    }

    /// A range history has since stopped covering, as when switching wallets, falls back to all of it.
    private var shown: ChartRange {
        portfolio.availableChartRanges.contains(range) ? range : .all
    }

    private var window: ChartWindow { ChartWindow(points: portfolio.points, range: shown) }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if !portfolio.canChart(.value), !portfolio.canChart(.pnl) {
                placeholder(for: metric)
            } else {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .center) {
                        heading
                        Spacer(minLength: 12)
                        controls
                    }
                    VStack(alignment: .leading, spacing: 8) {
                        heading
                        controls
                    }
                }
                Group {
                    if portfolio.canChart(metric) {
                        DrawnPnlChart(wallet: portfolio.address, points: window.points, history: portfolio.points, currency: portfolio.currency, isLive: isLive, metric: metric, scrubbedIndex: scrubbedIndex, onSelect: onSelect)
                            .motion(Motion.chart, value: shown)
                            .frame(minHeight: 120, maxHeight: .infinity)
                    } else {
                        placeholder(for: metric)
                    }
                }
                // Another line, not this one moving: going from value to PnL isn't a change in either.
                .id("\(portfolio.address):\(metric.rawValue)")
                .transition(.opacity)
            }
        }
        .motion(Motion.state, value: metric)
    }

    private var heading: some View {
        VStack(alignment: .leading, spacing: 4) {
            metricPicker
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .monospacedDigit()
                .contentTransition(.opacity)
                .motion(Motion.state, value: shown)
                .help(subtitleHelp)
        }
    }

    private var subtitle: String {
        if let change = window.changeText(portfolio.currency, estimated: isPositive(portfolio.totals.estimatedMicros), metric: metric) { return change }
        // What the line ends on can be less than the value above it, so it says so.
        if metric == .value, let excluded = portfolio.points.last?.valueExcludedCount, excluded > 0 { return "Leaves out \(excluded) \(excluded == 1 ? "holding" : "holdings")" }
        return portfolio.historyLength
    }

    private var subtitleHelp: String {
        metric == .value && subtitle.hasPrefix("Leaves out") ? Wording.valueChartLeavesOut : portfolio.historyLength
    }

    /// The chart's title, as a choice, since the line under it says what it shows either way.
    private var metricPicker: some View {
        Picker("Chart", selection: $metric) {
            ForEach(ChartMetric.allCases) { Text($0.label).tag($0) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .help(metric == .value ? Wording.valueChartHelp : Wording.pnlHelp)
    }

    private var controls: some View {
        HStack(spacing: 14) {
            unknownKey
            rangePicker
        }
    }

    /// What the shaded stretches are, while one's in view. Too narrow a stretch has no room to say it inside.
    @ViewBuilder
    private var unknownKey: some View {
        if portfolio.canChart(metric), window.hasUnknown(metric) {
            HStack(spacing: 5) {
                // Upright like the band, and a little darker, since it's so much smaller. A square would look like a checkbox.
                Rectangle()
                    .fill(Color.secondary.opacity(PnlChartView.gapOpacity(contrast) * 2))
                    .frame(width: 7, height: 13)
                Text("\(metric.label) unknown")
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize()
            .help(metric == .value ? Wording.valueChartGap : Wording.chartGap)
            .transition(.opacity)
        }
    }

    /// Not there when there's nothing to choose between, since a lone segment that does nothing isn't a control.
    @ViewBuilder
    private var rangePicker: some View {
        let ranges = portfolio.availableChartRanges
        if ranges.count > 1 {
            Picker("Timeframe", selection: Binding(get: { shown }, set: { range = $0 })) {
                ForEach(ranges) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help(portfolio.historyLength)
        }
    }

    @ViewBuilder
    private func placeholder(for metric: ChartMetric) -> some View {
        if !portfolio.hasChartableData(metric) {
            placeholder(metric == .value ? "No value to chart yet" : "No PnL to chart yet")
                .help(metric == .value ? Wording.noValueToChart : Wording.nothingToChart)
        } else {
            placeholder("The chart starts after a few transactions")
                .help(portfolio.historyLength)
        }
    }

    private func placeholder(_ title: String) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.xyaxis.line").foregroundStyle(.tertiary)
            Text(title).foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .softBox(opacity: 0.35)
    }
}

/// Once per wallet, each time the app runs, the line draws in from the left: the first thing you see of how a wallet has done.
/// It uncovers the finished chart, so everything it shows is real, you can point at it while it goes, and it doesn't happen again on the way back to this page.
private struct DrawnPnlChart: View {
    let wallet: String
    let points: [PnlPoint]
    let history: [PnlPoint]
    let currency: CurrencyCode
    let isLive: Bool
    let metric: ChartMetric
    let scrubbedIndex: Int?
    let onSelect: (String) -> Void
    @State private var reveal: CGFloat
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @MainActor private static var drawn: Set<String> = []

    init(wallet: String, points: [PnlPoint], history: [PnlPoint], currency: CurrencyCode, isLive: Bool, metric: ChartMetric, scrubbedIndex: Int?, onSelect: @escaping (String) -> Void) {
        self.wallet = wallet
        self.points = points
        self.history = history
        self.currency = currency
        self.isLive = isLive
        self.metric = metric
        self.scrubbedIndex = scrubbedIndex
        self.onSelect = onSelect
        _reveal = State(initialValue: Motion.playsEntrances && !Self.drawn.contains(wallet) ? 0 : 1)
    }

    var body: some View {
        PnlChartView(points: points, history: history, currency: currency, isLive: isLive, metric: metric, reveal: reveal, scrubbedIndex: scrubbedIndex, onSelect: onSelect)
            .onAppear {
                Self.drawn.insert(wallet)
                guard reveal < 1 else { return }
                if reduceMotion {
                    reveal = 1
                } else {
                    withAnimation(Motion.drawIn) { reveal = 1 }
                }
            }
    }

    /// For a scene that plays this again.
    @MainActor static func forget() {
        drawn = []
    }
}

#if DEBUG
/// For the test mode's scene that plays the chart drawing in again.
@MainActor public func forgetDrawnCharts() {
    DrawnPnlChart.forget()
}
#endif
