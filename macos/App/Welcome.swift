import HotWalletKit
import PricetagKit
import SwiftUI

/// What the app is, in its own words. The rest of the way shows it working instead.
private struct WelcomePitch: View {
    var body: some View {
        VStack(spacing: 12) {
            Image(nsImage: NSApp?.applicationIconImage ?? NSImage())
                .resizable()
                .frame(width: 72, height: 72)
                .accessibilityHidden(true)
            Text(Wording.welcomeTitle)
                .font(.displaySmall)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            Text(Wording.welcomePitch(appName: AppName.current))
                .multilineTextAlignment(.center)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// Centers what's shorter than the window, and scrolls what isn't, down to the smallest window.
private struct WelcomePage<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GeometryReader { window in
            ScrollView {
                content
                    .frame(maxWidth: 440)
                    .padding(.horizontal, window.size.width < 520 ? 16 : 28)
                    .padding(.vertical, 20)
                    .frame(maxWidth: .infinity, minHeight: window.size.height)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }
}

/// The way to a first wallet, on one screen. A step the server asks for, like an invite, happens here too.
struct FirstRunWelcome: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @State private var input = ""
    @State private var invite = ""
    @FocusState private var focus: Field?

    private enum Field: Hashable { case address, invite }
    private enum Step { case checking, invite, choices }

    private var step: Step {
        if store.needsInvite { return .invite }
        // A build with its own server can't do anything until that answers. Any other can still make a wallet.
        return Build.isForOtherPeople && store.serverCheck == .checking ? .checking : .choices
    }

    var body: some View {
        WelcomePage {
            VStack(spacing: 22) {
                WelcomePitch()
                if store.serverCheck == .unreachable, let problem = FeedState.serverUnreachable.problem(serverURL: store.serverURL, portfolio: nil) {
                    Notice(.warning, problem.message, detail: problem.detail, actionTitle: "Try Again", action: store.checkServer)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .arrives()
                }
                Group {
                    switch step {
                    case .checking:
                        HStack(spacing: 8) {
                            ProgressView().controlSize(.small)
                            Text("Connecting to \(AppName.current)'s server…").secondaryText()
                        }
                        .accessibilityElement(children: .combine)
                    case .invite: inviteStep
                    case .choices: choices
                    }
                }
                .transition(.opacity)
            }
            .motion(Motion.state, value: step)
            .motion(Motion.state, value: store.serverCheck)
        }
        // Keeps looking by itself, so being down isn't something to come back and check.
        .task(id: store.serverCheck) {
            while store.serverCheck == .unreachable, !Task.isCancelled {
                try? await Task.sleep(for: .seconds(10))
                guard !Task.isCancelled else { return }
                await store.refreshRules()
            }
        }
        .onChange(of: step, initial: true) { _, step in
            focus = step == .invite ? .invite : step == .choices ? .address : nil
        }
    }

    private var inviteStep: some View {
        GroupBox {
            VStack(alignment: .leading, spacing: 10) {
                Label("Enter Your Invite", systemImage: "envelope").font(.headline)
                Text(InvitePrompt.explanation)
                    .font(.callout)
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
                SecureField("Invite", text: $invite)
                    .textFieldStyle(.roundedBorder)
                    .focused($focus, equals: .invite)
                    .onSubmit(saveInvite)
                if store.invite != nil {
                    WarningText(InvitePrompt.refused)
                        .font(.callout)
                }
                HStack {
                    Spacer()
                    Button("Continue", action: saveInvite)
                        .buttonStyle(.borderedProminent)
                        .keyboardShortcut(.defaultAction)
                        .disabled(invite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .padding(6)
        }
    }

    private func saveInvite() {
        guard !invite.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        store.setInvite(invite)
        invite = ""
    }

    private var choices: some View {
        VStack(spacing: 12) {
            GroupBox {
                VStack(alignment: .leading, spacing: 0) {
                    watch.padding(6)
                    if hotWallet.availability == .ready {
                        Divider().padding(.vertical, 6)
                        spendingMoney.padding(6)
                        Divider().padding(.vertical, 6)
                        savings.padding(6)
                    }
                }
            }
            if WalletList.offersDemo {
                Button("Try the Demo Wallet") { store.setWallet(WalletAddress.demo) }
                    .buttonStyle(.link)
                    .help("Made-up numbers, to see how it works.")
            }
        }
    }

    private var watch: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Watch a Wallet", systemImage: "eye").font(.headline)
            AddressField(prompt: "Paste a Base address", text: $input, wallets: store.walletList(hotWallet: hotWallet).pickable, read: AddressText.readAnywhere, focus: $focus, equals: .address, onAddress: { store.setWallet($0) })
                .textFieldStyle(.roundedBorder)
            Text(Wording.watchHint)
                .font(.callout)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// That sheet says what this is and what can go wrong, and only it makes the key.
    private var spendingMoney: some View {
        WelcomeChoice(title: HotWalletWording.title, symbol: "banknote", summary: HotWalletWording.summary) {
            if let address = hotWallet.address {
                Button("Show") { store.setWallet(address.lowercased) }
            } else {
                Button("Create…") { navigation.showSpendingMoney() }
            }
        }
    }

    private var savings: some View {
        WelcomeChoice(title: "Savings", symbol: "lock.shield", summary: Wording.savingsSummary) {
            Button("Add…") { navigation.addSavings() }
        }
    }
}

/// One way to start, with what it is beside what starts it, the way a settings row reads.
private struct WelcomeChoice<Action: View>: View {
    let title: String
    let symbol: String
    let summary: String
    @ViewBuilder let action: Action

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Label(title, systemImage: symbol).font(.headline)
                Text(summary)
                    .font(.callout)
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 0)
            action.fixedSize()
        }
    }
}

/// A wallet's first read, step by step as the server reports them. With a server that can't say, it only says how long it's been, because a
/// progress that's made up is worse than none. Nothing here is a number about the wallet except what's been found, so there are no zeros to mistake for its value.
struct FirstRead: View {
    let store: PortfolioStore
    let firstRun: FirstRun
    /// Inside a page that already scrolls, this mustn't scroll too.
    var isInsidePage = false
    @State private var progress: FirstReadProgress?

    /// Why this read can be slow, so unlike the note with the numbers, it's for every read of a contract, seen before or not.
    private var isContract: Bool { progress?.isContract == true }

    var body: some View {
        Group {
            if isInsidePage {
                steps
                    .frame(maxWidth: 440)
                    .frame(maxWidth: .infinity)
            } else {
                WelcomePage { steps }
            }
        }
        .task(id: store.address) {
            progress = nil
            guard let address = store.address else { return }
            while !Task.isCancelled {
                // Fine to miss one: the next is a moment away, and a server that can't say just leaves the clock.
                if let next = try? await store.currentSource.readProgress(address: address), !Task.isCancelled {
                    progress = next
                }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        // A step's check mark is only something to see.
        .onChange(of: progress?.stage) { _, stage in
            guard let step = progress?.steps.first(where: { $0.id == stage }) else { return }
            AccessibilityNotification.Announcement(step.title).post()
        }
    }

    private var steps: some View {
        VStack(spacing: 18) {
            Text(Wording.readingTitle)
                .font(.displaySmall)
                .multilineTextAlignment(.center)
                .accessibilityAddTraits(.isHeader)
            if let progress {
                GroupBox {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(progress.steps) { StepRow(step: $0) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(6)
                }
                .transition(.opacity)
            } else {
                ProgressView().controlSize(.large)
            }
            ReadingClock(since: store.readingSince ?? .now) { seconds in
                Text(store.feed == .tooSlow ? Wording.readTakingLong : seconds < FeedState.longReadSeconds ? Wording.reading : Wording.stillReading(seconds: seconds))
                    .font(.callout)
                    .multilineTextAlignment(.center)
                    .secondaryText()
                    .contentTransition(.numericText())
                    .fixedSize(horizontal: false, vertical: true)
            }
            if isContract {
                Notice(.warning, Wording.contractNotice)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .arrives()
            }
            // Past the welcome, the wallet menu in the toolbar does this, and no wallet at all isn't a place to send anyone.
            if firstRun.isWelcoming {
                Button("Choose Another Wallet") { store.setWallet(nil) }
            }
        }
        .motion(Motion.state, value: progress?.stage)
        .motion(Motion.state, value: isContract)
    }
}

private struct StepRow: View {
    let step: FirstReadProgress.Step

    var body: some View {
        HStack(spacing: 8) {
            Group {
                switch step.state {
                case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Tone.gain.style)
                case .now: ProgressView().controlSize(.small)
                case .later: Image(systemName: "circle").foregroundStyle(.tertiary)
                }
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
            Text(step.title)
                .foregroundStyle(step.state == .later ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                .monospacedDigit()
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityValue(step.state == .done ? "Done" : step.state == .now ? "In progress" : "Not started")
    }
}

/// What Help shows with a wallet already on screen. The explanations come back by themselves next time they apply.
struct WelcomeAgain: View {
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 18) {
            WelcomePitch()
            Text("Click any number to see where it came from. The notes from your first visit will show again, once each.")
                .font(.callout)
                .multilineTextAlignment(.center)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
            Button("Done") { dismiss() }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
        }
        .padding(28)
        .frame(width: 420)
    }
}
