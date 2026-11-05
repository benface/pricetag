import AppKit
import HotWalletKit
import KeyVault
import LocalAuthenticationEmbeddedUI
import PricetagKit
import SwiftUI

struct ConfirmationRow: Identifiable {
    let label: String
    let value: String
    var isAddress = false
    /// Who an address belongs to, above it, when that's known.
    var name: String?
    var id: String { label }
}

enum ConfirmationHero {
    case amount(String, symbol: String)
    case words(String)
}

enum ConfirmationAsker {
    case site(String)
    case spendingMoney
}

/// What's being approved, in the one layout every approval uses: one big number, who's asking, where it goes, and the fee kept small.
/// Touch ID asks at the bottom of it, so nothing it's asking about is ever covered.
struct ConfirmationView<Footer: View>: View {
    let asker: ConfirmationAsker
    let hero: ConfirmationHero
    /// What it's worth, under the number.
    var worth: String?
    var rows: [ConfirmationRow] = []
    var warnings: [SiteWarning] = []
    /// A message being signed, which is the whole of what's being approved, so it's never tucked away.
    var message: String?
    var details: [ConfirmationRow] = []
    var data: String?
    @ViewBuilder let footer: Footer

    @State private var showsDetails = false

    var body: some View {
        VStack(spacing: 0) {
            VStack(spacing: 18) {
                who
                heroView
                if let message { LongText(text: message) }
                if !rows.isEmpty { rowsBox }
                ForEach(warnings) { warning in
                    if warning.isStrong {
                        StrongWarning(text: warning.text)
                    } else {
                        Notice(.info, warning.text)
                    }
                }
            }
            .padding(.horizontal, 20)
            .padding(.top, 28)
            .padding(.bottom, 20)
            footer
                .padding(.horizontal, 20)
                .padding(.bottom, 20)
        }
    }

