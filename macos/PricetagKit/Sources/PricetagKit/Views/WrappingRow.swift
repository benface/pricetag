import SwiftUI

/// Two things on one line while they both fit, and the second under the first once they don't. Unlike `ViewThatFits`, it keeps both and moves
/// the second, so the details opening beside it ease the change instead of jumping. Whatever's below moves with it.
public struct WrappingRow<Leading: View, Trailing: View>: View {
    let alignment: VerticalAlignment
    let spacing: CGFloat
    let lineSpacing: CGFloat
    /// Whether the second goes to the far end on one line, rather than right after the first.
    let fills: Bool
    let leading: Leading
    let trailing: Trailing
    @State private var wraps = false
    /// Both on one line, at their ideal sizes.
    @State private var natural: CGFloat?
    @State private var available: CGFloat?
    /// When it first knew both, to tell a change from it finding its size.
    @State private var firstDecided: ContinuousClock.Instant?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(alignment: VerticalAlignment = .lastTextBaseline, spacing: CGFloat, lineSpacing: CGFloat, fills: Bool = true, @ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
        self.alignment = alignment
        self.spacing = spacing
        self.lineSpacing = lineSpacing
        self.fills = fills
        self.leading = leading()
        self.trailing = trailing()
    }

    public var body: some View {
        WrapLayout(wrapped: wraps ? 1 : 0, alignment: alignment, spacing: spacing, lineSpacing: lineSpacing, fills: fills) {
            leading
            trailing
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
            available = $0
            decide()
        }
        .background {
            WrapLayout(wrapped: 0, alignment: alignment, spacing: spacing, lineSpacing: lineSpacing, fills: false) {
                leading
                trailing
            }
            .fixedSize()
            .hidden()
            .accessibilityHidden(true)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: {
                natural = $0
                decide()
            }
        }
    }

    private func decide() {
        guard let natural, let available else { return }
        // A point of slack, because the copy that measures and the row itself round a little differently.
        let next = natural > available + 1
        let firstDecided = firstDecided ?? .now
        self.firstDecided = firstDecided
        guard next != wraps else { return }
        // What happens while the window's still getting its size is how it starts, not a change.
        if ContinuousClock.now - firstDecided > .milliseconds(500) {
            withAnimation(reduceMotion ? nil : Motion.panel) { wraps = next }
        } else {
            wraps = next
        }
    }
}

/// The two places `WrappingRow` puts things, and every step between them. The step is animated here rather than as a change of layout,
/// because the details opening resize the page for a while after it starts, and each of those would cut a layout's own animation short.
private struct WrapLayout: Layout {
    /// 0 on one line, 1 wrapped.
    var wrapped: CGFloat
    var alignment: VerticalAlignment
    var spacing: CGFloat
    var lineSpacing: CGFloat
    var fills: Bool

    var animatableData: CGFloat {
        get { wrapped }
        set { wrapped = newValue }
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard subviews.count == 2 else { return .zero }
        let parts = measure(width: proposal.width.flatMap { $0.isFinite ? $0 : nil }, subviews: subviews)
        return CGSize(width: parts.width, height: lerp(parts.lineHeight, parts.first.height + lineSpacing + parts.second.height, by: down))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard subviews.count == 2 else { return }
        let parts = measure(width: bounds.width, subviews: subviews)
        let secondX = fills ? bounds.width - parts.second.width : parts.first.width + spacing
        subviews[0].place(at: CGPoint(x: bounds.minX, y: bounds.minY + lerp(parts.above - parts.firstGuide, 0, by: down)), proposal: ProposedViewSize(parts.first))
        subviews[1].place(
            at: CGPoint(x: bounds.minX + lerp(secondX, 0, by: across), y: bounds.minY + lerp(parts.above - parts.secondGuide, parts.first.height + lineSpacing, by: down)),
            proposal: ProposedViewSize(parts.second)
        )
    }

    /// The second goes down to its own line, then along it, so it never passes over the first. Coming back, it's the other way around.
    private var down: CGFloat { min(max(wrapped * 2, 0), 1) }
    private var across: CGFloat { min(max(wrapped * 2 - 1, 0), 1) }

    private func lerp(_ oneLine: CGFloat, _ wrapped: CGFloat, by progress: CGFloat) -> CGFloat {
        oneLine + (wrapped - oneLine) * progress
    }

    /// Each at its ideal width when there's room, so neither changes size as the second moves. The first gets the rest of the line when that's more.
    private func measure(width: CGFloat?, subviews: Subviews) -> (width: CGFloat, first: CGSize, second: CGSize, firstGuide: CGFloat, secondGuide: CGFloat, above: CGFloat, lineHeight: CGFloat) {
        let secondIdeal = subviews[1].sizeThatFits(.unspecified)
        let firstIdeal = subviews[0].sizeThatFits(.unspecified)
        let natural = firstIdeal.width + spacing + secondIdeal.width
        let second = subviews[1].sizeThatFits(ProposedViewSize(width: width.map { min($0, secondIdeal.width) }, height: nil))
        let firstWidth = width.map { min($0, max($0 - spacing - second.width, firstIdeal.width)) }
        let first = subviews[0].sizeThatFits(ProposedViewSize(width: firstWidth, height: nil))
        let firstGuide = subviews[0].dimensions(in: ProposedViewSize(first))[alignment]
        let secondGuide = subviews[1].dimensions(in: ProposedViewSize(second))[alignment]
        let above = max(firstGuide, secondGuide)
        let below = max(first.height - firstGuide, second.height - secondGuide)
        // All it's offered, so what it measures is the room it has. Ideally on one line, whatever it shows now.
        return (width ?? natural, first, second, firstGuide, secondGuide, above, above + below)
    }
}
