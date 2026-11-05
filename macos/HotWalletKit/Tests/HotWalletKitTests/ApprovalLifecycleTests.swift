#if os(macOS)
import AppKit
import Foundation
import Observation
import PricetagKit
import SwiftUI
import Testing
@testable import HotWalletKit

/// Runs what the user did just before the prompt's answer arrives. Nothing here cancels anything for them.
private final class LeavesThenTouches: UserPresence, @unchecked Sendable {
    nonisolated(unsafe) var leave: @MainActor () -> Void = {}

    func confirm(reason: String) async throws {}

    /// SwiftUI runs `onDisappear` on a later update, so the answer can arrive first.
    @MainActor func confirm(reason: String, in prompt: PresencePrompt) async throws {
        leave()
    }
}

@MainActor
@Observable
private final class Visibility {
    var isShown = true
}

/// What the sheets do: a branch that goes away after the action, whose disappearing stops the prompt. Nothing's shown, and nothing asks for Touch ID.
private struct Lifecycle: View {
    let isShown: () -> Bool
    let appeared: () -> Void
    let disappeared: () -> Void

    var body: some View {
        if isShown() {
            Text("Confirming").onAppear(perform: appeared).onDisappear(perform: disappeared)
        } else {
            Text("Gone")
        }
    }
}

/// Leaving a confirmation has to hold on its own, in the gap before SwiftUI gets round to taking the view away.
@MainActor
@Suite(.serialized)
struct ApprovalLifecycleTests {
    private func run(gate: ApprovalPrompt, rig: Rig, isShown: @escaping () -> Bool) async throws {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 460, height: 200), styleMask: .borderless, backing: .buffered, defer: true)
        window.isReleasedWhenClosed = false
        defer { window.close() }
        var appeared = false
        var disappeared = false
        window.contentViewController = NSHostingController(rootView: Lifecycle(isShown: isShown, appeared: { appeared = true }, disappeared: {
            disappeared = true
            gate.stop()
        }))
        for _ in 0..<1000 where !appeared {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(appeared)
        gate.promptPaired(gate.prompt)
        // If anything does get past the prompt, it waits here, so the view's disappearing can't be what stops it.
        await rig.chain.hold(snapshots: true)
        gate.windowChanged(isInFront: true)
        for _ in 0..<5000 {
            if await rig.chain.heldCalls > 0 || gate.phase == .stopped(nil) { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(gate.phase == .stopped(nil), "it never got past the prompt")
        #expect(await rig.chain.heldCalls == 0)
        for _ in 0..<1000 where !disappeared {
            window.layoutIfNeeded()
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(disappeared)
        await rig.chain.release()
    }

    @Test func editingCallsOffASendBeforeTheConfirmationDisappears() async throws {
        let presence = LeavesThenTouches()
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(20)]), userPresence: presence)
        await rig.wallet.tick()
        let source = ScriptedPortfolios(.success(portfolio()))
        let store = PortfolioStore(defaults: UserDefaults(suiteName: "approval-lifecycle-\(UUID().uuidString)")!, makeSource: { _ in source })
        defer { store.stop() }
        let model = SendModel(wallet: rig.wallet, store: store)
        model.token = usdc
        model.amountText = "5"
        model.addressText = coldAddress.lowercased
        model.confirm()
        presence.leave = { model.backToEditing() }
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in await model.sendConfirmed(in: prompt) }
        try await run(gate: gate, rig: rig, isShown: { model.stage != .composing })
        model.amountText = "1"
        #expect(await rig.signer.signed.isEmpty)
        #expect(model.stage == .composing)
    }

    @Test func cancellingCallsOffASweepBeforeTheSheetDisappears() async throws {
        let presence = LeavesThenTouches()
        let rig = await Rig(snapshot(tokens: [usdc: usdcUnits(20)]), userPresence: presence)
        let wallet = rig.wallet
        await wallet.tick()
        let sheet = Visibility()
        let gate = ApprovalPrompt(sleep: { _ in }) { prompt, _ in
            await wallet.sweepEverything(in: prompt) ? .done : .cancelled
        }
        // What the footer's Cancel does.
        presence.leave = { if gate.backOut() { sheet.isShown = false } }
        try await run(gate: gate, rig: rig, isShown: { sheet.isShown })
        #expect(await rig.signer.signed.isEmpty)
    }
}
#endif