    @ViewBuilder
    private var who: some View {
        switch asker {
        case .site(let site):
            HStack(spacing: 8) {
                Text(String(site.prefix(1)).uppercased())
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 24, height: 24)
                    .background(.quaternary, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                    .accessibilityHidden(true)
                Text(site)
                    .font(.headline)
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
        case .spendingMoney:
            Label(HotWalletWording.title, systemImage: "banknote")
                .font(.headline)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var heroView: some View {
        VStack(spacing: 2) {
            switch hero {
            case .amount(let amount, let symbol):
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(amount)
                        .font(.system(size: 46, weight: .semibold, design: .rounded))
                    Text(symbol)
                        .font(.system(size: 24, weight: .medium, design: .rounded))
                        .foregroundStyle(.secondary)
                }
                .monospacedDigit()
                .lineLimit(1)
                // To the last digit, whatever that takes, because this is what's being approved.
                .minimumScaleFactor(0.35)
                .textSelection(.enabled)
            case .words(let words):
                Text(words)
                    .font(.system(size: 24, weight: .semibold, design: .rounded))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            if let worth {
                Text(worth)
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var rowsBox: some View {
        GroupBox {
            VStack(spacing: 8) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider() }
                    RowView(row: row)
                }
                if !details.isEmpty || data != nil {
                    Divider()
                    detailsSection
                }
            }
            .padding(4)
        }
    }

    private var detailsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Its own button and not a DisclosureGroup, whose focus ring gets cut off at the edge of a window this narrow.
            Button {
                withAnimation(.snappy) { showsDetails.toggle() }
            } label: {
                Label("Details", systemImage: "chevron.right")
                    .labelStyle(DetailsLabelStyle(isOpen: showsDetails))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(showsDetails ? "Showing" : "Hidden")
            if showsDetails {
                VStack(spacing: 6) {
                    ForEach(details) { RowView(row: $0).font(.callout) }
                }
                if let data { LongText(text: data) }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct RowView: View {
    let row: ConfirmationRow

    var body: some View {
        if row.isAddress {
            // Whole, and on one line, because that's how it's checked. If that leaves no room beside the label, it goes under it.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    label
                    Spacer(minLength: 0)
                    VStack(alignment: .trailing, spacing: 2) {
                        name
                        address
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    label
                    name
                    address
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .textSelection(.enabled)
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                label
                Spacer(minLength: 0)
                Text(row.value)
                    .monospacedDigit()
                    .multilineTextAlignment(.trailing)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    private var label: some View {
        Text(row.label)
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    @ViewBuilder
    private var name: some View {
        if let name = row.name { Text(name) }
    }

    private var address: some View {
        Text(row.value)
            .font(.system(size: 11, design: .monospaced))
            .fixedSize()
    }
}

private struct DetailsLabelStyle: LabelStyle {
    let isOpen: Bool

    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.icon
                .imageScale(.small)
                .rotationEffect(.degrees(isOpen ? 90 : 0))
            configuration.title
        }
    }
}

/// A message or a contract's data, as it is, in a box that scrolls rather than pushing the window off the screen.
private struct LongText: View {
    let text: String

    var body: some View {
        ScrollView {
            Text(text)
                .font(.callout.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
        }
        .frame(maxHeight: 200)
        .fixedSize(horizontal: false, vertical: true)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Scams rely on these, so they can't be missed. Red, with white text, in light and dark.
private struct StrongWarning: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.octagon.fill")
            .font(.callout.weight(.medium))
            .foregroundStyle(.white)
            .fixedSize(horizontal: false, vertical: true)
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.red, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// Where Touch ID asks, and the way out. A strong warning takes saying so first, and a cancelled prompt offers to ask again.
struct TouchIDFooter: View {
    let gate: ApprovalPrompt
    /// What Touch ID does, as in "Touch ID to send".
    let verb: String
    /// What's happening once it's said yes, as in "Sending…".
    let doing: String
    /// "Reject" or "Cancel". One click, and Escape does the same.
    let leaveTitle: String
    let leave: () -> Void

    @State private var isArmed = false

    var body: some View {
        HStack(spacing: 14) {
            content
            Spacer(minLength: 8)
            buttons
        }
        .controlSize(.large)
        .frame(minHeight: 56)
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        // The two together: where the window is decides when this asks, and it never asks while it isn't seen.
        .background(WindowInFrontReader { gate.windowChanged(isInFront: $0) })
        .onDisappear(perform: gate.stop)
        .task {
            try? await Task.sleep(for: SiteApprovalView.armingDelay)
            isArmed = true
        }
        .animation(.snappy, value: gate.phase)
    }

    @ViewBuilder
    private var content: some View {
        switch gate.phase {
        case .needsAcknowledgment:
            Image(systemName: "touchid")
                .font(.system(size: 28))
                .foregroundStyle(.tertiary)
                .accessibilityHidden(true)
            Text("Touch ID is next")
                .foregroundStyle(.secondary)
        case .waiting, .asking:
            if gate.prompt.isSystemDialog {
                Label("Confirm in the dialog", systemImage: "lock.fill")
                    .font(.headline)
            } else {
                ZStack {
                    // Paired before it's asked, or it wouldn't be the one asking. It draws nothing until then.
                    TouchIDGlyph(prompt: gate.prompt) { gate.promptPaired($0) }
                    if !gate.drawsSystemGlyph {
                        Image(systemName: "touchid")
                            .font(.system(size: 28))
                            .foregroundStyle(gate.phase == .asking ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    }
                }
                .frame(width: 40, height: 40)
                .accessibilityHidden(true)
                Text(gate.isInFront || gate.phase == .asking ? "Touch ID to \(verb)" : "Click here for Touch ID")
                    .font(.headline)
            }
        case .working:
            ProgressView().controlSize(.small)
            Text(doing)
                .font(.headline)
        case .stopped(let reason):
            Text(reason ?? "Nothing happened")
                .font(.headline)
                .foregroundStyle(reason == nil ? AnyShapeStyle(.primary) : Tone.warning.style)
                .fixedSize(horizontal: false, vertical: true)
        case .done:
            EmptyView()
        }
    }

    /// Calls off the prompt before anything else, so nothing the user's just left can still go through.
    private func backOut() {
        if gate.backOut() { leave() }
    }

    @ViewBuilder
    private var buttons: some View {
        switch gate.phase {
        case .needsAcknowledgment:
            Button("I Trust This Site", action: gate.acknowledge)
                .disabled(!isArmed)
            Button(leaveTitle, action: backOut)
                .keyboardShortcut(.cancelAction)
                .buttonStyle(.borderedProminent)
        case .waiting, .asking:
            Button(leaveTitle, action: backOut)
                .keyboardShortcut(.cancelAction)
        case .working, .done:
            // Past Touch ID, there's no calling it back, so nothing here offers to.
            EmptyView()
        case .stopped:
            Button(leaveTitle, action: backOut)
                .keyboardShortcut(.cancelAction)
            Button("Try Again", action: gate.tryAgain)
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
    }
}

/// After Touch ID, while it goes out and once it has.
struct ProgressFooter: View {
    let doing: String
    let done: String
    let isDone: Bool

    var body: some View {
        HStack(spacing: 10) {
            if isDone {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.green)
                    .transition(.symbolEffect(.drawOn))
            } else {
                ProgressView().controlSize(.small)
            }
            Text(isDone ? done : doing)
                .font(.headline)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity, minHeight: 56)
        .padding(.vertical, 8)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
        .animation(.snappy, value: isDone)
    }
}

/// The system's own Touch ID glyph. Pairing it with a context is what keeps the prompt in our window. That only happens when the system's
/// view is made, so a new prompt needs a new one, and it says so only once what's on screen really is paired with that prompt.
private struct TouchIDGlyph: NSViewRepresentable {
    let prompt: PresencePrompt
    let paired: (PresencePrompt) -> Void

    func makeNSView(context: Context) -> Holder {
        Holder()
    }

    func updateNSView(_ holder: Holder, context: Context) {
        if holder.glyph?.context !== prompt.context {
            holder.glyph?.removeFromSuperview()
            let glyph = LAAuthenticationView(context: prompt.context, controlSize: .large)
            glyph.frame = holder.bounds
            glyph.autoresizingMask = [.width, .height]
            holder.addSubview(glyph)
            holder.glyph = glyph
        }
        guard holder.glyph?.context === prompt.context else { return }
        let prompt = prompt
        let paired = paired
        // Later, because this runs in the middle of a SwiftUI update.
        DispatchQueue.main.async { paired(prompt) }
    }

    final class Holder: NSView {
        var glyph: LAAuthenticationView?
    }
}

/// Whether the window it's in is on screen, uncovered, and what the user's using. A sheet counts as its own window.
struct WindowInFrontReader: NSViewRepresentable {
    let changed: (Bool) -> Void

    func makeNSView(context: Context) -> Tracker {
        Tracker(changed: changed)
    }

    func updateNSView(_ view: Tracker, context: Context) {
        view.changed = changed
    }

    final class Tracker: NSView {
        var changed: (Bool) -> Void
        private var observers: [any NSObjectProtocol] = []

        init(changed: @escaping (Bool) -> Void) {
            self.changed = changed
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            for observer in observers { NotificationCenter.default.removeObserver(observer) }
            observers = []
            if let window {
                let center = NotificationCenter.default
                for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification] {
                    observers.append(center.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.report() } })
                }
                for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification] {
                    observers.append(center.addObserver(forName: name, object: NSApp, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.report() } })
                }
            }
            // Later, because this can run in the middle of a SwiftUI update.
            DispatchQueue.main.async { [weak self] in self?.report() }
        }

        private func report() {
            let isInFront = window.map { $0.isVisible && $0.isKeyWindow && $0.occlusionState.contains(.visible) } ?? false
            changed(isInFront && NSApp.isActive)
        }
    }
}
