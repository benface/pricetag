import SwiftUI

public enum Tone {
    case neutral, secondary, gain, loss, warning

    /// A tone for a signed amount. nil means it's unknown.
    public init(signed micros: String?) {
        guard let micros else {
            self = .warning
            return
        }
        self = micros.hasPrefix("-") ? .loss : isPositive(micros) ? .gain : .neutral
    }

    public var style: AnyShapeStyle {
        switch self {
        case .neutral: AnyShapeStyle(.primary)
        case .secondary: AnyShapeStyle(.secondary)
        case .gain, .loss, .warning: AnyShapeStyle(color)
        }
    }

    /// With Increase Contrast on, the color stays but moves closer to the text's.
    func style(_ contrast: ColorSchemeContrast) -> AnyShapeStyle {
        guard contrast == .increased else { return style }
        return switch self {
        case .neutral, .secondary: style
        case .gain, .loss, .warning: AnyShapeStyle(color.mix(with: .primary, by: 0.25))
        }
    }

    var color: Color {
        switch self {
        case .neutral: .primary
        case .secondary: .secondary
        // Mixed with the text color, so they hold enough contrast in both light and dark.
        case .gain: Color.green.mix(with: .primary, by: 0.2)
        case .loss: Color.red.mix(with: .primary, by: 0.1)
        case .warning: Color.orange.mix(with: .primary, by: 0.15)
        }
    }
}

/// A number that rolls to its new value and never changes width because of which digits it has. It rolls up when the number went up,
/// and what it lands on is exactly what it's given. Words like "Unknown" aren't numbers, so they cross-fade.
public struct LiveNumber: View {
    let styled: AttributedString
    let text: String
    let tone: Tone
    /// On a selected row's accent color, a tone would lose its contrast.
    @Environment(\.backgroundProminence) private var prominence
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorSchemeContrast) private var contrast

    public init(_ text: String, tone: Tone = .neutral) {
        self.init(AttributedString(text), plain: text, tone: tone)
    }

    init(_ styled: AttributedString, plain: String, tone: Tone) {
        self.styled = styled
        text = plain
        self.tone = tone
    }

    private var transition: ContentTransition {
        if reduceMotion { return .opacity }
        return Format.direction(of: text).map { .numericText(value: $0) } ?? .opacity
    }

    public var body: some View {
        Text(styled)
            .monospacedDigit()
            .foregroundStyle(prominence == .increased ? Tone.neutral.style : tone.style(contrast))
            .contentTransition(transition)
            .animation(Motion.number, value: text)
    }
}

extension EnvironmentValues {
    /// Set while a read runs and the numbers on screen may change once it's done, to what a mark beside them says. See `updatingMark`.
    @Entry public var updatingNote: String?
}

extension PortfolioStore {
    /// nil unless there are numbers on screen that this read may change.
    public var updatingNote: String? {
        guard feed == .reading, let portfolio else { return nil }
        return Wording.updating(lastUpdate: portfolio.latest.date.map(Format.time) ?? portfolio.latest.timestamp)
    }
}

extension View {
    /// A small spinner just outside this edge while `updatingNote` is set. It's outside the layout, so nothing moves when it comes or goes.
    public func updatingMark(_ edge: HorizontalEdge = .leading) -> some View {
        overlay(alignment: edge == .leading ? .leading : .trailing) {
            UpdatingMark()
                .alignmentGuide(edge == .leading ? .leading : .trailing) { edge == .leading ? $0[.trailing] + 5 : $0[.leading] - 5 }
        }
    }
}

private struct UpdatingMark: View {
    @Environment(\.updatingNote) private var note

    /// It fades, whatever Reduce Motion says, because nothing moves. The numbers it sits beside don't animate with it.
    var body: some View {
        ZStack {
            if let note {
                ProgressView()
                    .controlSize(.mini)
                    .help(note)
                    .accessibilityLabel("Updating")
                    .transition(.opacity)
            }
        }
        .animation(Motion.state, value: note != nil)
    }
}

/// A number you can click to read what's behind it. It looks like a number until you point at it.
public struct NumberButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background(PointedAt(isPressed: configuration.isPressed, cornerRadius: 5))
            .padding(.horizontal, -5)
            .contentShape(Rectangle())
    }
}

/// A row in a list you can click. `isHighlighted` is for whatever else can pick it out, like the arrow keys.
public struct RowButtonStyle: ButtonStyle {
    let isHighlighted: Bool

    public init(isHighlighted: Bool = false) {
        self.isHighlighted = isHighlighted
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(PointedAt(isPressed: configuration.isPressed, isHighlighted: isHighlighted, cornerRadius: 6))
            .contentShape(Rectangle())
    }
}

/// The wash behind something clickable that doesn't look like a button until you point at it: on hover, and darker while pressed.
private struct PointedAt: View {
    let isPressed: Bool
    var isHighlighted = false
    let cornerRadius: CGFloat
    @State private var isHovered = false
    @Environment(\.colorSchemeContrast) private var contrast

    private var strength: Double {
        let base = isPressed ? 0.14 : isHovered || isHighlighted ? 0.07 : 0
        return contrast == .increased ? base * 2 : base
    }

    var body: some View {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(.primary.opacity(strength))
            .onHover { isHovered = $0 }
            // Right away on the way in, because it's answering a press.
            .animation(isPressed ? nil : Motion.feedback, value: strength)
    }
}

/// A button in its own solid colors, for the alarm's red, where a tint fades into the banner when the window isn't in front. An alarm usually finds it that way.
public struct AlarmButtonStyle: ButtonStyle {
    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .fontWeight(.semibold)
            .foregroundStyle(.black)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .background(.white.opacity(configuration.isPressed ? 0.75 : 1), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .contentShape(Rectangle())
    }
}

