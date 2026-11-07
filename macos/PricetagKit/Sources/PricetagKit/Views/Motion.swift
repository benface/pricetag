import SwiftUI

/// How things move, in one place. All of it is short, so nothing waits for it, and a new change takes over from wherever the old one got to.
public enum Motion {
    /// Pointing at or pressing something. Only a color changes, so this stays with Reduce Motion on.
    public static var feedback: Animation { paced(.easeOut(duration: 0.12)) }
    /// A number rolling to its new value. It lands on the exact one.
    public static var number: Animation { paced(.snappy(duration: 0.32)) }
    /// The chart's pointer going from one transaction to the next.
    public static var scrub: Animation { paced(.snappy(duration: 0.14)) }
    /// Something appearing, leaving or changing state.
    public static var state: Animation { paced(.snappy(duration: 0.24)) }
    /// A pane opening or closing.
    public static var panel: Animation { paced(.snappy(duration: 0.3)) }
    /// The chart going from one timeframe to another.
    public static var chart: Animation { paced(.snappy(duration: 0.42)) }
    /// The chart's line drawing in, the first time a wallet's is seen.
    public static var drawIn: Animation { paced(.timingCurve(0.3, 0, 0.2, 1, duration: 0.85)) }
    /// How long a cost that just became known stays lit. It fades on its own from there.
    public static var highlight: Duration { .seconds(1.6 * slowdown) }
    /// How long "Copied" stays, and how long a finished send stays before its sheet closes.
    public static var acknowledged: Duration { .seconds(1.3 * slowdown) }

    #if DEBUG
    /// So `shot.sh --frames` can catch what's over too quickly to capture. Never set outside the test mode.
    public nonisolated(unsafe) static var slowdown = 1.0
    /// Whether anything plays just because it appeared. A render takes one frame, and that one should be the finished view.
    public nonisolated(unsafe) static var playsEntrances = true
    #else
    public static let slowdown = 1.0
    public static let playsEntrances = true
    #endif

    private static func paced(_ animation: Animation) -> Animation {
        slowdown == 1 ? animation : animation.speed(1 / slowdown)
    }
}

extension View {
    /// `animation(_:value:)` that goes still with Reduce Motion on.
    public func motion(_ animation: Animation, value: some Equatable) -> some View {
        modifier(MotionModifier(animation: animation, value: value))
    }

    /// How something arrives and leaves: it fades, and moves a little unless Reduce Motion is on.
    public func arrives(from edge: Edge = .top) -> some View {
        modifier(ArrivalModifier(edge: edge))
    }

    /// Lit softly while `isOn`, coming up quickly and fading slowly. Only a color changes, so this stays with Reduce Motion on.
    public func flash(_ isOn: Bool, _ look: FlashLook) -> some View {
        background {
            RoundedRectangle(cornerRadius: look.cornerRadius, style: .continuous)
                .fill(look.color)
                .opacity(isOn ? look.opacity : 0)
                .padding(.horizontal, -look.margin.width)
                .padding(.vertical, -look.margin.height)
                .animation(isOn ? Motion.feedback : .easeOut(duration: 0.8 * Motion.slowdown), value: isOn)
        }
    }

    /// Ends a flash. Whenever `trigger` changes to something other than `rest`, this waits, then calls `end`, which should put it back.
    /// What's lit is whoever holds the trigger's to say, since it can be many rows at once.
    public func flash<Trigger: Equatable>(trigger: Trigger, rest: Trigger, for duration: Duration = Motion.highlight, end: @escaping @MainActor () -> Void) -> some View {
        task(id: trigger) {
            guard trigger != rest else { return }
            try? await Task.sleep(for: duration)
            if !Task.isCancelled { end() }
        }
    }
}

/// What a flash says.
public enum FlashLook {
    /// A cost that's just become known. The number's already what's real by then.
    case known
    /// Something new in a list, like what was just sent, so the eye finds it.
    case added
    /// What a notification opened, in the system's selection color, so it's found at a glance.
    case found

    fileprivate var color: Color { self == .known ? Tone.gain.color : .accentColor }

    fileprivate var opacity: Double {
        switch self {
        case .known: 0.2
        case .added: 0.12
        case .found: 0.18
        }
    }

    fileprivate var cornerRadius: CGFloat { self == .found ? 6 : 5 }
    fileprivate var margin: CGSize { self == .found ? CGSize(width: 6, height: 4) : CGSize(width: 5, height: 2) }
}

private struct MotionModifier<Value: Equatable>: ViewModifier {
    let animation: Animation
    let value: Value
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.animation(reduceMotion ? nil : animation, value: value)
    }
}

private struct ArrivalModifier: ViewModifier {
    let edge: Edge
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(edge == .top ? CGSize(width: 0, height: -6) : CGSize(width: 0, height: 6))))
    }
}
