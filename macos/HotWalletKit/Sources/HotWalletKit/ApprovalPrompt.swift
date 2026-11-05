import Foundation
import LocalAuthentication
import Observation

/// What came of asking.
public enum ApprovalResult: Equatable, Sendable {
    case done
    /// Nobody said yes, and nothing happened. What was asked is still waiting.
    case cancelled
    case failed(String)
}

/// When Touch ID may be asked about what a window is showing, so it's asked with no click, but never about something unseen: not before
/// a strong warning's been acknowledged, not while the window isn't in front, and not right after the last answer, when a second touch
/// could approve something the user hasn't looked at.
@MainActor
@Observable
public final class ApprovalPrompt {
    public enum Phase: Equatable, Sendable {
        case needsAcknowledgment
        /// It's coming: the window has to be in front, and it gives the user a moment.
        case waiting
        case asking
        /// Touch ID said yes and it's on its way, which nothing can call back, so nothing should offer to.
        case working
        /// Nothing happened, and it won't ask again until told to. With what went wrong, if it was more than changing their mind.
        case stopped(String?)
        case done
    }

    public var phase: Phase {
        storedPhase == .asking && prompt.isConfirmed ? .working : storedPhase
    }

    public private(set) var prompt = PresencePrompt()
    private var storedPhase: Phase
    /// Whether the user can see this and it's what they're using. Until then, a click on the window is what starts it.
    public private(set) var isInFront = false

    /// Long enough to see what's opened, and for the view to pair with the prompt before it's asked.
    static let moment = Duration.milliseconds(400)

    @ObservationIgnored private var wasAcknowledged = false
    @ObservationIgnored private var wasInterrupted = false
    /// The prompt a view has paired with the system's. Asked before that, it would be a dialog over the details instead.
    @ObservationIgnored private weak var pairedPrompt: PresencePrompt?
    @ObservationIgnored private var isGone = false
    #if DEBUG
    @ObservationIgnored private var isScene = false
    #endif
    @ObservationIgnored private var pause: Task<Void, Never>?
    private let notBefore: () -> Date?
    private let now: () -> Date
    private let sleep: @Sendable (Duration) async throws -> Void
    private let perform: (_ prompt: PresencePrompt, _ acknowledged: Bool) async -> ApprovalResult

    public init(
        needsAcknowledgment: Bool = false,
        notBefore: @escaping () -> Date? = { nil },
        now: @escaping () -> Date = { Date() },
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        perform: @escaping (_ prompt: PresencePrompt, _ acknowledged: Bool) async -> ApprovalResult
    ) {
        storedPhase = needsAcknowledgment ? .needsAcknowledgment : .waiting
        self.notBefore = notBefore
        self.now = now
        self.sleep = sleep
        self.perform = perform
    }

    /// In front means the user can see it and it's what they're using. Going away stops an inline prompt, which comes back with the window.
    /// macOS's own dialog is left alone, because it's what took the window's place in front.
    public func windowChanged(isInFront: Bool) {
        guard isInFront != self.isInFront, !isGone else { return }
        self.isInFront = isInFront
        if isInFront {
            askAfterAMoment()
        } else {
            pause?.cancel()
            if phase == .asking, !prompt.isSystemDialog {
                wasInterrupted = true
                prompt.cancel()
            }
        }
    }

    /// The one extra step a strong warning takes.
    public func acknowledge() {
        guard phase == .needsAcknowledgment else { return }
        wasAcknowledged = true
        storedPhase = .waiting
        askAfterAMoment()
    }

    public func tryAgain() {
        guard case .stopped = phase else { return }
        storedPhase = .waiting
        askAfterAMoment()
    }

    /// The user chose to leave. It calls off the prompt here and now, before anything changes on screen, because the view going away comes
    /// later, and a touch landing in between would go through. False once Touch ID has said yes, when there's no leaving what's underway.
    @discardableResult
    public func backOut() -> Bool {
        guard phase != .working, phase != .done else { return false }
        stop()
        return true
    }

    /// A view holds the system's view for this prompt now. It only counts for the prompt that's current.
    public func promptPaired(_ paired: PresencePrompt) {
        guard paired === prompt, pairedPrompt !== paired else { return }
        pairedPrompt = paired
        askAfterAMoment()
    }

    /// Whether a view has this prompt paired yet.
    public var isPromptPaired: Bool { pairedPrompt === prompt }

    /// What's on show is going away, so nothing can be approved from here anymore.
    public func stop() {
        isGone = true
        pause?.cancel()
        prompt.cancel()
    }

    /// Whether the system's glyph is what's showing. It's only there once it's been asked.
    public var drawsSystemGlyph: Bool {
        #if DEBUG
        if isScene { return false }
        #endif
        return phase == .asking
    }

    private func askAfterAMoment() {
        pause?.cancel()
        guard phase == .waiting, isInFront, !isGone, isPromptPaired else { return }
        pause = Task {
            do {
                try await sleep(Self.moment)
                if let remaining = notBefore()?.timeIntervalSince(now()), remaining > 0 { try await sleep(.seconds(remaining)) }
            } catch {
                return
            }
            guard !Task.isCancelled, phase == .waiting, isInFront, !isGone, isPromptPaired else { return }
            storedPhase = .asking
            // Outside this task, which going away cancels. Only the prompt's own cancel should stop what's been asked.
            Task { await ask() }
        }
    }

    private func ask() async {
        let result = await perform(prompt, wasAcknowledged)
        let interrupted = wasInterrupted
        wasInterrupted = false
        guard result != .done else {
            storedPhase = .done
            return
        }
        // Never the same one twice.
        prompt = PresencePrompt()
        switch result {
        case .done:
            break
        case .cancelled where interrupted:
            storedPhase = .waiting
            askAfterAMoment()
        case .cancelled:
            storedPhase = .stopped(nil)
        case .failed(let reason):
            storedPhase = .stopped(reason)
        }
    }
}

#if DEBUG
extension ApprovalPrompt {
    /// For `macos/shot.sh`. It stays as it is and never asks.
    public static func scene(_ phase: Phase, isInFront: Bool = true) -> ApprovalPrompt {
        let scene = ApprovalPrompt { _, _ in .cancelled }
        scene.storedPhase = phase
        scene.isInFront = isInFront
        scene.isGone = true
        scene.isScene = true
        return scene
    }

    /// The same as an interruption does to the prompt, for the scene that checks the view follows it.
    public func sceneReplacePrompt() {
        prompt = PresencePrompt()
    }
}
#endif