/// The soft box behind a note. With Increase Contrast on, it also gets an edge, because the fill alone can disappear.
extension View {
    public func softBox(cornerRadius: CGFloat = 10, opacity: Double = 0.5) -> some View {
        modifier(SoftBox(cornerRadius: cornerRadius, opacity: opacity))
    }
}

private struct SoftBox: ViewModifier {
    let cornerRadius: CGFloat
    let opacity: Double
    @Environment(\.colorSchemeContrast) private var contrast

    func body(content: Content) -> some View {
        content
            .background(.quaternary.opacity(opacity), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
            .overlay {
                if contrast == .increased {
                    RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(.secondary, lineWidth: 1)
                }
            }
    }
}

/// A warning triangle before text, so an unknown can't be mistaken for an answer.
public struct WarningText: View {
    let text: String

    public init(_ text: String) {
        self.text = text
    }

    public var body: some View {
        Label {
            Text(text)
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
        }
        .foregroundStyle(Tone.warning.style)
    }
}

public struct Notice: View {
    public enum Kind {
        case info, warning
    }

    let kind: Kind
    let text: String
    let detail: String?
    let actionTitle: String?
    let action: () -> Void
    @Environment(\.colorSchemeContrast) private var contrast

    /// `detail` is the technical side, behind a Details button.
    public init(_ kind: Kind, _ text: String, detail: String? = nil, actionTitle: String? = nil, action: @escaping () -> Void = {}) {
        self.kind = kind
        self.text = text
        self.detail = detail
        self.actionTitle = actionTitle
        self.action = action
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: kind == .warning ? "exclamationmark.triangle.fill" : "info.circle")
                .foregroundStyle(kind == .warning ? Tone.warning.style : AnyShapeStyle(.secondary))
            VStack(alignment: .leading, spacing: 7) {
                Text(text)
                    .foregroundStyle(kind == .warning ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .fixedSize(horizontal: false, vertical: true)
                if actionTitle != nil || detail != nil {
                    HStack(spacing: 12) {
                        if let actionTitle {
                            Button(actionTitle, action: action)
                        }
                        if let detail {
                            DetailsButton(detail: detail)
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(kind == .warning ? AnyShapeStyle(Color.orange.opacity(0.14)) : AnyShapeStyle(.quaternary.opacity(0.6)))
        }
        .overlay {
            if contrast == .increased {
                RoundedRectangle(cornerRadius: 9, style: .continuous).strokeBorder(kind == .warning ? Tone.warning.style : AnyShapeStyle(.secondary), lineWidth: 1)
            }
        }
    }
}

/// The technical side of a problem, for whoever wants it, without putting it in front of everyone else.
public struct DetailsButton: View {
    let detail: String
    @State private var isShown = false

    public init(detail: String) {
        self.detail = detail
    }

    public var body: some View {
        Button("Details") { isShown.toggle() }
            #if os(macOS)
            .buttonStyle(.link)
            #else
            .buttonStyle(.borderless)
            #endif
            .popover(isPresented: $isShown) {
                Text(detail)
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(width: 280, alignment: .leading)
                    .padding(12)
            }
    }
}

/// Redraws every second from `since`, so a read that's taking a while visibly keeps going. Its content gets the whole seconds so far.
public struct ReadingClock<Content: View>: View {
    let since: Date
    let content: (Int) -> Content

    public init(since: Date, @ViewBuilder content: @escaping (Int) -> Content) {
        self.since = since
        self.content = content
    }

    public var body: some View {
        TimelineView(.periodic(from: since, by: 1)) { context in
            content(Int(context.date.timeIntervalSince(since)))
        }
    }
}

/// Says whether the numbers are current. Never says live unless the last read worked.
public struct FeedBadge: View {
    let feed: FeedState
    let portfolio: Portfolio?
    let readingSince: Date?

    public init(feed: FeedState, portfolio: Portfolio?, readingSince: Date? = nil) {
        self.feed = feed
        self.portfolio = portfolio
        self.readingSince = readingSince
    }

    private func text(seconds: Int?) -> String {
        switch feed {
        case .noWallet: return "No wallet"
        // With numbers on screen, they're the previous answer until the new one arrives.
        case .reading:
            let label = portfolio == nil ? "Reading" : "Updating"
            guard let seconds, seconds >= FeedState.longReadSeconds else { return label }
            return "\(label) · \(Format.elapsed(seconds: seconds))"
        case .live:
            guard let portfolio else { return "Reading" }
            if portfolio.mode == .demo { return Mode.demo.label }
            return "Live"
        case .catchingUp: return "Catching up"
        default:
            // A retry that's taking a while may be about to work, so it says it's trying rather than only that it's stopped.
            guard let seconds, seconds >= FeedState.longReadSeconds else { return "Not updating" }
            return "Trying again · \(Format.elapsed(seconds: seconds))"
        }
    }

    private var color: Color {
        switch feed {
        case .noWallet, .reading: .secondary
        case .live: portfolio?.mode == .demo ? .secondary : .green
        default: .orange
        }
    }

    public var body: some View {
        HStack(spacing: 5) {
            Circle().fill(color).frame(width: 7, height: 7).animation(Motion.state, value: color)
            if let readingSince, feed == .reading || feed.isStale {
                ReadingClock(since: readingSince) { label(text(seconds: $0)) }
            } else {
                label(text(seconds: nil))
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .help(portfolio.map { Wording.feedDetail($0.mode, block: $0.coverage.toBlock) } ?? "")
    }

    /// A count that ticks rolls its digits. Anything else fades from one state to the next.
    private func label(_ text: String) -> some View {
        Text(text).monospacedDigit().contentTransition(readingSince != nil ? .numericText() : .opacity).animation(Motion.state, value: text)
    }
}
