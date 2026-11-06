import HotWalletKit
import KeyVault
import LocalAuthentication
import PricetagKit
import SwiftUI

/// What this Mac can say about itself. Only what's been checked is ever true or false, and anything else is nil.
struct MacBasics: Equatable, Sendable {
    var hasPassword: Bool?
    var fileVaultOn: Bool?

    /// Reads them for real. A password is what Touch ID falls back on, so its policy says whether there is one. FileVault is what
    /// `fdesetup` says, and nothing at all if it can't run here.
    static func read() async -> MacBasics {
        var error: NSError?
        let canAuthenticate = LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        let hasPassword: Bool? = canAuthenticate ? true : (error?.code == LAError.passcodeNotSet.rawValue ? false : nil)
        return MacBasics(hasPassword: hasPassword, fileVaultOn: await fileVault())
    }

    private static func fileVault() async -> Bool? {
        await Task.detached {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/fdesetup")
            process.arguments = ["isactive"]
            let output = Pipe()
            process.standardOutput = output
            process.standardError = Pipe()
            do {
                try process.run()
            } catch {
                return nil
            }
            process.waitUntilExit()
            let text = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
            // It exits with 0 and says true when it's on, and 1 and says false when it's off. Anything else isn't an answer.
            if process.terminationStatus == 0, text == "true" { return true }
            if process.terminationStatus == 1, text == "false" { return false }
            return nil
        }.value
    }
}

