import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// This Mac's spending money. It's a hot wallet with a cap, and what's above the cap goes to savings by itself.
struct HotWalletWindow: View {
    let wallet: HotWallet
    let store: PortfolioStore
    let siteBridge: SiteBridge
    let navigation: Navigation
    let purchases: PurchaseTracker

    var body: some View {
        Group {
            switch wallet.availability {
            case .notProvisioned:
                ContentUnavailableView {
                    Label("Spending Money Isn't Available", systemImage: "lock.slash")
                } description: {
                    #if DEBUG
                    Text("This build can't reach the device-only Keychain. Sign in to Xcode with your Apple account and run `pnpm mac` again.")
                    #else
                    Text("This copy of \(AppName.current) can't hold a key. Everything else still works.")
                    #endif
                }
            case .unavailable(let message):
                ContentUnavailableView("Can't Open This Wallet", systemImage: "exclamationmark.triangle", description: Text(message))
            case .ready:
                if wallet.address == nil {
                    HotWalletSetup(wallet: wallet, store: store)
                } else {
                    HotWalletDetails(wallet: wallet, store: store, siteBridge: siteBridge, navigation: navigation, purchases: purchases)
                }
            }
        }
        .frame(minWidth: 320, minHeight: 320)
    }
}

/// Says what this is before there's anything to lose.
private struct HotWalletSetup: View {
    let wallet: HotWallet
    let store: PortfolioStore
    @State private var understands = false
    @State private var showsHowItWorks = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "banknote")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                Text("Spending Money")
                    .font(.sheetTitle)
                Text("\(HotWalletWording.summary) Anything above your cap moves to your savings.")
                    .fixedSize(horizontal: false, vertical: true)
                // What can't be undone stays in full, and on screen.
                Notice(.warning, HotWalletWording.cannotBeRestored)
                HStack {
                    Label(HotWalletWording.label, systemImage: "flask")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Button("How It Works", systemImage: "info.circle") { showsHowItWorks.toggle() }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("How it works")
                        .popover(isPresented: $showsHowItWorks, arrowEdge: .bottom) {
                            VStack(alignment: .leading, spacing: 8) {
                                Text(HotWalletWording.sweepsOnlyWhileOpen)
                                Text(HotWalletWording.newDevice)
                            }
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(14)
                            .frame(width: 300)
                        }
                }
                Toggle("I understand this money can't be restored if this Mac is lost", isOn: $understands)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Create Spending Money") {
                    Task {
                        await wallet.createWallet()
                        if let address = wallet.address { store.showNewWallet(address.lowercased) }
                    }
                }
                    .buttonStyle(.borderedProminent)
                    .disabled(!understands || wallet.isWorking)
                if let problem = wallet.sweepProblem {
                    WarningText(problem).font(.callout)
                }
            }
            .padding(24)
            .frame(maxWidth: 480, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
    }
}

private struct HotWalletDetails: View {
    let wallet: HotWallet
    let store: PortfolioStore
    let siteBridge: SiteBridge
    let navigation: Navigation
    let purchases: PurchaseTracker
    @State private var isAddingCold = false
    @State private var isToppingUp = false
    @State private var isSending = false
    /// A new savings wallet to send a little to, once its sheet has gone.
    @State private var testingSavings: EthereumAddress?
    @State private var isSweeping = false
    @State private var isConfirmingRotation = false
    @State private var isConfirmingAbandon = false

    private var address: EthereumAddress? { wallet.address }

