import Foundation
import LocalAuthentication
import Testing
@testable import HotWalletKit

/// Everything that's asked, and what to answer. Every ask is a prompt the view could be showing.
@MainActor
private final class Asked {
    var prompts: [PresencePrompt] = []
    var acknowledged: [Bool] = []
    var answers: [ApprovalResult] = []
    /// The next ask waits here, like a person looking at Touch ID.
    var holding: CheckedContinuation<Void, Never>?
    var holds = false

    func answer(_ prompt: PresencePrompt, _ acknowledged: Bool) async -> ApprovalResult {
        prompts.append(prompt)
        self.acknowledged.append(acknowledged)
        if holds { await withCheckedContinuation { holding = $0 } }
        return answers.isEmpty ? .cancelled : answers.removeFirst()
    }

    func release() {
        holding?.resume()
        holding = nil
    }
}

/// Lets a pause finish at once, and remembers how long it was asked to be.
private final class Pauses: @unchecked Sendable {
    private let lock = NSLock()
    private var durations: [Duration] = []

    var all: [Duration] { lock.withLock { durations } }

    func record(_ duration: Duration) {
        lock.withLock { durations.append(duration) }
    }
}

@MainActor
private func settle(until condition: () -> Bool = { false }) async {
    for _ in 0..<200 where !condition() {
        await Task.yield()
    }
}

@MainActor
struct ApprovalPromptTests {
    private func gate(_ asked: Asked, needsAcknowledgment: Bool = false, notBefore: Date? = nil, pauses: Pauses = Pauses(), now: Date = Date()) -> ApprovalPrompt {
        let gate = ApprovalPrompt(needsAcknowledgment: needsAcknowledgment, notBefore: { notBefore }, now: { now }, sleep: { pauses.record($0) }, perform: asked.answer)
        gate.promptPaired(gate.prompt)
        return gate
    }

    @Test func itAsksByItselfOnceTheWindowIsInFront() async {
        let asked = Asked()
        asked.answers = [.done]
        let gate = gate(asked)
        await settle()
        #expect(asked.prompts.isEmpty, "not while nothing's been seen")
        #expect(gate.phase == .waiting)
        gate.windowChanged(isInFront: true)
        await settle { gate.phase == .done }
        #expect(asked.prompts.count == 1)
        #expect(gate.phase == .done)
    }

    @Test func noPromptAppearsBeforeAStrongWarningIsAcknowledged() async {
        let asked = Asked()
        asked.answers = [.done]
        let gate = gate(asked, needsAcknowledgment: true)
        gate.windowChanged(isInFront: true)
        await settle()
        #expect(asked.prompts.isEmpty)
        #expect(gate.phase == .needsAcknowledgment)
        gate.acknowledge()
        await settle { gate.phase == .done }
        #expect(asked.acknowledged == [true])
    }

    @Test func aWarningAcknowledgedWithTheWindowAwayStillWaitsForIt() async {
        let asked = Asked()
        let gate = gate(asked, needsAcknowledgment: true)
        gate.acknowledge()
        await settle()
        #expect(asked.prompts.isEmpty)
    }

    @Test func aCancelledPromptLeavesItWaitingUntilAskedAgainWithANewPrompt() async {
        let asked = Asked()
        asked.answers = [.cancelled, .done]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { gate.phase == .stopped(nil) }
        #expect(gate.phase == .stopped(nil))
        await settle()
        #expect(asked.prompts.count == 1, "it doesn't keep asking by itself")
        gate.tryAgain()
        gate.promptPaired(gate.prompt)
        await settle { gate.phase == .done }
        #expect(asked.prompts.count == 2)
        #expect(asked.prompts[0] !== asked.prompts[1], "no context is used twice")
    }

    @Test func aFailureSaysWhyAndCanBeTriedAgain() async {
        let asked = Asked()
        asked.answers = [.failed("No.")]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { gate.phase == .stopped("No.") }
        #expect(gate.phase == .stopped("No."))
    }

    @Test func itWaitsOutThePauseAfterTheLastAnswerSoARepeatedTouchCantApproveThis() async {
        let asked = Asked()
        asked.answers = [.done]
        let pauses = Pauses()
        let now = Date()
        let gate = gate(asked, notBefore: now.addingTimeInterval(2), pauses: pauses, now: now)
        gate.windowChanged(isInFront: true)
        await settle { gate.phase == .done }
        #expect(pauses.all == [ApprovalPrompt.moment, .seconds(2)])
    }