/// Good habits, checked where the app can know, and every approval the wallet showing has given, with a way to take them back.
struct SecurityPage: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    var readBasics: () async -> MacBasics = MacBasics.read
    /// For scenes, which show a state without reading anything.
    var approvalsModel: ApprovalsModel?
    @State private var model: ApprovalsModel?
    @State private var basics = MacBasics()
    @State private var selection: Set<String> = []
    @State private var revoking: [Revocation] = []
    @State private var showsSource = false

    private var entry: WalletEntry? { store.walletList(hotWallet: hotWallet).entry(for: store.address) }

    /// Only Spending Money signs here, and only while it can send.
    private var canRevoke: Bool {
        guard let address = hotWallet.address, hotWallet.canSend else { return false }
        return store.address == address.lowercased && model?.address == address.lowercased
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 22) {
                checklist
                if let entry { approvals(entry) }
                unlisted
                tips
            }
            .frame(maxWidth: 820, alignment: .leading)
            .padding(20)
            .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
        .task { basics = await readBasics() }
        .task(id: store.address) {
            selection = []
            guard let address = store.address else {
                model = nil
                return
            }
            let next = approvalsModel ?? ApprovalsModel(address: address) { [store] in try await store.approvals(address: $0) }
            model = next
            if approvalsModel == nil { await next.load() }
        }
        .sheet(isPresented: Binding(get: { !revoking.isEmpty }, set: { if !$0 { revoking = [] } })) {
            RevokeSheet(wallet: hotWallet, revocations: revoking) { landed in
                if landed { selection.subtract(revoking.map(\.id)) }
                Task { await reloadAfterRevoking() }
            }
        }
    }

    /// Amp has to reach the block first, so it's read once now and again a little later.
    private func reloadAfterRevoking() async {
        await model?.load()
        try? await Task.sleep(for: .seconds(6))
        await model?.load()
    }

    // MARK: - Checklist

    private var facts: SecurityFacts {
        let hasSpendingMoney = hotWallet.availability == .ready && hotWallet.address != nil
        return SecurityFacts(
            hasSpendingMoney: hasSpendingMoney,
            savingsWallets: hotWallet.settings.coldWallets.count,
            capUsdMicros: hotWallet.settings.capUsdMicros,
            capText: hotWallet.capText,
            alarm: hotWallet.alarmFact,
            connectedSites: hotWallet.connectedSites.count,
            walletTitle: entry?.title,
            unlimitedApprovals: model?.approvals?.unlimitedCount,
            approvalsFailed: { if case .failed = model?.state { true } else { false } }(),
            approvalsUnreadable: model?.approvals?.unreadable ?? 0,
            approvalsStale: model?.refreshFailure != nil,
            hasPassword: basics.hasPassword,
            fileVaultOn: basics.fileVaultOn
        )
    }

    private var checklist: some View {
        let checks = SecurityChecklist.checks(facts)
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Good Habits").font(.headline)
                Spacer()
                Text("\(checks.count { $0.status == .done }) of \(checks.count) in place")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            SecurityGroup {
                ForEach(Array(checks.enumerated()), id: \.element.id) { index, check in
                    if index > 0 { Divider() }
                    CheckRow(check: check) { fix(check.fix) }
                }
            }
        }
    }

    private func fix(_ fix: SecurityCheck.Fix?) {
        switch fix {
        case .addSavings: navigation.addSavings()
        case .changeCap, .showSpendingMoney, .reviewSites: navigation.showSpendingMoney()
        case .openSettings(let pane): NSWorkspace.shared.open(pane.url)
        case nil: break
        }
    }

    // MARK: - Approvals

    @ViewBuilder
    private func approvals(_ entry: WalletEntry) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("Approvals").font(.headline)
                Text(entry.title)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Spacer(minLength: 8)
                if model?.isRefreshing == true, model?.approvals != nil {
                    ProgressView().controlSize(.small)
                }
                if canRevoke, !selection.isEmpty {
                    Button("Revoke \(selection.count)…") { revoking = selected }
                        .disabled(selection.count > RevocationPlanner.maximum || hotWallet.isWorking)
                        .help(selection.count > RevocationPlanner.maximum ? "Up to \(RevocationPlanner.maximum) at once" : "Take these back")
                }
                Button("Check Again", systemImage: "arrow.clockwise") { Task { await model?.load() } }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help("Check again")
                    .disabled(model?.isRefreshing ?? true)
            }
            Text(Self.whatApprovalsAre)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let note = readOnlyNote(entry) {
                Notice(.info, note)
            }
            switch model?.state {
            case .read(let read):
                if let failure = model?.refreshFailure {
                    Notice(.warning, "Couldn't check again: \(failure) This list is from block \(Format.block(read.checkedAt.blockNum)), and may be out of date.", actionTitle: "Try Again") { Task { await model?.load() } }
                }
                list(read, entry: entry)
                    .opacity(model?.refreshFailure == nil ? 1 : 0.6)
            case .failed(let message):
                SecurityGroup {
                    HStack {
                        WarningText(message)
                        Spacer()
                        Button("Try Again") { Task { await model?.load() } }
                    }
                }
            case .reading, nil:
                SecurityGroup {
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("Reading this wallet's approvals from Amp…").foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    static let whatApprovalsAre = "An approval lets an app move a token out of this wallet without asking again. Revoke the ones you don't use."

    private var selected: [Revocation] {
        (model?.approvals?.approvals ?? []).filter { selection.contains($0.id) }.compactMap(Revocation.init)
    }

    private func readOnlyNote(_ entry: WalletEntry) -> String? {
        switch entry.kind {
        case .spendingMoney: hotWallet.canSend ? nil : "\(HotWalletWording.title) can't sign right now, so these can't be revoked from here."
        case .savings: nil
        case .yours: "This wallet's key isn't in \(AppName.current), so revoke these from the wallet that holds it."
        case .watching: "You're watching this wallet, so this list is only to look at."
        case .demo: "This is the demo wallet, so these are made up, and there's nothing to revoke."
        }
    }

    @ViewBuilder
    private func list(_ read: WalletApprovals, entry: WalletEntry) -> some View {
        if entry.kind == .savings {
            savingsNote(read)
        }
        SecurityGroup {
            if read.approvals.isEmpty {
                Label(read.unreadable == 0 ? "No approvals found." : "None that could be read.", systemImage: "checkmark.seal")
                    .foregroundStyle(.secondary)
            }
            ForEach(Array(read.approvals.enumerated()), id: \.element.id) { index, approval in
                if index > 0 { Divider() }
                let revocation = Revocation(approval)
                ApprovalRow(
                    approval: approval,
                    canRevokeHere: canRevoke,
                    isSelected: canRevoke && revocation != nil ? Binding(get: { selection.contains(approval.id) }, set: { if $0 { selection.insert(approval.id) } else { selection.remove(approval.id) } }) : nil,
                    revoke: canRevoke ? revocation.map { revocation in { revoking = [revocation] } } : nil
                )
            }
            if read.unreadable > 0 {
                Divider()
                WarningText("\(read.unreadable) more in this wallet's history didn't answer, so what they allow isn't known.")
                    .font(.callout)
            }
        }
        if canRevoke, read.approvals.count > 1 {
            HStack {
                let revocable = Set(read.approvals.filter { Revocation($0) != nil }.map(\.id))
                Button(selection == revocable ? "Select None" : "Select All") {
                    selection = selection == revocable ? [] : revocable
                }
                .disabled(revocable.isEmpty)
                .buttonStyle(.link)
                Spacer()
            }
            .font(.callout)
        }
        sourceBox(read)
    }

    @ViewBuilder
    private func savingsNote(_ read: WalletApprovals) -> some View {
        if read.approvals.isEmpty {
            Notice(.info, "Savings wallets never sign approvals in \(AppName.current), so none is what you'd expect.")
        } else {
            Notice(.warning, "Savings wallets never sign approvals in \(AppName.current), so these are from before. To revoke them, connect this wallet's device to a browser wallet and revoke them there. \(AppName.current) only ever uses it for plain transfers.")
        }
    }

    /// Like a price's proof: where the list was found, and when it was checked.
    private func sourceBox(_ read: WalletApprovals) -> some View {
        DisclosureGroup("Where this list comes from", isExpanded: $showsSource) {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(read.source, id: \.self) { line in
                    Text(line).fixedSize(horizontal: false, vertical: true)
                }
                if read.history.fromBlock > 0, read.mode != .demo {
                    Text("An approval to another app from before block \(Format.block(read.history.fromBlock)) wouldn't be found.")
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
        .font(.caption)
        .padding(10)
        .background(.quaternary.opacity(0.4), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
    }

    // MARK: - What no one can list

    private var unlisted: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("What No One Can List").font(.headline)
            SecurityGroup {
                Text("A permit you signed that hasn't been used yet isn't onchain, so no app can find it, \(AppName.current) included. Once it's used, some permits set an approval, and others move the tokens right away.")
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 6) {
                    Label("Only sign permits on sites you trust. \(AppName.current) shows what one allows before you sign it.", systemImage: "signature")
                    Label("Revoking a token's approval for Permit2 stops any Permit2 signature from moving that token, but only while it stays revoked. Approving Permit2 again lets a signature that hasn't expired work again.", systemImage: "xmark.seal")
                    Label("Moving the token to another of your wallets is the only sure way to stop a permit you signed.", systemImage: "arrow.right.circle")
                }
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: - Tips

    private var tips: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tips").font(.headline)
            SecurityGroup {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(Self.tips, id: \.text) { tip in
                        Label(tip.text, systemImage: tip.symbol)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
    }

    static let tips: [(symbol: String, text: String)] = [
        ("doc.text", "Keep your recovery phrase on paper or metal, somewhere safe. Never type it into a computer or phone, or photograph it. \(AppName.current) will never ask for it, and nobody you can trust will."),
        ("checkmark.shield", "Check every address on your device's screen before you confirm, since a page can show the wrong one."),
        ("bookmark", "Go to sites from your bookmarks, not from links in messages, ads or search results."),
        ("arrow.triangle.2.circlepath", "Keep macOS and your device's firmware up to date."),
    ]
}

/// A rounded group, as the rest of the app's pages have them.
private struct SecurityGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

private struct CheckRow: View {
    let check: SecurityCheck
    let fix: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            icon
            VStack(alignment: .leading, spacing: 2) {
                Text(check.title)
                Text(check.detail)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if let title = fixTitle {
                Button(title, action: fix)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var icon: some View {
        Group {
            switch check.status {
            case .done: Image(systemName: "checkmark.circle.fill").foregroundStyle(Tone.gain.style)
            case .todo: Image(systemName: "circle").foregroundStyle(Tone.warning.style)
            case .unknown: Image(systemName: "questionmark.circle").foregroundStyle(.tertiary)
            }
        }
        .accessibilityLabel(check.status == .done ? "Done" : check.status == .todo ? "To do" : "Couldn't check")
    }

    private var fixTitle: String? {
        switch check.fix {
        case .addSavings: "\(HotWalletWording.addSavingsButton)…"
        case .changeCap: "Change Cap…"
        case .showSpendingMoney: "Show"
        case .reviewSites: check.status == .done ? "Review" : "Review Sites…"
        case .openSettings: check.status == .todo || check.status == .unknown ? "Open Settings" : nil
        case nil: nil
        }
    }
}

/// One approval: what can be taken, by whom, and how much.
private struct ApprovalRow: View {
    let approval: TokenApproval
    /// The wallet can revoke here, whether or not this one can be.
    let canRevokeHere: Bool
    /// Nil when this one can't be revoked here.
    let isSelected: Binding<Bool>?
    let revoke: (() -> Void)?

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            if canRevokeHere {
                Toggle("Select", isOn: isSelected ?? .constant(false))
                    .labelsHidden()
                    .toggleStyle(.checkbox)
                    .disabled(isSelected == nil)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(ApprovalWording.what(approval))
                    .lineLimit(1)
                HStack(spacing: 4) {
                    Text(ApprovalWording.who(approval))
                        .foregroundStyle(approval.spenderName == nil ? Tone.warning.style : AnyShapeStyle(.secondary))
                    Text("· \(Format.shortHash(approval.spender))")
                        .foregroundStyle(.secondary)
                        .help(approval.spender)
                    CopyButton(title: "Copy", text: approval.spender, help: "Copy this app's address")
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                }
                .font(.callout)
                .lineLimit(1)
                Text(ApprovalWording.when(approval))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(ApprovalWording.amount(approval))
                .monospacedDigit()
                .foregroundStyle(approval.unlimited ? Tone.warning.style : AnyShapeStyle(.primary))
                .fontWeight(approval.unlimited ? .semibold : .regular)
            if let tx = approval.grantedTx, let url = URL(string: "https://basescan.org/tx/\(tx)") {
                Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                    .foregroundStyle(.secondary)
                    .help("Open the transaction that gave it")
            }
            if let revoke {
                Button("Revoke…", action: revoke)
            } else if canRevokeHere {
                Text("Revoke elsewhere")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .help("\(AppName.current) never calls a contract it doesn't track, so revoke this one from another wallet app.")
            }
        }
    }
}

/// How an approval reads. A token off the list is never named, because it can call itself anything.
enum ApprovalWording {
    static func what(_ approval: TokenApproval) -> String {
        let token = approval.symbol ?? "Token \(Format.shortHash(approval.token))"
        return switch approval.kind {
        case .token: token
        case .permit2: "\(token), through Permit2"
        case .collection: "Every NFT in \(Format.shortHash(approval.token))"
        }
    }

    static func who(_ approval: TokenApproval) -> String {
        approval.spenderName ?? "Unknown app"
    }

    static func amount(_ approval: TokenApproval) -> String {
        if approval.kind == .collection { return "All of them" }
        if approval.unlimited { return "Unlimited" }
        return approval.amountText ?? "Some"
    }

    static func when(_ approval: TokenApproval) -> String {
        var parts: [String] = []
        if let date = approval.grantedDate {
            parts.append("Given \(date.formatted(.dateTime.month(.abbreviated).day()))")
        } else if approval.found == .knownSpender {
            parts.append("Given before this history starts")
        }
        if let expiry = approval.expiry {
            parts.append("Until \(expiry.formatted(.dateTime.month(.abbreviated).day()))")
        }
        return parts.joined(separator: " · ")
    }
}
