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
    /// What a test scene has typed for the network.
    var rpc = ""
    var rpcError: String?

    var body: some View {
        if wallet.availability == .ready, wallet.address != nil {
            ScrollView {
                HotWalletDetails(wallet: wallet, store: store, siteBridge: siteBridge, navigation: navigation, purchases: purchases, showsHoldings: true, overview: { EmptyView() }, rpc: rpc, rpcError: rpcError)
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
                    .accessibilityHidden(true)
                Text("Spending Money")
                    .font(.sheetTitle)
                    .accessibilityAddTraits(.isHeader)
                Text("\(HotWalletWording.summary) Anything above your cap moves to your savings.")
                    .fixedSize(horizontal: false, vertical: true)
                // What can't be undone stays in full, and on screen.
                Notice(.warning, HotWalletWording.cannotBeRestored)
                Button("How It Works", systemImage: "info.circle") { showsHowItWorks.toggle() }
                    .buttonStyle(.borderless)
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
                    .keyboardShortcut(.defaultAction)
                    .disabled(!understands || wallet.isWorking)
                if let problem = wallet.lastActionProblem {
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
    /// What's typed for the network, and what's wrong with it. A test scene starts them off.
    @State var rpc = ""
    @State var rpcError: String?
    @State private var isApplyingRPC = false
    @State private var isAddingCold = false
    @State private var isToppingUp = false
    @State private var isSending = false
    /// A new savings wallet to send a little to, once its sheet has gone.
    @State private var testingSavings: EthereumAddress?
    @State private var isSweeping = false
    @State private var isConfirmingRotation = false
    @State private var isConfirmingAbandon = false
    @State private var isConfirmingDelete = false
    /// The row a notification opened, lit up for a moment.
    @State private var litRow: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var isChangingCap = false
    /// What this Mac signed while the page was open, marked for a moment once its sheet has closed, so it's found.
    @State private var newRows = NewRowMarks()

    private var address: EthereumAddress? { wallet.address }

    /// The sheets here that can sign something.
    private var isCoveredBySheet: Bool { isSending || isSweeping || isAddingCold || isToppingUp }

    private var content: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let alarm = wallet.alarm { alarmBanner(alarm) }
            ForEach(wallet.notices) { notice in
                Notice(notice.kind == .warning ? .warning : .info, notice.text, actionTitle: notice.asksForSavings ? HotWalletWording.addSavingsButton : nil) { isAddingCold = true }
                    .id(notice.text == wallet.lastActionProblem ? MoneyNotice.sweepProblemRow : notice.id)
            }
            card
            if !shownPurchases.isEmpty { bought }
            overview
            if showsHoldings { holdings }
            if !wallet.records.isEmpty { activity }
            // Otherwise they're on the overview, with its holdings.
            if showsHoldings, let portfolio = wallet.portfolio, portfolio.hasOtherTokens { OtherTokensSection(portfolio: portfolio) }
            if !wallet.connectedSites.isEmpty { sites }
            settings
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        // Inside the page's scroll view, whichever page it's on, which is the one it scrolls.
        ScrollViewReader { proxy in
            content.onChange(of: navigation.pending, initial: true) { _, intent in take(intent, with: proxy) }
        }
        .onChange(of: wallet.records.map(\.hash)) { old, new in
            newRows.rowsChanged(from: old, to: new, isCovered: isCoveredBySheet)
        }
        // A send's sheet stays until its receipt arrives, and a moment more, so that's when its row is there to see.
        .onChange(of: isCoveredBySheet) { _, covered in
            if !covered { newRows.uncovered() }
        }
        .flash(trigger: newRows.lit, rest: []) { newRows.fade() }
        .flash(trigger: litRow, rest: nil, for: .seconds(3)) { litRow = nil }
        .sheet(isPresented: $isAddingCold, onDismiss: { if testingSavings != nil { isSending = true } }) {
            AddColdWalletSheet(wallet: wallet, wallets: store.walletList(hotWallet: wallet).pickable, navigation: navigation, server: store.serverURL) { testingSavings = $0 }
        }
        .sheet(isPresented: $isToppingUp) { TopUpSheet(wallet: wallet, server: store.serverURL) }
        .sheet(isPresented: $isSending, onDismiss: { testingSavings = nil }) {
            SendSheet(model: {
                let model = SendModel(wallet: wallet, store: store)
                model.addressText = testingSavings?.checksummed ?? ""
                return model
            }(), wallets: store.walletList(hotWallet: wallet).pickable)
        }
        .sheet(isPresented: $isSweeping) { SweepSheet(wallet: wallet) }
        .onAppear {
            // What didn't save stays, next to what's wrong with it.
            if rpcError == nil { rpc = wallet.settings.rpcURL.absoluteString }
        }
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
                }
                .buttonStyle(AlarmButtonStyle())
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
                    DisplayNumber(wallet.valueUsdMicros.map(wallet.money) ?? "—", size: 20, tone: wallet.plan?.excessUsdMicros ?? 0 > 0 ? .warning : .neutral)
                        .accessibilityLabel(Spoken.number("Balance", wallet.valueUsdMicros.map(wallet.money)) + (wallet.plan?.excessUsdMicros ?? 0 > 0 ? ", above the cap" : ""))
                    Button("of \(wallet.capText)") { isChangingCap.toggle() }
                        .buttonStyle(.link)
                        .help("Change the cap")
                        .accessibilityLabel("Cap, \(wallet.capText)")
                        .accessibilityHint("Change the cap")
                        .popover(isPresented: $isChangingCap, arrowEdge: .bottom) { capEditor }
                }
                CapGauge(plan: wallet.plan, capUsdMicros: wallet.settings.capUsdMicros)
                if let plan = wallet.plan, plan.gasKeptWei > 0 {
                    Text(HotWalletWording.keptOutOfCap(plan.gasKeptWei))
                        .font(.caption)
                        .secondaryText()
                }
                if let address {
                    HStack {
                        AddressLine(address.checksummed)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        CopyButton(title: "Copy", text: address.checksummed, help: "Copy this address")
                            .labelStyle(.iconOnly)
                            .buttonStyle(.borderless)
                    }
                }
                actions
            }
            .flash(litRow == MoneyNotice.balanceRow, .found)
            .id(MoneyNotice.balanceRow)
        }
    }

    private var capEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            CapSlider(wallet: wallet)
            Text(capFooter)
                .font(.caption)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(width: 320)
    }

    private var capFooter: String {
        let ceiling = "It's \(wallet.display.whole(wallet.settings.capCeiling)) at most \(wallet.settings.coldWallets.isEmpty ? "until you add a savings wallet" : "in this unreviewed build")."
        return "Anything above the cap moves to your savings. \(ceiling)\(wallet.display.isConverted ? " \(HotWalletWording.capFollowsRate(wallet.display.main))" : "")"
    }

    /// This Mac's, including what was bought for a key that's since been replaced, which may still be arriving.
    private var shownPurchases: [TrackedPurchase] {
        guard let address else { return [] }
        return purchases.purchases(of: Set(([address] + wallet.state.retired).map(\.lowercased)))
    }

    private var bought: some View {
        DetailsSection("Purchases") {
            if let problem = purchases.problem {
                WarningText(problem).font(.callout)
            }
            ForEach(shownPurchases) { purchase in
                PurchaseRow(purchase: purchase, phase: purchases.phase(of: purchase), main: wallet.display.main) { purchases.dismiss(purchase) }
                    .flash(litRow == MoneyNotice.purchaseRow(purchase.ref), .found)
                    .id(MoneyNotice.purchaseRow(purchase.ref))
                    .arrives()
            }
        }
        // One started or dismissed, without the rest jumping.
        .motion(Motion.state, value: shownPurchases.map(\.id))
    }

    private var holdings: some View {
        DetailsSection("Holdings") {
            if wallet.holdings.isEmpty {
                Text("Reading…").secondaryText()
            }
            ForEach(wallet.holdings) { holding in
                LabeledContent(holding.token.symbol) {
                    HStack(spacing: 10) {
                        Text(Format.amount(String(holding.balance), decimals: holding.token.decimals))
                            .monospacedDigit()
                        if let value = holding.valueUsdMicros {
                            Text(wallet.money(value))
                                .monospacedDigit()
                                .secondaryText()
                                .frame(minWidth: 72, alignment: .trailing)
                        } else {
                            WarningText(Wording.noPrice)
                                .font(.caption)
                                .frame(minWidth: 72, alignment: .trailing)
                        }
                    }
                }
                // "ETH, 0.005, $13.20" doesn't say which number is which.
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(holding.token.symbol), \(Format.amount(String(holding.balance), decimals: holding.token.decimals)), \(holding.valueUsdMicros.map { "worth \(wallet.money($0))" } ?? "no price")")
            }
        }
    }

    private var savings: some View {
        DetailsSection("Savings") {
            if wallet.settings.coldWallets.isEmpty {
                Text("No savings wallet yet.")
                    .secondaryText()
            }
            ForEach(wallet.settings.coldWallets) { cold in
                HStack {
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
                    Button("Show") { store.setWallet(cold.address.lowercased) }
                        .help("Show its cost and PnL")
                    Button("Remove…") {
                        navigation.removingFromSavings = WalletEntry(address: cold.address.lowercased, name: cold.name, kind: .savings)
                    }
                    .help("Remove from savings")
                    .disabled(wallet.isWorking)
                }
            }
            if !wallet.settings.coldWallets.isEmpty {
                Picker("Sweeps go to", selection: Binding(get: { wallet.settings.sweepDestination }, set: { address in if let address { Task { await wallet.setSweepDestination(address) } } })) {
                    ForEach(wallet.settings.coldWallets) { cold in
                        // Two can have the same name, and this decides where money goes.
                        Text("\(cold.name) (\(Format.shortHash(cold.address.checksummed)))").tag(Optional(cold.address))
                    }
                }
                .pickerStyle(.radioGroup)
                .accessibilityLabel("Sweeps go to")
                .disabled(wallet.isWorking)
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
            // What's done every day leads. Moving money to and from savings follows, and replacing the key is with the settings.
            ViewThatFits(in: .horizontal) {
                HStack {
                    send
                    receive
                    buy
                    Spacer(minLength: 16)
                    topUp
                    sweep
                }
                VStack(alignment: .leading) {
                    HStack {
                        send
                        receive
                        buy
                    }
                    HStack {
                        topUp
                        sweep
                    }
                }
            }
            if wallet.canLeaveOldKeyBehind {
                Button("Delete the Old Key and Leave What's on It…", role: .destructive) { isConfirmingAbandon = true }
            }
        }
        .confirmationDialog("Delete the old key?", isPresented: $isConfirmingAbandon) {
            Button("Delete and Leave It Behind", role: .destructive) { Task { await wallet.finishRotationLeavingFundsBehind() } }
        } message: {
            Text(wallet.leavingOldKeyMessage)
        }
    }

    private var send: some View {
        Button("Send…") { isSending = true }
            .buttonStyle(.borderedProminent)
            .disabled(!wallet.canSend)
    }

    private var receive: some View {
        Button("Receive…") { navigation.pending = .receive }
            .disabled(!wallet.canTopUp)
    }

    private var buy: some View {
        Button("Buy…") { navigation.pending = .buy }
    }

    private var topUp: some View {
        Button("\(HotWalletWording.topUpTitle(hasDestination: wallet.settings.sweepDestination != nil))…") { isToppingUp = true }
            .disabled(!wallet.canTopUp)
    }

    private var sweep: some View {
        Button("Sweep Everything…") { isSweeping = true }
            .disabled(wallet.settings.sweepDestination == nil || wallet.isWorking || wallet.isKeyMissing || wallet.sweepPreview?.whyNothing != nil)
            .help(wallet.settings.sweepDestination == nil ? "Add a savings wallet first" : wallet.sweepPreview?.whyNothing ?? "Move everything on this wallet to your savings. \(HotWalletWording.newDevice)")
    }

    /// This wallet's own settings. App-wide ones are in Settings. What's rare and can't be undone comes last.
    private var settings: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Settings")
                .font(.title3.weight(.semibold))
                .padding(.top, 10)
            DetailsSection("Cap and Sweeps", footer: capFooter) {
                CapSlider(wallet: wallet)
                LabeledContent("Sweep realized gains to savings") {
                    Toggle("Sweep realized gains to savings", isOn: Binding(get: { wallet.settings.sweepsRealizedGains }, set: { wallet.setSweepsRealizedGains($0) }))
                        .labelsHidden()
                        .toggleStyle(.switch)
                        .controlSize(.small)
                }
            }
            savings
            DetailsSection("Advanced", footer: "Where this wallet reads its balances and sends what you sign. It can't move anything by itself. Change it only if the default is busy.") {
                LabeledContent("Base network address") {
                    TextField("Base network address", text: $rpc, prompt: Text(Base.publicRPC.absoluteString))
                        .labelsHidden()
                        .frame(maxWidth: 280)
                        .onSubmit(applyRPC)
                        // Leaving the page counts as being done, because there's no Save button to say otherwise.
                        .onDisappear(perform: applyRPC)
                }
                if let rpcError {
                    WarningText(rpcError).font(.callout)
                }
            }
            DetailsSection("Key") {
                LabeledContent {
                    Button("Replace…") { isConfirmingRotation = true }
                        .disabled(wallet.rotation != nil || wallet.isWorking || wallet.isKeyMissing)
                } label: {
                    SettingLabel("Replace Key", "For when someone else may have it. A new key gets what this app tracks.")
                }
            }
            .confirmationDialog("Replace this wallet's key?", isPresented: $isConfirmingRotation) {
                Button("Replace Key") { Task { await wallet.replaceKey() } }
                if wallet.settings.sweepDestination != nil, wallet.sweepPreview?.whyNothing == nil {
                    Button("Sweep Everything to Savings Instead") { isSweeping = true }
                }
            } message: {
                Text("Makes a new key, moves every token this app tracks to it, then deletes the old one. If the old key holds other tokens, or some that gas makes too costly to move, it stays until you choose to leave them. This costs gas, and publicly links the two addresses. It also clears any token approvals the old key gave.")
            }
            DetailsSection("Delete") {
                LabeledContent {
                    Button("Delete…", role: .destructive) { isConfirmingDelete = true }
                        .disabled(!wallet.canDelete)
                } label: {
                    SettingLabel("Delete This Mac's Spending Money", wallet.canDelete ? "Deletes the key for good. Anything still on this wallet is lost." : HotWalletWording.deleteWaitsForRotation)
                }
            }
            .confirmationDialog("Delete this wallet's key?", isPresented: $isConfirmingDelete) {
                if wallet.settings.sweepDestination != nil, wallet.sweepPreview?.whyNothing == nil {
                    Button("Sweep Everything to Savings First") { Task { await wallet.sweepEverything() } }
                }
                Button("Delete Forever", role: .destructive) { Task { await wallet.deleteWallet() } }
            } message: {
                Text("There's no recovery phrase and no backup. Whatever is still on this wallet is lost for good.")
            }
        }
    }

    private func applyRPC() {
        guard let url = WebAddress.read(rpc) else {
            rpcError = WebAddress.problem(example: Base.publicRPC)
            return
        }
        rpcError = nil
        guard url != wallet.settings.rpcURL, !isApplyingRPC else { return }
        isApplyingRPC = true
        Task {
            await wallet.setRPC(url)
            isApplyingRPC = false
            // If they said no, it's still the old one, and leaving the page shouldn't ask again.
            rpc = wallet.settings.rpcURL.absoluteString
        }
    }

    private var activity: some View {
        DetailsSection("Signed by This Mac") {
            ForEach(wallet.records) { record in
                HStack {
                    VStack(alignment: .leading) {
                        Text(record.title)
                            .monospacedDigit()
                        Text("\(record.reasonText) · \(Format.time(record.createdAt))")
                            .font(.caption)
                            .secondaryText()
                    }
                    Spacer()
                    RecordStatus(status: record.status, text: record.statusText(among: wallet.records))
                    if let url = Basescan.transaction(record.hash) {
                        Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                            .foregroundStyle(.secondary)
                            .help("Open this transaction")
                            .accessibilityLabel("Open this transaction on Basescan")
                    }
                }
                .contentShape(Rectangle())
                .contextMenu { TransactionActions(hash: record.hash) }
                .flash(newRows.lit.contains(record.hash), .added)
                .flash(litRow == MoneyNotice.recordRow(record.hash), .found)
                .id(MoneyNotice.recordRow(record.hash))
                .arrives()
            }
        }
        .motion(Motion.state, value: wallet.records.map(\.hash))
    }

    /// What was asked for from elsewhere that's this page's to do. It's taken, so the same click works twice.
    private func take(_ intent: Intent?, with proxy: ScrollViewProxy) {
        switch intent {
        case .topUp:
            navigation.pending = nil
            if wallet.canTopUp { isToppingUp = true }
        case .send:
            navigation.pending = nil
            if wallet.canSend { isSending = true }
        case .addSavings:
            navigation.pending = nil
            isAddingCold = true
        case .addSavingsFromDevice:
            // The sheet takes it from there, and it may already be open, waiting for this.
            isAddingCold = true
        case .deleteSpendingMoney:
            navigation.pending = nil
            if wallet.canDelete { isConfirmingDelete = true }
        case .show(let row):
            navigation.pending = nil
            reveal(row, with: proxy)
        case .buy, .receive, .export, .search, nil:
            break
        }
    }

    /// Scrolls to what a notification was about, and lights it up long enough to find it.
    private func reveal(_ wanted: String, with proxy: ScrollViewProxy) {
        // A row from a key that's been replaced isn't here anymore, so it opens what the money's on now.
        let shown = Set(wallet.records.map { MoneyNotice.recordRow($0.hash) } + shownPurchases.map { MoneyNotice.purchaseRow($0.ref) } + (wallet.lastActionProblem == nil ? [] : [MoneyNotice.sweepProblemRow]))
        let row = shown.contains(wanted) ? wanted : MoneyNotice.balanceRow
        withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(row, anchor: .center) }
        litRow = row
    }
}