    @Test func leavingStopsAnInlinePromptAndComingBackAsksAgain() async {
        let asked = Asked()
        asked.holds = true
        asked.answers = [.cancelled, .done]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { !asked.prompts.isEmpty && asked.holding != nil }
        let first = asked.prompts[0]
        gate.windowChanged(isInFront: false)
        #expect(first.isCancelled)
        asked.holds = false
        asked.release()
        await settle { gate.phase == .waiting }
        #expect(gate.phase == .waiting, "it's not the user who cancelled, so there's nothing to try again")
        await settle()
        #expect(asked.prompts.count == 1, "nothing's asked while the window's away")
        gate.windowChanged(isInFront: true)
        await settle()
        #expect(asked.prompts.count == 1, "nor before the view has the new prompt")
        gate.promptPaired(first)
        await settle()
        #expect(asked.prompts.count == 1, "what the old prompt's view says doesn't count")
        #expect(!gate.isPromptPaired)
        gate.promptPaired(gate.prompt)
        await settle { gate.phase == .done }
        #expect(asked.prompts.count == 2)
        #expect(asked.prompts[1] !== first)
    }

    @Test func itDoesntAskUntilAViewHasThePromptPaired() async {
        let asked = Asked()
        let gate = ApprovalPrompt(sleep: { _ in }, perform: asked.answer)
        gate.windowChanged(isInFront: true)
        await settle()
        #expect(asked.prompts.isEmpty, "it would be a dialog over the details")
        gate.promptPaired(gate.prompt)
        await settle { !asked.prompts.isEmpty }
        #expect(asked.prompts.count == 1)
    }

    @Test func onceTouchIDSaysYesItsWorkingAndCantBeInterrupted() async {
        let asked = Asked()
        asked.holds = true
        asked.answers = [.done]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { asked.holding != nil }
        #expect(gate.phase == .asking)
        asked.prompts[0].markConfirmed()
        #expect(gate.phase == .working)
        gate.windowChanged(isInFront: false)
        #expect(!asked.prompts[0].isCancelled, "what's underway isn't what's being asked")
        asked.release()
        await settle { gate.phase == .done }
        #expect(gate.phase == .done)
    }

    @Test func aFailureAfterTheTouchComesBackToAFreshPrompt() async {
        let asked = Asked()
        asked.holds = true
        asked.answers = [.failed("Fees rose.")]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { asked.holding != nil }
        asked.prompts[0].markConfirmed()
        asked.release()
        await settle { gate.phase == .stopped("Fees rose.") }
        #expect(gate.phase == .stopped("Fees rose."))
        #expect(!gate.prompt.isConfirmed, "the next try takes its own touch")
    }

    @Test func macOSsOwnDialogTakingTheWindowsPlaceDoesntStopIt() async {
        let asked = Asked()
        asked.holds = true
        asked.answers = [.done]
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { asked.holding != nil }
        _ = asked.prompts[0].switchToSystemDialog()
        gate.windowChanged(isInFront: false)
        #expect(!asked.prompts[0].isCancelled)
        asked.release()
        await settle { gate.phase == .done }
        #expect(gate.phase == .done)
    }

    @Test func itKnowsWhenItsWindowIsAway() {
        let gate = gate(Asked())
        #expect(!gate.isInFront)
        gate.windowChanged(isInFront: true)
        #expect(gate.isInFront)
        gate.windowChanged(isInFront: false)
        #expect(!gate.isInFront)
    }

    @Test func nothingIsAskedOnceItsGone() async {
        let asked = Asked()
        let gate = gate(asked)
        gate.stop()
        gate.windowChanged(isInFront: true)
        await settle()
        #expect(asked.prompts.isEmpty)
    }

    @Test func goingAwayCancelsThePromptThatsAsking() async {
        let asked = Asked()
        asked.holds = true
        let gate = gate(asked)
        gate.windowChanged(isInFront: true)
        await settle { asked.holding != nil }
        gate.stop()
        #expect(asked.prompts[0].isCancelled)
        asked.release()
    }
}
