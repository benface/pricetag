import AppKit
import HotWalletKit
import KeyVault
import LocalAuthenticationEmbeddedUI
import PricetagKit
import SwiftUI

struct ConfirmationRow {
    let label: String
    let value: String
    var isAddress = false
    /// Who an address belongs to, above it, when that's known.
    var name: String?
}

extension EnvironmentValues {
    /// The tallest an approval can be. Otherwise the smallest screen's, since this doesn't know which one it'll open on.
    @Entry var confirmationHeightLimit: CGFloat?
    /// Under a title bar with nothing in it but the close button, which is space enough above what's being approved.
    @Entry var isBelowTitleBar = false
    /// What's being approved, as VoiceOver says it, for the button that lets Touch ID ask. See `TouchIDFooter`.
    @Entry var approvalSummary: Text?
}

extension ApprovalPrompt {
    /// Whether an approval waits for the user to say they've heard it before Touch ID can ask, which only matters with VoiceOver on.
    static var needsReview: Bool { NSWorkspace.shared.isVoiceOverEnabled }
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

    @Environment(\.confirmationHeightLimit) private var heightLimit
    @Environment(\.isBelowTitleBar) private var isBelowTitleBar
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var showsDetails = false
    @State private var pinnedHeight: CGFloat = 0
    @State private var hasMoreBelow = false

    var body: some View {
        VStack(spacing: 0) {
            // What's being approved scrolls when there's too much of it. Warnings and the way out never do, because a site chooses how much there is.
            ScrollView {
                VStack(spacing: 18) {
                    who
                    heroView
                    if let message { LongText(text: message) }
                    if !rows.isEmpty { rowsBox }
                }
                .padding(.horizontal, 20)
                .padding(.top, isBelowTitleBar ? 0 : 28)
                .padding(.bottom, warnings.isEmpty ? 20 : 18)
            }
            .scrollIndicators(.visible)
            .onScrollGeometryChange(for: Bool.self) { $0.visibleRect.maxY < $0.contentSize.height - 4 } action: { hasMoreBelow = $1 }
            .frame(maxHeight: max(Self.leastScrollHeight, (heightLimit ?? Self.screenHeight) - pinnedHeight))
            .fixedSize(horizontal: false, vertical: true)
            // A scroll bar only shows once it's scrolling, and what's out of sight is part of what's being approved.
            .overlay(alignment: .bottom) {
                if hasMoreBelow {
                    Label("More below", systemImage: "chevron.down")
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(.regularMaterial, in: Capsule())
                        .shadow(radius: 2, y: 1)
                        .padding(.bottom, 8)
                        .allowsHitTesting(false)
                }
            }
            VStack(spacing: 20) {
                if !warnings.isEmpty {
                    VStack(spacing: 18) {
                        ForEach(warnings) { warning in
                            if warning.isStrong {
                                StrongWarning(text: warning.text)
                            } else {
                                Notice(.info, warning.text)
                            }
                        }
                    }
                }
                footer
                    .environment(\.approvalSummary, spokenSummary)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { pinnedHeight = $0 }
        }
    }

    private static var leastScrollHeight: CGFloat { 160 }

    /// With room for the title bar, which the window adds on top of what's in it.
    private static var screenHeight: CGFloat {
        (NSScreen.screens.map(\.visibleFrame.height).min() ?? 700) - 40
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
                        .font(.displayLarge)
                    Text(symbol)
                        .font(.displaySmall)
                        .fontWeight(.medium)
                        .foregroundStyle(.secondary)
                }
                .monospacedDigit()
                .lineLimit(1)
                // To the last digit, whatever that takes, because this is what's being approved.
                .minimumScaleFactor(0.35)
                .textSelection(.enabled)
            case .words(let words):
                Text(words)
                    .font(.displaySmall)
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
        // The whole amount and what it's worth, in one go, so neither can be missed.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(heroSpoken)
        .accessibilityAddTraits(.isHeader)
    }

    /// The amount and every row, with each address a character at a time. The button that lets Touch ID ask says all of it again.
    private var spokenSummary: Text {
        rows.reduce(Text(heroSpoken)) { $0 + Text(". ") + RowView.spoken($1) }
    }

    private var heroSpoken: String {
        let what = switch hero {
        case .amount(let amount, let symbol): "\(amount) \(symbol)"
        case .words(let words): words
        }
        return [Spoken.text(what.trimmingCharacters(in: .whitespaces)), worth.map(Spoken.text)].compactMap { $0 }.joined(separator: ", ")
    }