/// How close to the cap this is. Only a picture of the numbers beside it, which are what's real, and it follows them so that what sweeps away visibly leaves.
struct CapGauge: View {
    let plan: SweepPlan?
    let capUsdMicros: UInt128

    private var value: Double {
        guard let plan else { return 0 }
        return min(1, Double(plan.valueUsdMicros) / Double(capUsdMicros))
    }

    var body: some View {
        Gauge(value: value, in: 0...1) {}
            .gaugeStyle(.accessoryLinearCapacity)
            .tint(plan?.excessUsdMicros ?? 0 > 0 ? .orange : .accentColor)
            .accessibilityHidden(true)
            .motion(Motion.number, value: value)
    }
}

/// A group of rows like a form's, for a page that scrolls with the rest of a wallet's numbers.
private struct DetailsGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        PageGroup { content }
            .labeledContentStyle(DetailsRowStyle())
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
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// A setting's name, with a line on what it does, as System Settings has.
private struct SettingLabel: View {
    let title: String
    let detail: String

    init(_ title: String, _ detail: String) {
        self.title = title
        self.detail = detail
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
            Text(detail)
                .font(.caption)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
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
                .foregroundStyle(status == .failed || status == .dropped ? Tone.warning.style : Tone.secondary.style)
        }
        .font(.caption)
        .motion(Motion.state, value: status)
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
    /// Until then the room left is unknown, and would read as the whole cap.
    private var hasRead: Bool { wallet.plan != nil }
    private var hasDestination: Bool { wallet.settings.sweepDestination != nil }

