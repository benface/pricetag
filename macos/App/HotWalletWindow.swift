import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// This Mac's spending money on its own: the page around a wallet's numbers, or what to say when there's no wallet to show.
struct HotWalletWindow: View {
    let wallet: HotWallet
    let store: PortfolioStore
    let siteBridge: SiteBridge
    let navigation: Navigation
    let purchases: PurchaseTracker

    var body: some View {
        if wallet.availability == .ready, wallet.address != nil {
            ScrollView {
                HotWalletDetails(wallet: wallet, store: store, siteBridge: siteBridge, navigation: navigation, purchases: purchases, showsHoldings: true) { EmptyView() }
                    .padding(20)
            }
        } else {
            SpendingMoneySetup(wallet: wallet, store: store)
                .frame(minWidth: 320, minHeight: 320)
        }
    }
}

/// There's no Spending Money to show. It can't be selected in the list, so this is a sheet.
struct SpendingMoneySetup: View {
    let wallet: HotWallet
    let store: PortfolioStore
    var onDone: (() -> Void)?

    var body: some View {
        VStack(spacing: 0) {
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
                HotWalletSetup(wallet: wallet, store: store, onDone: onDone)
            }
            if let onDone {
                HStack {
                    Spacer()
                    Button("Cancel", action: onDone)
                        .keyboardShortcut(.cancelAction)
                }
                .padding([.horizontal, .bottom], 16)
            }
        }
    }
}

/// Says what this is before there's anything to lose.
private struct HotWalletSetup: View {
    let wallet: HotWallet
    let store: PortfolioStore
    var onDone: (() -> Void)?
    @State private var understands = false
    @State private var showsHowItWorks = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Image(systemName: "banknote")
                    .font(.system(size: 30))
                    .foregroundStyle(.secondary)
                Text("Spending Money")
                    .font(.title2.bold())
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
                        // It's what they asked for, so it's what they see next.
                        guard let address = wallet.address else { return }
                        store.setWallet(address.lowercased)
                        onDone?()
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

/// What only spending money has, around the numbers any wallet has. `overview` goes in the middle, so its actions are in view above them.
struct HotWalletDetails<Overview: View>: View {
    let wallet: HotWallet
    let store: PortfolioStore
    let siteBridge: SiteBridge
    let navigation: Navigation
    let purchases: PurchaseTracker
    /// Once the overview has holdings, these would only say the same thing again.
    let showsHoldings: Bool
    @ViewBuilder let overview: Overview
    @State private var isAddingCold = false
    @State private var isToppingUp = false
    @State private var isSending = false
    /// A new savings wallet to send a little to, once its sheet has gone.
    @State private var testingSavings: EthereumAddress?
    @State private var isSweeping = false
    @State private var isConfirmingRotation = false
    @State private var isConfirmingAbandon = false
    @State private var isChangingCap = false