    private var rowsBox: some View {
        GroupBox {
            VStack(spacing: 8) {
                // By position, since nothing about a row has to be different from the next.
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
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
                withAnimation(reduceMotion ? nil : Motion.state) { showsDetails.toggle() }
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
                    ForEach(Array(details.enumerated()), id: \.offset) { RowView(row: $0.element).font(.callout) }
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
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(row))
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
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Self.spoken(row))
        }
    }

    /// What it's called, whose it is, then what it says. An address goes a character at a time, because that's what's being checked.
    static func spoken(_ row: ConfirmationRow) -> Text {
        guard row.isAddress else { return Text("\(row.label), \(Spoken.text(row.value))") }
        return Text(([row.label, row.name].compactMap { $0 } + [""]).joined(separator: ", ")) + Text(Spoken.address(row.value)).speechSpellsOutCharacters()
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
        AddressLine(row.value)
            .font(.subheadline)
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
        .softBox()
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
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Warning: \(text)")
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
    /// The warning that "I Trust This Site" says yes to. It's part of the button's label, so it's heard by whoever goes straight to the button.
    var acknowledges = ""
    let leave: () -> Void

    @State private var isArmed = false
    @Environment(\.approvalSummary) private var summary

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
        .softBox(cornerRadius: 18)
        // The two together: where the window is decides when this asks, and it never asks while it isn't seen.
        .background(WindowInFrontReader { gate.windowChanged(isInFront: $0) })
        .onDisappear(perform: gate.stop)
        .task {
            try? await Task.sleep(for: SiteApprovalView.armingDelay)
            isArmed = true
        }
        .motion(Motion.state, value: gate.phase)
        // What changes here changes without focus moving, so VoiceOver says it.
        .onChange(of: gate.phase) { _, phase in
            switch phase {
            case .working: AccessibilityNotification.Announcement(doing).post()
            case .stopped(let reason): AccessibilityNotification.Announcement(reason ?? "Nothing happened").post()
            default: break
            }
        }
    }

    @ViewBuilder
    private var content: some View {
        switch gate.phase {
        case .needsAcknowledgment, .needsReview:
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

    /// A button that lets Touch ID ask, then the warning it says yes to, then everything being approved.
    private func spokenLabel(_ title: String, warning: String) -> Text {
        let lead = Text(warning.isEmpty ? "\(title): " : "\(title). Warning: \(warning) Approving: ")
        return summary.map { lead + $0 } ?? Text(title)
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
                // In the label and not a hint, because hints can be off, and the label is read the moment it's reached.
                .accessibilityLabel(spokenLabel("I Trust This Site", warning: acknowledges))
            Button(leaveTitle, action: backOut)
                .keyboardShortcut(.cancelAction)
                .buttonStyle(.borderedProminent)
        case .needsReview:
            // Only with VoiceOver on. Touch ID waits for this, however long hearing the amount and the whole address takes.
            Button(leaveTitle, action: backOut)
                .keyboardShortcut(.cancelAction)
            Button("Ready for Touch ID", action: gate.reviewed)
                .buttonStyle(.borderedProminent)
                .disabled(!isArmed)
                .accessibilityLabel(spokenLabel("Ready for Touch ID to \(verb)", warning: ""))
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

/// After Touch ID, while it goes out and until it's landed. The green check is only for what's really finished: a receipt for a transaction, or a signature for a message.
struct ProgressFooter: View {
    enum Stage: Equatable {
        /// Still being signed or sent from here.
        case working(String)
        /// Sent, and nothing has said yet what became of it.
        case onItsWay
        /// Sent, and this won't be here to see it land.
        case handedOff
        case finished(String)
        case didntLand(String)
    }

    let stage: Stage
    /// Closing doesn't stop what's on its way, and nobody needs to wait for it.
    var close: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            icon
            Text(text)
                .font(.headline)
                .contentTransition(.opacity)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 56)
        .overlay(alignment: .trailing) {
            if let close, stage == .onItsWay || isFailure {
                Button("Close", action: close)
                    .keyboardShortcut(.cancelAction)
                    .controlSize(.large)
                    .padding(.trailing, 14)
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 8)
        .softBox(cornerRadius: 18)
        .animation(Motion.state, value: stage)
        .onChange(of: text) { AccessibilityNotification.Announcement(text).post() }
        .sensoryFeedback(.success, trigger: stage) { _, stage in
            if case .finished = stage { true } else { false }
        }
    }

    private var isFailure: Bool {
        if case .didntLand = stage { true } else { false }
    }

    @ViewBuilder
    private var icon: some View {
        switch stage {
        case .working, .onItsWay:
            ProgressView().controlSize(.small)
        case .handedOff:
            Image(systemName: "paperplane.fill")
                .font(.title3)
                .foregroundStyle(.secondary)
        case .finished:
            Image(systemName: "checkmark.circle.fill")
                .font(.title2)
                .foregroundStyle(.green)
                .transition(.symbolEffect(.drawOn))
        case .didntLand:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.title3)
                .foregroundStyle(Tone.warning.style)
        }
    }

    private var text: String {
        switch stage {
        case .working(let doing): doing
        case .onItsWay, .handedOff: "On its way"
        case .finished(let done): done
        case .didntLand(let why): why
        }
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
