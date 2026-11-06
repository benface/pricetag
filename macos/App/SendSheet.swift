import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// Sends from this Mac's spending money. A new address gets asked about here, so there's nothing to untangle later.
/// Pressing Send goes straight to Touch ID, with what's being sent on screen.
struct SendSheet: View {
    @State var model: SendModel
    /// Every saved wallet. The form offers the ones this send permits.
    var wallets: [WalletEntry] = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if model.stage == .composing {
                SendForm(model: model, wallets: wallets.filter(model.canSend(to:)), dismiss: { dismiss() })
            } else {
                SendConfirmation(model: model, gate: SendConfirmation.gate(for: model)) { dismiss() }
            }
        }
        .frame(width: 460)
        // Touch ID's own prompt can still say no. Past that, closing this wouldn't stop what's on its way.
        .interactiveDismissDisabled(model.isSending)
    }
}

private struct SendForm: View {
    let model: SendModel
    let wallets: [WalletEntry]
    let dismiss: () -> Void

    private enum Field { case amount, address }
    @FocusState private var focus: Field?

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 18) {
            Label(HotWalletWording.title, systemImage: "banknote")
                .font(.headline)
                .secondaryText()
            VStack(spacing: 6) {
                amountField
                HStack(spacing: 10) {
                    Picker("Token", selection: $model.token) {
                        ForEach(model.tokens) { Text($0.symbol).tag($0) }
                    }
                    .labelsHidden()
                    .fixedSize()
                    Button("Max") { model.useMaximum() }
                        .disabled(model.maximum == 0)
                    if let available = model.availableText {
                        Text("\(available) available")
                            .secondaryText()
                            .monospacedDigit()
                    }
                }
                otherUnit
                if let problem = model.amountProblem {
                    WarningText(problem.message).font(.callout).fixedSize(horizontal: false, vertical: true)
                }
            }
            VStack(alignment: .leading, spacing: 8) {
                if let address = model.recipient {
                    recipientCard(address)
                } else {
                    AddressField("To", prompt: wallets.isEmpty ? "To: 0x…" : "To: 0x…, or a wallet's name", text: $model.addressText, wallets: wallets, read: AddressText.read, focus: $focus, equals: .address, onSubmit: next)
                        .textFieldStyle(.roundedBorder)
                        .controlSize(.large)
                }
                recipient
            }
            if let failure = model.failure {
                WarningText(failure).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Text("A send can't be undone.")
                    .font(.caption)
                    .secondaryText()
                Spacer()
                Button("Cancel", role: .cancel, action: dismiss)
                    .keyboardShortcut(.cancelAction)
                Button("Send", action: next)
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(!model.canSend)
            }
            .controlSize(.large)
        }
        .padding(24)
        .defaultFocus($focus, .amount)
    }

    /// Return goes on to the next thing that's needed, so a send can take no clicks at all.
    private func next() {
        if model.canSend {
            model.confirm()
        } else if focus == .amount, model.recipient == nil {
            focus = .address
        }
    }

    private var amountField: some View {
        @Bindable var model = model
        let title = model.unit == .money ? "Amount in \(model.moneySymbol)" : "Amount in \(model.token.symbol)"
        return TextField(title, text: $model.amountText, prompt: Text("0"))
            .labelsHidden()
            .textFieldStyle(.plain)
            .font(.displayLarge)
            .monospacedDigit()
            .multilineTextAlignment(.center)
            .focused($focus, equals: .amount)
            .onSubmit(next)
            // Its label is hidden, so a field that only said "12.50" would say nothing about what it's for.
            .accessibilityLabel(title)
            .overlay {
                // The symbol sits just before the centered digits: a hidden copy of them on each side keeps them where the field draws them.
                if model.unit == .money {
                    HStack(spacing: 0) {
                        Text(model.moneySymbol).secondaryText()
                        Text(model.amountText.isEmpty ? "0" : model.amountText).hidden()
                        Text(model.moneySymbol).hidden()
                    }
                    .font(.displayLarge)
                    .monospacedDigit()
                    .lineLimit(1)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            }
    }

    /// What's typed, in the other unit, and the way to type in it instead. In money, this is the exact amount that's signed.
    @ViewBuilder
    private var otherUnit: some View {
        let other = model.unit == .token ? model.worthText : model.tokenAmountText
        if model.canTypeMoney || model.unit == .money {
            Button {
                model.switchUnit()
                focus = .amount
            } label: {
                Label(other ?? "Type in \(model.unit == .token ? model.moneySymbol : model.token.symbol)", systemImage: "arrow.up.arrow.down")
            }
            .buttonStyle(.plain)
            .font(.title3)
            .secondaryText()
            .monospacedDigit()
            .accessibilityLabel(other.map { model.unit == .token ? "Worth \(Spoken.text($0))" : Spoken.text($0) } ?? "Type in \(model.unit == .token ? model.moneySymbol : model.token.symbol)")
            .help(model.unit == .token ? "Type the amount in money" : "Type the amount in \(model.token.symbol)")
            .accessibilityHint(model.unit == .token ? "Types the amount in money instead" : "Types the amount in \(model.token.symbol) instead")
        } else if let worth = model.worthText {
            Text(worth)
                .font(.title3)
                .secondaryText()
                .monospacedDigit()
                .accessibilityLabel("Worth \(Spoken.text(worth))")
        }
    }

    /// The address, once, whole and in groups, however it got here, because a saved name doesn't say the address behind it is still the right one.
    private func recipientCard(_ address: EthereumAddress) -> some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 3) {
                Text(model.recipientName.map { "To \($0)" } ?? "To")
                    .fontWeight(.medium)
                AddressLine(address.checksummed, marked: model.lookalike.map { Lookalike.differences(between: address.checksummed, and: $0.address.checksummed) } ?? [])
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Spoken.address(address.checksummed, after: "Sending to, "))
            }
            Spacer(minLength: 0)
            Button("Change Address", systemImage: "xmark.circle.fill") {
                model.addressText = ""
                focus = .address
            }
            .labelStyle(.iconOnly)
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Change address")
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .softBox()
    }

    @ViewBuilder
    private var recipient: some View {
        if model.recipient != nil {
            if let problem = model.recipientProblem {
                WarningText(problem.message).font(.callout).fixedSize(horizontal: false, vertical: true)
            } else if let match = model.lookalike {
                lookalike(match)
            } else if let known = model.knownAs {
                Label(known.title, systemImage: known == .someoneElse ? "person" : "checkmark.circle")
                    .font(.callout)
                    .secondaryText()
            } else if model.asksIfItsYours {
                isThisYours
            }
        }
    }

    /// Address poisoning: an address made to start and end like one they know. It's shown under the one typed, in the same place, so
    /// they line up, and sending anyway takes ticking a box.
    private func lookalike(_ match: LookalikeMatch) -> some View {
        @Bindable var model = model
        let typed = model.recipient?.checksummed ?? ""
        return VStack(alignment: .leading, spacing: 8) {
            Label("This only looks like \(match.name)", systemImage: "exclamationmark.triangle.fill")
                .fontWeight(.semibold)
                .foregroundStyle(Tone.warning.style)
            VStack(alignment: .leading, spacing: 3) {
                Text(match.name.prefix(1).uppercased() + match.name.dropFirst())
                    .foregroundStyle(.secondary)
                AddressLine(match.address.checksummed, marked: Lookalike.differences(between: match.address.checksummed, and: typed))
                    .font(.callout)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Text("Its start and end are the same, which is a common trick to steal money. Check every character.")
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            Toggle("I've checked, and this is the address I mean", isOn: $model.acceptsLookalike)
                .toggleStyle(.checkbox)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .softBox()
    }

    private var isThisYours: some View {
        @Bindable var model = model
        return VStack(alignment: .leading, spacing: 8) {
            Text("Is this yours?").fontWeight(.semibold)
            Picker("Is this yours?", selection: $model.ownership) {
                ForEach(Ownership.allCases) { Text($0.title).tag(Ownership?.some($0)) }
            }
            .labelsHidden()
            .pickerStyle(.segmented)
            Text("Saying whose it is keeps your costs right later, and it stays on this Mac. You can leave it for now.")
                .font(.caption)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .softBox()
    }
}

/// Everything about the send, with Touch ID already asking. Escape goes back to change it.
struct SendConfirmation: View {
    let model: SendModel
    @State var gate: ApprovalPrompt
    let done: () -> Void

    static func gate(for model: SendModel) -> ApprovalPrompt {
        ApprovalPrompt(needsReview: ApprovalPrompt.needsReview, notBefore: { model.nextPromptAt }) { prompt, _ in
            await model.sendConfirmed(in: prompt)
        }
    }

    var body: some View {
        ConfirmationView(asker: .spendingMoney, hero: .amount(model.amountShown ?? "0", symbol: model.token.symbol), worth: model.worthText, rows: rows) {
            if model.stage == .sent || gate.phase == .done {
                ProgressFooter(stage: stage, close: done)
                    // Only once it's landed. Up to then it stays, and there's a way to close it.
                    .task(id: model.landing) {
                        guard model.landing == .landed else { return }
                        try? await Task.sleep(for: Motion.acknowledged)
                        if !Task.isCancelled { done() }
                    }
            } else {
                TouchIDFooter(gate: gate, verb: "send", doing: "Sending…", leaveTitle: "Edit", cancelled: "Touch ID was cancelled, so nothing was sent.") { model.backToEditing() }
            }
        }
        .onExitCommand { if gate.backOut() { model.backToEditing() } }
    }

    private var stage: ProgressFooter.Stage {
        switch model.landing {
        case .onItsWay: .onItsWay
        case .landed: .finished("Sent")
        case .didntLand: .didntLand("This didn't go through")
        }
    }

    private var rows: [ConfirmationRow] {
        var rows: [ConfirmationRow] = []
        if let address = model.recipient {
            rows.append(ConfirmationRow(label: "To", value: address.checksummed, isAddress: true, name: model.recipientName))
        }
        if let fee = model.feeText { rows.append(ConfirmationRow(label: "Network fee", value: "About \(fee)")) }
        return rows
    }
}

/// Moves everything to savings, in one step. It's the same confirmation as any send, because it's the same thing that can't be undone.
struct SweepSheet: View {
    let wallet: HotWallet
    @State var gate: ApprovalPrompt
    /// What Touch ID said yes to. Once it's going, the wallet empties and its own preview would turn into "Everything", so this stays until the sheet closes.
    @State private var approved: SweepPreview?
    @Environment(\.dismiss) private var dismiss

    init(wallet: HotWallet, gate: ApprovalPrompt? = nil) {
        self.wallet = wallet
        _gate = State(initialValue: gate ?? ApprovalPrompt(needsReview: ApprovalPrompt.needsReview, notBefore: { wallet.nextPromptAt }) { prompt, _ in
            await wallet.sweepConfirmed(in: prompt)
        })
    }

    private var destination: ColdWallet? {
        wallet.settings.coldWallets.first { $0.address == wallet.settings.sweepDestination }
    }

    var body: some View {
        ConfirmationView(asker: .spendingMoney, hero: hero, worth: worth, rows: rows) {
            if gate.phase == .done {
                ProgressFooter(stage: sweepStage) { dismiss() }
                    .task(id: landing) {
                        guard landing == .landed else { return }
                        try? await Task.sleep(for: Motion.acknowledged)
                        if !Task.isCancelled { dismiss() }
                    }
            } else {
                TouchIDFooter(gate: gate, verb: "sweep", doing: "Sweeping…", leaveTitle: hasFailed ? "Close" : "Cancel", cancelled: "Touch ID was cancelled, so nothing moved.") { dismiss() }
            }
        }
        .frame(width: 460)
        .interactiveDismissDisabled(wallet.isWorking)
        .onChange(of: gate.phase, initial: true) { _, phase in
            switch phase {
            case .working, .done: if approved == nil { approved = wallet.sweepPreview }
            // Asking again is about what it would move now.
            case .needsReview, .needsAcknowledgment, .waiting, .asking: approved = nil
            case .stopped: break
            }
        }
    }

    private var preview: SweepPreview? {
        approved ?? wallet.sweepPreview
    }

    /// Only what this sweep put on its way. An earlier attempt that didn't go out isn't part of it.
    private var landing: Landing {
        wallet.landing(of: wallet.lastSubmitted)
    }

    private var sweepStage: ProgressFooter.Stage {
        switch landing {
        case .onItsWay: .onItsWay
        case .landed: .finished("Moved to your savings")
        case .didntLand: .didntLand("Some of this didn't go through")
        }
    }

    /// Part of it may have gone by then, and that can't be cancelled.
    private var hasFailed: Bool {
        if case .stopped(.some) = gate.phase { return true }
        return false
    }

    private var hero: ConfirmationHero {
        guard let value = preview?.valueUsdMicros, preview?.transfers.isEmpty == false else { return .words("Everything") }
        return .amount(wallet.money(value), symbol: "")
    }

    /// Exactly what goes, to the last digit, under what it's worth.
    private var worth: String? {
        let transfers = preview?.transfers ?? []
        return transfers.isEmpty ? nil : transfers.map { "\(Money.text(ofUnits: $0.amount, decimals: $0.token.decimals)) \($0.token.symbol)" }.joined(separator: " · ")
    }

    private var rows: [ConfirmationRow] {
        var rows: [ConfirmationRow] = []
        if let destination {
            rows.append(ConfirmationRow(label: "To", value: destination.address.checksummed, isAddress: true, name: destination.name))
        }
        if let preview, !preview.transfers.isEmpty {
            rows.append(ConfirmationRow(label: "Network fee", value: "About \(preview.feeUsdMicros.map(wallet.money) ?? "\(Format.amount(String(preview.feeWei), decimals: 18)) ETH")"))
        }
        return rows
    }
}

enum AddressText {
    /// For a place that moves money, where only an address will do. A payment request also names one, but that's usually a token's contract.
    static func read(_ text: String) -> String? {
        if case .address(let address) = ScannedAddress(text: text) { address.checksummed } else { nil }
    }

    /// For a place that only looks, where one address anywhere in what's pasted is clear enough, like in a link to an explorer's page.
    static func readAnywhere(_ text: String) -> String? {
        WalletAddress.pasted(in: text).flatMap { EthereumAddress($0)?.lowercased }
    }
}