    private var address: EthereumAddress? { wallet.address }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let alarm = wallet.alarm { alarmBanner(alarm) }
            ForEach(wallet.notices) { notice in
                Notice(notice.kind == .warning ? .warning : .info, notice.text, actionTitle: notice.asksForSavings ? HotWalletWording.addSavingsButton : nil) { isAddingCold = true }
            }
            card
            if !shownPurchases.isEmpty { bought }
            overview
            if showsHoldings { holdings }
            if !wallet.unlisted.isEmpty { untouched }
            savings
            if !wallet.connectedSites.isEmpty { sites }
            if !wallet.records.isEmpty { activity }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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
                .font(.title3.bold())
                .foregroundStyle(.white)
            Text(HotWalletWording.alarmAdvice)
                .foregroundStyle(.white)
            Text(HotWalletWording.alarm(alarm))
                .font(.caption)
                .foregroundStyle(.white.opacity(0.85))
                .textSelection(.enabled)
            HStack {
                // Its own colors rather than a tint, which fades into the banner when the window isn't in front. An alarm usually finds it that way.
                Button {
                    Task { await wallet.replaceKey() }
                } label: {
                    Text(wallet.settings.sweepDestination == nil ? "Move What's Left to a New Key" : "Sweep What's Left and Replace the Key")
                        .fontWeight(.semibold)
                        .foregroundStyle(.black)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(.white, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
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
    }

    /// How close to the cap this is, and what can be done about it. It works from what this Mac reads by itself, so it's here even when the server isn't.
    private var card: some View {
        DetailsGroup {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .firstTextBaseline) {
                    LiveNumber(wallet.plan.map { wallet.money($0.valueUsdMicros) } ?? "—", tone: wallet.plan?.excessUsdMicros ?? 0 > 0 ? .warning : .neutral)
                        .font(.title3.weight(.semibold))
                    Button("of \(wallet.capText)") { isChangingCap.toggle() }
                        .buttonStyle(.link)
                        .help("Change the cap")
                        .popover(isPresented: $isChangingCap, arrowEdge: .bottom) { capEditor }
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
                if let plan = wallet.plan, plan.gasKeptWei > 0 {
                    Text(HotWalletWording.keptOutOfCap(plan.gasKeptWei))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let address {
                    HStack {
                        Text(address.checksummed)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Button("Copy", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(address.checksummed, forType: .string)
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Copy this address")
                    }
                }
                actions
            }
        }
    }

    private var capEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            LabeledContent("Cap") {
                HStack {
                    Slider(value: Binding(get: { Double(wallet.settings.capInDollars) }, set: { wallet.setCap(dollars: Int($0)) }), in: 1...Double(wallet.settings.capCeiling / Money.dollar))
                    Text(wallet.money(dollars: wallet.settings.capInDollars))
                        .monospacedDigit()
                        .frame(width: 56, alignment: .trailing)
                }
            }
            Text("Anything above it moves to your savings.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(14)
        .frame(width: 320)
    }

    private var gaugeValue: Double {
        guard let value = wallet.plan?.valueUsdMicros else { return 0 }
        return min(1, Double(value) / Double(wallet.settings.capUsdMicros))
    }

    private var shownPurchases: [TrackedPurchase] {
        address.map { purchases.purchases(of: $0.lowercased) } ?? []
    }

    private var bought: some View {
        DetailsSection("Purchases") {
            if let problem = purchases.problem {
                WarningText(problem).font(.callout)
            }
            ForEach(shownPurchases) { purchase in
                PurchaseRow(purchase: purchase, phase: purchases.phase(of: purchase), main: wallet.display.main) { purchases.dismiss(purchase) }
            }
        }
    }

    private var holdings: some View {
        DetailsSection("Holdings") {
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
        }
    }

    private var untouched: some View {
        DetailsSection("Other Tokens", footer: "Not tracked, and never touched. They can be malicious, so don't go looking for what they're worth.") {
            ForEach(wallet.unlisted) { token in
                Text(token.token)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }

    private var savings: some View {
        DetailsSection("Savings", footer: wallet.settings.coldWallets.isEmpty ? nil : "Sweeps go to the checked one.") {
            if wallet.settings.coldWallets.isEmpty {
                Text("No savings wallet yet.")
                    .foregroundStyle(.secondary)
            }
            ForEach(wallet.settings.coldWallets) { cold in
                HStack {
                    Image(systemName: cold.address == wallet.settings.sweepDestination ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(cold.address == wallet.settings.sweepDestination ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    VStack(alignment: .leading) {
                        Text(cold.name)
                        Text(cold.address.checksummed)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    Spacer()
                    Button("Show This Wallet", systemImage: "chart.xyaxis.line") { store.setWallet(cold.address.lowercased) }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Show its cost and PnL")
                    Button("Remove from Savings…", systemImage: "minus.circle") {
                        navigation.removingFromSavings = WalletEntry(address: cold.address.lowercased, name: cold.name, kind: .savings)
                    }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help("Remove from savings")
                    .disabled(wallet.isWorking)
                }
                .contentShape(Rectangle())
                .onTapGesture { wallet.setSweepDestination(cold.address) }
                .accessibilityAddTraits(cold.address == wallet.settings.sweepDestination ? .isSelected : [])
            }
            Button(HotWalletWording.addSavingsButton, systemImage: "plus") { isAddingCold = true }
        }
    }

    private var sites: some View {
        DetailsSection("Connected Sites", footer: "Disconnecting doesn't undo token approvals you already gave them.") {
            ForEach(wallet.connectedSites, id: \.self) { origin in
                LabeledContent(siteName(origin)) {
                    Button("Disconnect") { siteBridge.disconnect(origin) }
                        .buttonStyle(.borderless)
                }
            }
        }
    }

    private var actions: some View {
        Group {
            ViewThatFits(in: .horizontal) {
                HStack {
                    send
                    topUp
                    sweep
                    Spacer()
                    replaceKey
                }
                VStack(alignment: .leading) {
                    HStack {
                        send
                        topUp
                    }
                    HStack {
                        sweep
                        replaceKey
                    }
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
        DetailsSection("Signed by This Mac") {
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
                    Text(statusText(record))
                        .font(.caption)
                        .foregroundStyle(record.status == .failed || record.status == .dropped ? Tone.warning.style : AnyShapeStyle(.secondary))
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

/// A rounded group, like a row of a form, for a page that scrolls with the rest of a wallet's numbers.
private struct DetailsGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .labeledContentStyle(DetailsRowStyle())
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }
}

/// As a form lays one out, with its value at the far end. Outside a form, the two would sit side by side.
private struct DetailsRowStyle: LabeledContentStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack {
            configuration.label
            Spacer()
            configuration.content
        }
    }
}

private struct DetailsSection<Content: View>: View {
    let title: String
    let footer: String?
    @ViewBuilder let content: Content

    init(_ title: String, footer: String? = nil, @ViewBuilder content: () -> Content) {
        self.title = title
        self.footer = footer
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            DetailsGroup { content }
            if let footer {
                Text(footer)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
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
                .font(.title2.bold())
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
                            Text(address.checksummed)
                                .font(.callout.monospaced())
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
                    Button("Copy Address") {
                        NSPasteboard.general.clearContents()
                        NSPasteboard.general.setString(address.checksummed, forType: .string)
                    }
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
