import Charts
import SwiftUI

/// Total PnL after each transaction. It holds still between them, so it's drawn as steps. Click a step for its transaction.
public struct PnlChartView: View {
    let points: [PnlPoint]
    let isLive: Bool
    let onSelect: (String) -> Void
    @State private var hovered: Plotted?

    private struct Plotted: Identifiable, Equatable {
        let point: PnlPoint
        let date: Date
        let value: Double
        var id: String { point.id }
    }

    public init(points: [PnlPoint], isLive: Bool, onSelect: @escaping (String) -> Void) {
        self.points = points
        self.isLive = isLive
        self.onSelect = onSelect
    }

    private var plotted: [Plotted] {
        points.compactMap { point in
            point.date.map { Plotted(point: point, date: $0, value: Format.chartValue(point.pnlUsdMicros)) }
        }
    }

    private var lineStyle: AnyShapeStyle {
        // A Color, because a chart reads the plain `.secondary` style as a shade of its accent.
        guard isLive else { return AnyShapeStyle(Color.secondary) }
        return Tone(signed: points.last?.pnlUsdMicros).style
    }

    private func nearest(to date: Date) -> Plotted? {
        plotted.filter { $0.point.txHash != nil }.min { abs($0.date.timeIntervalSince(date)) < abs($1.date.timeIntervalSince(date)) }
    }

    public var body: some View {
        let plotted = plotted
        Chart {
            RuleMark(y: .value("Zero", 0))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .foregroundStyle(.tertiary)
            ForEach(plotted) { item in
                LineMark(x: .value("Time", item.date), y: .value("PnL", item.value))
                    .interpolationMethod(.stepEnd)
                    .foregroundStyle(lineStyle)
            }
            if let hovered {
                RuleMark(x: .value("Time", hovered.date)).foregroundStyle(.tertiary)
                PointMark(x: .value("Time", hovered.date), y: .value("PnL", hovered.value))
                    .foregroundStyle(lineStyle)
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        VStack(spacing: 1) {
                            Text(Format.signedUSD(hovered.point.pnlUsdMicros)).monospacedDigit().fontWeight(.medium)
                            Text(Format.time(hovered.date)).foregroundStyle(.secondary)
                            if hovered.point.excludedCount > 0 {
                                Text("Leaves out \(hovered.point.excludedCount) unknown").foregroundStyle(Tone.warning.style)
                            }
                        }
                        .font(.caption)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                    }
            }
        }
        .chartYAxis {
            AxisMarks(position: .trailing) { value in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel {
                    if let amount = value.as(Double.self) {
                        // Formatted first: `Text(_:format:)` would swap in the system's locale, and print US$ in Canada.
                        Text(amount.formatted(.currency(code: "USD").locale(Locale(identifier: "en_US")).notation(.compactName).precision(.fractionLength(0...2)))).monospacedDigit()
                    }
                }
            }
        }
        .chartXAxis {
            AxisMarks { _ in
                AxisGridLine().foregroundStyle(.quaternary)
                AxisValueLabel(format: .dateTime.hour().minute())
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
                            hovered = date(at: location, proxy: proxy, geometry: geometry).flatMap(nearest)
                        case .ended:
                            hovered = nil
                        }
                    }
                    .onTapGesture { location in
                        if let hash = date(at: location, proxy: proxy, geometry: geometry).flatMap(nearest)?.point.txHash {
                            onSelect(hash)
                        }
                    }
            }
        }
        .opacity(isLive ? 1 : 0.6)
        .accessibilityLabel("Total PnL over time, ending at \(points.last.map { Format.signedUSD($0.pnlUsdMicros) } ?? "nothing")")
    }

    private func date(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Date? {
        guard let frame = proxy.plotFrame else { return nil }
        return proxy.value(atX: location.x - geometry[frame].origin.x, as: Date.self)
    }
}
