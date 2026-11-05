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
                    HotWalletSetup(wallet: wallet)
                } else {
                    HotWalletDetails(wallet: wallet, store: store, siteBridge: siteBridge, navigation: navigation)
                }
            }
        }
        .frame(minWidth: 320, minHeight: 320)
    }
}

/// Says what this is before there's anything to lose.
private struct HotWalletSetup: View {
    let wallet: HotWallet
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
                Text("A small balance on this Mac for everyday use. Anything above your cap moves to your savings.")
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
                Button("Create Spending Money") { Task { await wallet.createWallet() } }
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
    @State private var isAddingCold = false
    @State private var isToppingUp = false
    @State private var isSending = false
    @State private var isConfirmingSweep = false
    @State private var isConfirmingRotation = false
    @State private var isConfirmingAbandon = false

    private var address: EthereumAddress? { wallet.address }

    var body: some View {
        Form {
            if let alarm = wallet.alarm {
                Section { alarmBanner(alarm) }
            }
            ForEach(wallet.notices) { notice in
                Notice(notice.kind == .warning ? .warning : .info, notice.text)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            }
            balance
            actions
            holdings
            if !wallet.unlisted.isEmpty { untouched }
            savings
            if !wallet.connectedSites.isEmpty { sites }
            if !wallet.records.isEmpty { activity }
        }
        .formStyle(.grouped)
        .sheet(isPresented: $isAddingCold) { AddColdWalletSheet(wallet: wallet) }
        .sheet(isPresented: $isToppingUp) { TopUpSheet(wallet: wallet) }
        .onChange(of: navigation.wantsTopUp, initial: true) { _, wants in
            guard wants else { return }
            navigation.wantsTopUp = false
            if wallet.canTopUp { isToppingUp = true }
        }
        .sheet(isPresented: $isSending) { SendSheet(model: SendModel(wallet: wallet, store: store)) }
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
        .listRowInsets(EdgeInsets())
        .listRowBackground(Color.clear)
    }

