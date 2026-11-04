import Charts
import SwiftUI

/// Total PnL after each transaction. It holds still between them, so it's drawn as steps. Click a step for its transaction.
/// The line stops where nothing is known. The same transactions are in `TransactionsTable`, for the keyboard and VoiceOver.
public struct PnlChartView: View {
    let points: [PnlPoint]
    let isLive: Bool
    let onSelect: (String) -> Void
    @State private var hovered: PnlSeries.Plotted?

    public init(points: [PnlPoint], isLive: Bool, onSelect: @escaping (String) -> Void) {
        self.points = points
        self.isLive = isLive
        self.onSelect = onSelect
    }

    private var lineStyle: AnyShapeStyle {
        let tone = Tone(signed: points.last { $0.pnlMicros != nil }?.pnlMicros)
        // A Color, because a chart reads plain styles like `.secondary` as shades of its accent.
        return isLive && tone != .neutral ? tone.style : AnyShapeStyle(Color.secondary)
    }

    public var body: some View {
        let series = PnlSeries(points: points)
        Chart {
            ForEach(Array(series.gaps.enumerated()), id: \.offset) { _, gap in
                RectangleMark(xStart: .value("Unknown from", gap.lowerBound), xEnd: .value("Unknown to", gap.upperBound))
                    .foregroundStyle(Color.orange.opacity(0.1))
            }
            RuleMark(y: .value("Zero", 0))
                .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                .foregroundStyle(.tertiary)
            ForEach(Array(series.segments.enumerated()), id: \.offset) { index, segment in
                ForEach(segment) { step in
                    LineMark(x: .value("Time", step.date), y: .value("PnL", step.value), series: .value("Segment", index))
                        .interpolationMethod(.stepEnd)
                        .foregroundStyle(lineStyle)
                }
            }
            if let hovered {
                RuleMark(x: .value("Time", hovered.date)).foregroundStyle(.tertiary)
                PointMark(x: .value("Time", hovered.date), y: .value("PnL", hovered.value ?? 0))
                    // Only there to carry the tooltip when the value is unknown, not to mark a place on the axis.
                    .foregroundStyle(hovered.value == nil ? AnyShapeStyle(Color.clear) : lineStyle)
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .fit(to: .chart))) {
                        VStack(spacing: 1) {
                            if let pnl = hovered.point.pnlMicros {
                                Text(Format.signedUSD(pnl)).monospacedDigit().fontWeight(.medium)
                            } else {
                                WarningText("Unavailable").fontWeight(.medium)
                            }
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
                            hovered = date(at: location, proxy: proxy, geometry: geometry).flatMap(series.nearestTransaction)
                        case .ended:
                            hovered = nil
                        }
                    }
                    .onTapGesture { location in
                        if let hash = date(at: location, proxy: proxy, geometry: geometry).flatMap(series.nearestTransaction)?.point.txHash {
                            onSelect(hash)
                        }
                    }
            }
        }
        .opacity(isLive ? 1 : 0.6)
        .accessibilityLabel("Total PnL over time, ending at \(points.last?.pnlMicros.map(Format.signedUSD) ?? "unavailable")")
    }

    private func date(at location: CGPoint, proxy: ChartProxy, geometry: GeometryProxy) -> Date? {
        guard let frame = proxy.plotFrame else { return nil }
        return proxy.value(atX: location.x - geometry[frame].origin.x, as: Date.self)
    }
}