    private var deviceLink: URL? {
        wallet.address.flatMap { DeviceFlow.topUp(server: server, to: $0.checksummed, dollars: Int(dollars)) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(HotWalletWording.topUpTitle(hasDestination: hasDestination))
                .font(.sheetTitle)
            if hasRead, room < 1 {
                Notice(.info, HotWalletWording.topUpAtCap(wallet.capText, hasDestination: hasDestination))
            } else {
                LabeledContent("Amount") {
                    HStack {
                        // A slider needs two ends, and with room for one dollar, the other end is too much.
                        Slider(value: $dollars, in: 1...Double(max(room, 2)), step: 1)
                            .disabled(!hasRead || room < 2)
                        Text(amountText)
                            .monospacedDigit()
                            .frame(width: 56, alignment: .trailing)
                    }
                }
                Text(hasRead ? HotWalletWording.topUpRoom(wallet.money(wallet.topUpRoom), hasDestination: hasDestination) : "Reading this wallet…")
                    .font(.caption)
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
                if let deviceLink {
                    DeviceBrowserNote(choice: found, outcome: "your hardware wallet signs the transfer.", canUseDefault: hasRead) { open(deviceLink, in: nil) }
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
                // Nothing read yet means no holdings at all, which says nothing about its gas.
                if let eth = wallet.holdings.first(where: { $0.token.isNative }), eth.balance < SweepPlanner.minimumGasReserveWei {
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
                        .disabled(!hasRead)
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
        // The amount in the link is only worth sending once the room's known.
        guard hasRead else { return }
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

/// Lowering the cap asks for Touch ID, so a drag only counts where it ends, and a refusal puts it back. Keys and VoiceOver move it
/// with no end to wait for, so a short pause counts as one.
private struct CapSlider: View {
    let wallet: HotWallet
    @State private var draft: Int?
    @State private var isDragging = false
    @State private var isApplying = false

    var body: some View {
        let shown = draft ?? wallet.settings.capInDollars
        LabeledContent("Cap") {
            HStack {
                Slider(value: Binding(get: { Double(shown) }, set: { draft = Int($0) }), in: 1...Double(wallet.settings.capCeiling / Money.dollar)) { isEditing in
                    isDragging = isEditing
                    if !isEditing { apply() }
                }
                .frame(maxWidth: 240)
                .disabled(wallet.isWorking)
                Text(wallet.money(dollars: shown))
                    .monospacedDigit()
                    .frame(width: 56, alignment: .trailing)
            }
        }
        .task(id: draft) {
            guard draft != nil, (try? await Task.sleep(for: .seconds(0.6))) != nil, !isDragging else { return }
            apply()
        }
    }

    private func apply() {
        guard let dollars = draft, !isApplying else { return }
        isApplying = true
        Task {
            await wallet.setCap(dollars: dollars)
            draft = nil
            isApplying = false
        }
    }
}