    var body: some View {
        Form {
            if let alarm = wallet.alarm {
                Section { alarmBanner(alarm) }
            }
            ForEach(wallet.notices) { notice in
                Notice(notice.kind == .warning ? .warning : .info, notice.text, actionTitle: notice.asksForSavings ? HotWalletWording.addSavingsButton : nil) { isAddingCold = true }
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            balance
            actions
            if !shownPurchases.isEmpty { bought }
            holdings
            if !wallet.unlisted.isEmpty { untouched }
            savings
            if !wallet.connectedSites.isEmpty { sites }
            if !wallet.records.isEmpty { activity }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $isAddingCold, onDismiss: { if testingSavings != nil { isSending = true } }) {
            AddColdWalletSheet(wallet: wallet, navigation: navigation, server: store.serverURL) { testingSavings = $0 }
        }
        .sheet(isPresented: $isToppingUp) { TopUpSheet(wallet: wallet, server: store.serverURL) }
        .onChange(of: navigation.addingSavings, initial: true) { _, link in
            // The sheet takes it from there, and it may already be open, waiting for this.
            if link != nil { isAddingCold = true }
        }
        .onChange(of: navigation.wantsTopUp, initial: true) { _, wants in
            guard wants else { return }
            navigation.wantsTopUp = false
            if wallet.canTopUp { isToppingUp = true }
        }
        .onChange(of: navigation.wantsAddSavings, initial: true) { _, wants in
            guard wants else { return }
            navigation.wantsAddSavings = false
            isAddingCold = true
        }
        .onChange(of: navigation.wantsSend, initial: true) { _, wants in
            guard wants else { return }
            navigation.wantsSend = false
            if wallet.canSend { isSending = true }
        }
        .sheet(isPresented: $isSending, onDismiss: { testingSavings = nil }) {
            SendSheet(model: {
                let model = SendModel(wallet: wallet, store: store)
                model.addressText = testingSavings?.checksummed ?? ""
                return model
            }())
        }
        .sheet(isPresented: $isSweeping) { SweepSheet(wallet: wallet) }
    }

    private func alarmBanner(_ alarm: StolenKeyAlarm) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(HotWalletWording.alarmHeadline, systemImage: "exclamationmark.octagon.fill")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.white)
            Text(HotWalletWording.alarmAdvice)
                .foregroundStyle(.white)
            Text(HotWalletWording.alarm(alarm))
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
                .textSelection(.enabled)
            HStack {
                Button {
                    Task { await wallet.replaceKey() }
                } label: {
                    Text(wallet.settings.sweepDestination == nil ? "Move What's Left to a New Key" : "Sweep What's Left and Replace the Key")
                        .fontWeight(.semibold)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
        
                }
                .buttonStyle(.plain)
                .disabled(wallet.rotation != nil || wallet.isWorking)
                Spacer()
                Button("Dismiss") { wallet.dismissAlarm() }
                    .foregroundStyle(.white)
                    .buttonStyle(.plain)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.red, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    private var balance: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    DisplayNumber(wallet.plan.map { wallet.money($0.valueUsdMicros) } ?? "—", size: 30, tone: wallet.plan?.excessUsdMicros ?? 0 > 0 ? .warning : .neutral)
                    Text("of \(wallet.capText)")
                        .foregroundStyle(.secondary)
                    Spacer()
                    Label(HotWalletWording.label, systemImage: "flask")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                // Only a picture of the numbers above, which are what's real.
                Gauge(value: gaugeValue, in: 0...1) {}
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(wallet.plan?.excessUsdMicros ?? 0 > 0 ? .orange : .accentColor)
                    .accessibilityHidden(true)
                    // So what sweeps away visibly leaves. It follows the number above, which is what's real.
                    .motion(Motion.number, value: gaugeValue)
                if let address {
                    HStack {
                        AddressLine(address.checksummed)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Spacer()
                        CopyButton(title: "Copy", text: address.checksummed, help: "Copy this address")
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                        Button("Show in Overview", systemImage: "chart.xyaxis.line") {
                            store.setWallet(address.lowercased)
                            navigation.section = .overview
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Show its cost and PnL in the main window")
                    }
                }
            }
        }
    }

    private var gaugeValue: Double {
        guard let value = wallet.plan?.valueUsdMicros else { return 0 }
        return min(1, Double(value) / Double(wallet.settings.capUsdMicros))
    }

    private var shownPurchases: [TrackedPurchase] {
        address.map { purchases.purchases(of: $0.lowercased) } ?? []
    }

    private var bought: some View {
        Section("Purchases") {
            if let problem = purchases.problem {
                WarningText(problem).font(.callout)
            }
            ForEach(shownPurchases) { purchase in
                PurchaseRow(purchase: purchase, phase: purchases.phase(of: purchase), main: wallet.display.main) { purchases.dismiss(purchase) }
            }
        }
    }

    private var holdings: some View {
        Section("Holdings") {
            if wallet.holdings.isEmpty {
                Text("Reading…").foregroundStyle(.secondary)
            }
            ForEach(wallet.holdings) { holding in
                LabeledContent(holding.token.symbol) {
                    HStack(spacing: 10) {
                        Text(Format.amount(String(holding.balance), decimals: holding.token.decimals))
                            .monospacedDigit()
                        if let value = holding.valueUsdMicros {
                            Text(wallet.money(value))
                                .monospacedDigit()
                                .foregroundStyle(.secondary)
                                .frame(minWidth: 72, alignment: .trailing)
                        } else {
                            WarningText("No price")
                                .font(.caption)
                                .frame(minWidth: 72, alignment: .trailing)
                        }
                    }
                }
            }
            if let plan = wallet.plan, plan.gasKeptWei > 0 {
                Text(HotWalletWording.keptOutOfCap(plan.gasKeptWei))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var untouched: some View {
        Section {
            ForEach(wallet.unlisted) { token in
                Text(token.token)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        } header: {
            Text("Other Tokens")
        } footer: {
            Text("Not tracked, and never touched. They can be malicious, so don't go looking for what they're worth.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var savings: some View {
        Section {
            if wallet.settings.coldWallets.isEmpty {
                Text("No savings wallet yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(wallet.settings.coldWallets) { cold in
                HStack {
                    Image(systemName: cold.address == wallet.settings.sweepDestination ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(cold.address == wallet.settings.sweepDestination ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                        .contentTransition(.symbolEffect(.replace))
                        .animation(Motion.state, value: wallet.settings.sweepDestination)
                    VStack(alignment: .leading) {
                        Text(cold.name)
                        AddressLine(cold.address.checksummed)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    Spacer()
                    Button("Show in Overview", systemImage: "chart.xyaxis.line") {
                        store.setWallet(cold.address.lowercased)
                        navigation.section = .overview
                    }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Show its cost and PnL in the main window")
                    Button("Remove", systemImage: "minus.circle") { wallet.removeColdWallet(cold.address) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Remove this wallet")
                }
                .contentShape(Rectangle())
                .onTapGesture { wallet.setSweepDestination(cold.address) }
                .accessibilityAddTraits(cold.address == wallet.settings.sweepDestination ? .isSelected : [])
            }
            Button(HotWalletWording.addSavingsButton, systemImage: "plus") { isAddingCold = true }
        } header: {
            Text("Savings")
        } footer: {
            if !wallet.settings.coldWallets.isEmpty {
                Text("Sweeps go to the checked one.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var sites: some View {
        Section {
            ForEach(wallet.connectedSites, id: \.self) { origin in
                LabeledContent(siteName(origin)) {
                    Button("Disconnect") { siteBridge.disconnect(origin) }
                        .buttonStyle(.borderless)
                }
            }
        } header: {
            Text("Connected Sites")
        } footer: {
            Text("Disconnecting doesn't undo token approvals you already gave them.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var actions: some View {
        Section {
            ViewThatFits(in: .horizontal) {
                HStack {
                    send
                    buy
                    topUp
                    sweep
                    Spacer()
                    replaceKey
                }
                VStack(alignment: .leading) {
                    HStack {
                        send
                        buy
                        topUp
                    }
                    HStack {
                        sweep
                        replaceKey
                    }
                }
                VStack(alignment: .leading) {
                    send
                    buy
                    topUp
                    sweep
                    replaceKey
                }
            }
            if wallet.canLeaveOldKeyBehind {
                Button("Delete the Old Key and Leave What's on It…", role: .destructive) { isConfirmingAbandon = true }
            }
        }
        .confirmationDialog("Replace this wallet's key?", isPresented: $isConfirmingRotation) {
            Button("Replace Key") { Task { await wallet.replaceKey() } }
            if wallet.settings.sweepDestination != nil {
                Button("Sweep Everything to Savings Instead") { isSweeping = true }
            }
        } message: {
            Text("Makes a new key, moves every token this app tracks to it, then deletes the old one. If the old key holds other tokens, or some that gas makes too costly to move, it stays until you choose to leave them. This costs gas, and publicly links the two addresses. It also clears any token approvals the old key gave.")
        }
        .confirmationDialog("Delete the old key?", isPresented: $isConfirmingAbandon) {
            Button("Delete and Leave It Behind", role: .destructive) { Task { await wallet.finishRotationLeavingFundsBehind() } }
        } message: {
            Text(abandonMessage)
        }
    }

    private var send: some View {
        Button("Send…") { isSending = true }
            .buttonStyle(.borderedProminent)
            .disabled(!wallet.canSend)
    }

    private var buy: some View {
        Button("Buy…") { navigation.isBuying = true }
            .disabled(!wallet.canTopUp)
    }

    private var topUp: some View {
        Button("\(HotWalletWording.topUpTitle(hasDestination: wallet.settings.sweepDestination != nil))…") { isToppingUp = true }
            .disabled(!wallet.canTopUp)
    }

    private var sweep: some View {
        Button("Sweep Everything…") { isSweeping = true }
            .disabled(wallet.settings.sweepDestination == nil || wallet.isWorking || wallet.isKeyMissing)
            .help(wallet.settings.sweepDestination == nil ? "Add a savings wallet first" : "Move everything on this wallet to your savings. \(HotWalletWording.newDevice)")
    }

    private var replaceKey: some View {
        Button("Replace Key…") { isConfirmingRotation = true }
            .disabled(wallet.rotation != nil || wallet.isWorking || wallet.isKeyMissing)
    }

    private var abandonMessage: String {
        let lost = "What's still on the old address can never be moved again."
        if wallet.isKeyMissing { return "This device no longer has it. \(lost)" }
        return switch wallet.rotationHold {
        case .otherTokens(let count): "It holds \(count) \(count == 1 ? "token" : "tokens") this app doesn't track. \(lost)"
        case .cantCheckOtherTokens: "This app can't check right now whether it holds other tokens. \(lost)"
        case .notWorthTheGas(let symbols): "It holds \(HotWalletWording.tooCostlyToMove(symbols)). \(lost)"
        case .notEnoughGas, nil: "It holds tokens with no ETH to move them. \(lost)"
        }
    }

    private var activity: some View {
        Section("Signed by This Mac") {
            ForEach(wallet.records) { record in
                HStack {
                    VStack(alignment: .leading) {
                        Text(record.reason == .note ? "What you paid for \(record.symbol)" : "\(Format.amount(record.amount, decimals: record.decimals)) \(record.symbol)")
                            .monospacedDigit()
                        Text("\(reasonText(record)) · \(Format.time(record.createdAt))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    RecordStatus(status: record.status, text: statusText(record))
                    if let url = URL(string: "https://basescan.org/tx/\(record.hash)") {
                        Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                            .foregroundStyle(.secondary)
                            .help("Open this transaction")
                    }
                }
            }
        }
    }

    private func reasonText(_ record: SignedRecord) -> String {
        switch record.reason {
        case .aboveCap: record.gainUsdMicros == "0" ? "Above the cap" : "Above the cap or realized gains"
        case .manual: "Swept by you"
        case .rotation: "Replacing the key"
        case .site: record.site.map(siteName) ?? "A site"
        case .sent: "Sent to \(Format.shortHash(record.to.checksummed))"
        case .note: "Published for anyone to read"
        }
    }

    private func statusText(_ record: SignedRecord) -> String {
        switch record.status {
        case .pending: "On its way"
        case .confirmed: "Done"
        case .failed: "Failed"
        case .dropped: "Never landed"
        }
    }
}

/// How one signed transaction is doing. The check draws in when its receipt arrives, and one that had already landed just shows it.
private struct RecordStatus: View {
    let status: SignedRecord.Status
    let text: String

    var body: some View {
        HStack(spacing: 5) {
            switch status {
            case .pending:
                ProgressView().controlSize(.mini)
            case .confirmed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(Tone.gain.style)
                    .transition(.symbolEffect(.drawOn))
            case .failed, .dropped:
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(Tone.warning.style)
            }
            Text(text)
                .contentTransition(.opacity)
                .foregroundStyle(status == .failed || status == .dropped ? Tone.warning.style : AnyShapeStyle(.secondary))
        }
        .font(.caption)
        .animation(Motion.state, value: status)
    }
}

/// The Mac app has no device code, so this picks the amount, and the web app's device flow does the rest. The steps by hand are there for when that can't.
struct TopUpSheet: View {
    let wallet: HotWallet
    let server: URL
    let browsers: DeviceBrowsers
    @Environment(\.dismiss) private var dismiss
    @State private var dollars = 0.0
    @State private var found = LedgerBrowserChoice.unknown

    init(wallet: HotWallet, server: URL, browsers: DeviceBrowsers = .real) {
        self.wallet = wallet
        self.server = server
        self.browsers = browsers
    }

    private var room: Int { Int(wallet.topUpRoom / Money.dollar) }
    private var hasDestination: Bool { wallet.settings.sweepDestination != nil }

    private var deviceLink: URL? {
        wallet.address.flatMap { DeviceFlow.topUp(server: server, to: $0.checksummed, dollars: Int(dollars)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(HotWalletWording.topUpTitle(hasDestination: hasDestination))
                .font(.sheetTitle)
            if room < 1 {
                Notice(.info, HotWalletWording.topUpAtCap(wallet.capText, hasDestination: hasDestination))
            } else {
                LabeledContent("Amount") {
                    HStack {
                        // A slider needs two ends, and with room for one dollar, the other end is too much.
                        Slider(value: $dollars, in: 1...Double(max(room, 2)), step: 1)
                            .disabled(room < 2)
                        Text(amountText)
                            .monospacedDigit()
                            .frame(width: 56, alignment: .trailing)
                    }
                }
                Text(HotWalletWording.topUpRoom(wallet.money(wallet.topUpRoom), hasDestination: hasDestination))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if let deviceLink {
                    DeviceBrowserNote(choice: found, outcome: "your hardware wallet signs the transfer.") { open(deviceLink, in: nil) }
                }
                DisclosureGroup("Or do it by hand on the device") {
                    VStack(alignment: .leading, spacing: 8) {
                        Label("Choose Send, on Base", systemImage: "1.circle")
                        Label("Enter about \(amountText) of ETH or USDC\(tokenHint)", systemImage: "2.circle")
                        Label("Send it to this address", systemImage: "3.circle")
                        if let address = wallet.address {
                            AddressLine(address.checksummed)
                                .font(.callout)
                                .textSelection(.enabled)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                        }
                        Label("Check the address on the device's screen before you confirm", systemImage: "4.circle")
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
                }
                if wallet.holdings.first(where: { $0.token.isNative })?.balance ?? 0 < SweepPlanner.minimumGasReserveWei {
                    Notice(.warning, HotWalletWording.topUpNeedsGas(hasDestination: hasDestination))
                }
            }
            HStack {
                Spacer()
                if let address = wallet.address, room >= 1 {
                    CopyButton(title: "Copy Address", text: address.checksummed)
                        .labelStyle(.titleOnly)
                }
                Button(room >= 1 ? "Cancel" : "Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if room >= 1, let deviceLink {
                    Button(found.continueTitle) { open(deviceLink, in: found.browser) }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { dollars = Double(max(1, min(room, 20))) }
        // A read can leave less room than there was when this opened. What's chosen stays if it still fits.
        .onChange(of: room) { dollars = min(dollars, Double(max(room, 1))) }
        .findingBrowsers(browsers, $found)
    }

    private func open(_ link: URL, in browser: InstalledBrowser?) {
        browsers.open(link, browser)
        dismiss()
    }

    /// Rounded down, so it can't read as more than the room it's measured against.
    private var amountText: String {
        wallet.display.whole(UInt128(dollars) * Money.dollar, rounding: .down)
    }

    /// What that is in each token. USDC is worth a dollar, so it only needs saying when what's shown isn't in dollars of that kind.
    private var tokenHint: String {
        var tokens: [String] = []
        if let price = wallet.snapshot?.ethUsdMicros {
            let amount = Money.amount(ofUsdMicros: UInt128(dollars) * Money.dollar, priceMicros: price, decimals: 18)
            tokens.append("\(Format.amount(String(amount), decimals: 18)) ETH")
        }
        if wallet.display.isConverted { tokens.append("\(Int(dollars)) USDC") }
        return tokens.isEmpty ? "" : " (about \(tokens.joined(separator: " or ")))"
    }
}