    private var balance: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .firstTextBaseline) {
                    LiveNumber(wallet.plan.map { wallet.usd($0.valueUsdMicros) } ?? "—", tone: wallet.plan?.excessUsdMicros ?? 0 > 0 ? .warning : .neutral)
                        .font(.system(size: 34, weight: .semibold))
                    Text("of \(wallet.usd(wallet.settings.capUsdMicros))")
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
                if let address {
                    HStack {
                        Text(address.checksummed)
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                        Spacer()
                        Button("Copy", systemImage: "doc.on.doc") {
                            NSPasteboard.general.clearContents()
                            NSPasteboard.general.setString(address.checksummed, forType: .string)
                        }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.borderless)
                        .help("Copy this address")
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
                            Text(wallet.usd(value))
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
            if let plan = wallet.plan, plan.gasReserveWei > 0 {
                Text("\(Format.amount(String(plan.gasReserveWei), decimals: 18)) ETH is kept for gas.")
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
            Button("Add a Savings Wallet…", systemImage: "plus") { isAddingCold = true }
        } header: {
            Text("Savings")
        } footer: {
            Text("Sweeps go to the checked one.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private var sites: some View {
        Section {
            ForEach(wallet.connectedSites, id: \.self) { origin in
                LabeledContent(origin) {
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
                VStack(alignment: .leading) {
                    send
                    topUp
                    sweep
                    replaceKey
                }
            }
            if wallet.rotationHold != nil {
                Button("Delete the Old Key and Leave What's on It…", role: .destructive) { isConfirmingAbandon = true }
            }
        }
        .confirmationDialog("Sweep everything to your savings?", isPresented: $isConfirmingSweep) {
            Button("Sweep Everything") { Task { await wallet.sweepEverything() } }
        } message: {
            Text("Moves every token this app tracks and all the ETH it can, in separate transactions. Touch ID or your password confirms it.")
        }
        .confirmationDialog("Replace this wallet's key?", isPresented: $isConfirmingRotation) {
            Button("Replace Key") { Task { await wallet.replaceKey() } }
            if wallet.settings.sweepDestination != nil {
                Button("Sweep Everything to Savings Instead") { Task { await wallet.sweepEverything() } }
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
        Button("Top Up from Savings…") { isToppingUp = true }
            .disabled(!wallet.canTopUp)
    }

    private var sweep: some View {
        Button("Sweep Everything…") { isConfirmingSweep = true }
            .disabled(wallet.settings.sweepDestination == nil || wallet.isWorking || wallet.isKeyMissing)
            .help(wallet.settings.sweepDestination == nil ? "Add a savings wallet first" : "Move everything on this wallet to your savings. \(HotWalletWording.newDevice)")
    }

    private var replaceKey: some View {
        Button("Replace Key…") { isConfirmingRotation = true }
            .disabled(wallet.rotation != nil || wallet.isWorking || wallet.isKeyMissing)
    }

    private var abandonMessage: String {
        let lost = "What's still on the old address can never be moved again."
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
        case .site: record.site ?? "A site"
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

/// The Mac app has no device code, so the user is the one who checks the address against the device.
struct AddColdWalletSheet: View {
    let wallet: HotWallet
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var address: String
    @State private var matches = false
    @State private var problem: String?

    init(wallet: HotWallet, address: String = "") {
        self.wallet = wallet
        _address = State(initialValue: address)
    }

    private var parsed: EthereumAddress? {
        EthereumAddress(address.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Add a Savings Wallet")
                .font(.title2.bold())
            Text("On your hardware wallet, open its receive screen for Base, and copy that address here.")
                .fixedSize(horizontal: false, vertical: true)
            TextField("Name", text: $name, prompt: Text("Ledger"))
            TextField("Address", text: $address, prompt: Text("0x…"))
                .font(.body.monospaced())
                .onChange(of: address) {
                    matches = false
                    problem = nil
                }
            if let parsed {
                // In groups, because nobody really compares 40 characters in one run.
                Text(AddressText.grouped(parsed.checksummed))
                    .font(.title3.monospaced())
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Toggle("Every character matches what my device's screen shows", isOn: $matches)
            } else if !address.isEmpty {
                WarningText("That isn't a valid address.").font(.callout)
            }
            Text("Sweeps send real money here, and a compromised computer could show you the wrong address. The device's screen is the only one to trust.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if let problem {
                WarningText(problem).font(.callout)
            }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("Add Wallet") { add() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(parsed == nil || !matches)
            }
        }
        .padding(20)
        .frame(width: 460)
    }

    private func add() {
        do {
            try wallet.addColdWallet(address: address, name: name)
            dismiss()
        } catch {
            switch error {
            case .notAnAddress, .isZero: problem = "That isn't a wallet anyone can use."
            case .isThisHotWallet: problem = "That's this Mac's spending money, not a savings wallet."
            case .isARetiredKey: problem = "That's an old key from this Mac, whose private key is gone."
            }
        }
    }
}

/// Until the web app's device flow lands (WORK-325), this says what to do on the device by hand.
struct TopUpSheet: View {
    let wallet: HotWallet
    @Environment(\.dismiss) private var dismiss
    @State private var dollars = 0.0

    init(wallet: HotWallet) {
        self.wallet = wallet
    }

    private var room: Int { Int(wallet.topUpRoom / Money.dollar) }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Top Up from Savings")
                .font(.title2.bold())
            if room < 1 {
                Notice(.info, "This wallet is already at its cap of \(wallet.usd(wallet.settings.capUsdMicros)). Anything more would be swept straight back.")
            } else {
                LabeledContent("Amount") {
                    HStack {
                        // A slider needs two ends, and with room for one dollar, the other end is too much.
                        Slider(value: $dollars, in: 1...Double(max(room, 2)), step: 1)
                            .disabled(room < 2)
                        Text(wallet.usd(dollars: Int(dollars)))
                            .monospacedDigit()
                            .frame(width: 56, alignment: .trailing)
                    }
                }
                Text("There's room for \(wallet.usd(wallet.topUpRoom)) under your cap. Anything above that gets swept back to your savings.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 8) {
                    Text("On your hardware wallet:").bold()
                    Label("Choose Send, on Base", systemImage: "1.circle")
                    Label("Enter about \(wallet.usd(dollars: Int(dollars))) of ETH or USDC\(ethHint)", systemImage: "2.circle")
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
                if wallet.holdings.first(where: { $0.token.isNative })?.balance ?? 0 < SweepPlanner.minimumGasReserveWei {
                    Notice(.warning, "Send some of it as ETH. This wallet needs a little to pay for its sweeps.")
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
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { dollars = Double(max(1, min(room, 20))) }
        // A read can leave less room than there was when this opened. What's chosen stays if it still fits.
        .onChange(of: room) { dollars = min(dollars, Double(max(room, 1))) }
    }

    private var ethHint: String {
        guard let price = wallet.snapshot?.ethUsdMicros else { return "" }
        let amount = Money.amount(ofUsdMicros: UInt128(dollars) * Money.dollar, priceMicros: price, decimals: 18)
        return " (about \(Format.amount(String(amount), decimals: 18)) ETH)"
    }
}
