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

/// A number that rolls to its new value and never changes width because of which digits it has.
public struct LiveNumber: View {
    let text: String
    let tone: Tone
    /// On a selected row's accent color, a tone would lose its contrast.
    @Environment(\.backgroundProminence) private var prominence

    public init(_ text: String, tone: Tone = .neutral) {
        self.text = text
        self.tone = tone
    }

    public var body: some View {
        Text(text)
            .monospacedDigit()
            .foregroundStyle(prominence == .increased ? Tone.neutral.style : tone.style)
            .contentTransition(.numericText())
            .animation(.snappy, value: text)
    }
}

/// A number you can click to read what's behind it. It looks like a number until you point at it.
public struct NumberButtonStyle: ButtonStyle {
    @State private var isHovered = false
    @Environment(\.isFocused) private var isFocused

    public init() {}

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.horizontal, 5)
            .padding(.vertical, 2)
            .background {
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(.primary.opacity(configuration.isPressed ? 0.14 : isHovered ? 0.07 : 0))
            }
            .padding(.horizontal, -5)
            .contentShape(Rectangle())
            .onHover { isHovered = $0 }
            .animation(.easeOut(duration: 0.12), value: isHovered)
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

    public init(_ kind: Kind, _ text: String) {
        self.kind = kind
        self.text = text
    }

    public var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Image(systemName: kind == .warning ? "exclamationmark.triangle.fill" : "info.circle")
                .foregroundStyle(kind == .warning ? Tone.warning.style : AnyShapeStyle(.secondary))
            Text(text)
                .foregroundStyle(kind == .warning ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(kind == .warning ? AnyShapeStyle(Color.orange.opacity(0.14)) : AnyShapeStyle(.quaternary.opacity(0.6)))
        }
    }
}

/// Says whether the numbers are current. Never says live unless the last read worked.
public struct FeedBadge: View {
    let feed: FeedState
    let portfolio: Portfolio?

    public init(feed: FeedState, portfolio: Portfolio?) {
        self.feed = feed
        self.portfolio = portfolio
    }

    private var text: String {
        switch feed {
        case .noWallet: return "No wallet"
        // With numbers on screen, they're the previous answer until the new one arrives.
        case .reading: return portfolio == nil ? "Reading" : "Updating"
        case .live:
            guard let portfolio else { return "Reading" }
            if portfolio.mode == .demo { return Mode.demo.label }
            return "Live"
        case .catchingUp: return "Catching up"
        default: return "Not updating"
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
            Circle().fill(color).frame(width: 7, height: 7)
            Text(text).monospacedDigit().contentTransition(.numericText()).animation(.snappy, value: text)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
        .help(portfolio.map { Wording.feedDetail($0.mode, block: $0.coverage.toBlock) } ?? "")
    }
}
