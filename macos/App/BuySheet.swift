import HotWalletKit
import PricetagKit
import SwiftUI

/// Picks what to buy and sends it to the provider's page, which takes the payment. It all lands in spending money, and what's above the cap
/// sweeps to savings, or stays there until there's a savings wallet. This never signs anything.
struct BuySheet: View {
    let wallet: HotWallet
    let purchases: PurchaseTracker
    let started: () -> Void
    let addSavings: () -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var asset: Asset
    /// What's typed, in whole units of what's shown. Only that's in anything but USD: it's converted before anything else sees it.
    @State private var typed: Int?
    /// The last amount this suggested. While what's typed still matches it, nobody's changed it, so a read can move it.
    @State private var suggested: Int?
    @State private var isStarting = false
    @State private var failure: String?

    enum Asset: String, CaseIterable, Identifiable {
        case eth = "ETH"
        case usdc = "USDC"
        var id: Self { self }
    }

    /// ETH first, because it also pays for what a sweep costs.
    init(wallet: HotWallet, purchases: PurchaseTracker, typed: Int? = nil, asset: Asset = .eth, failure: String? = nil, started: @escaping () -> Void, addSavings: @escaping () -> Void) {
        self.wallet = wallet
        self.purchases = purchases
        self.started = started
        self.addSavings = addSavings
        let suggestion = wallet.buySuggestion
        _typed = State(initialValue: typed ?? suggestion)
        _suggested = State(initialValue: typed == nil ? suggestion : nil)
        _asset = State(initialValue: asset)
        _failure = State(initialValue: failure)
    }

    /// What's typed, which can be nothing, or below zero. Nothing here assumes it's an amount until `BuyPlan` has said so.
    private var chosen: Int { typed ?? 0 }
    private var display: MoneyDisplay { wallet.display }
    private var usdMicros: UInt128 { display.usdMicros(ofWhole: chosen) }
    private var hasSavings: Bool { wallet.settings.sweepDestination != nil }

    private var token: Token { asset == .eth ? Base.eth : Base.tokens.first { $0.symbol == asset.rawValue } ?? Base.eth }

    private var plan: BuyPlan {
        BuyPlan(usdMicros: usdMicros, token: token, priceUsdMicros: asset == .eth ? wallet.snapshot?.ethUsdMicros : wallet.snapshot?.usdcUsdMicros, holdings: wallet.holdings, capUsdMicros: wallet.settings.capUsdMicros, roomUsdMicros: wallet.topUpRoom, fees: wallet.snapshot?.fees, destination: wallet.settings.sweepDestination)
    }

    /// What the savings wallet is called, because that's what someone knows it by. Nil without one.
    private var savingsName: String? {
        guard let destination = wallet.settings.sweepDestination else { return nil }
        return wallet.settings.coldWallets.first { $0.address == destination }?.name ?? "your savings"
    }

    private var cryptoAmount: String? {
        BuyPlan.cryptoAmount(usdMicros: usdMicros, isNative: asset == .eth, ethUsdMicros: wallet.snapshot?.ethUsdMicros)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Buy")
                .font(.sheetTitle)
            if wallet.address == nil {
                Notice(.info, "What you buy lands in Spending Money, so that comes first.")
            } else {
                form
                if !hasSavings {
                    Notice(.warning, HotWalletWording.buyWithoutSavings(cap: wallet.capText, provider: PurchaseWording.provider), actionTitle: HotWalletWording.addSavingsButton) {
                        addSavings()
                        dismiss()
                    }
                }
            }
            if let failure {
                WarningText(failure).font(.callout)
            }
            buttons
        }
        .padding(20)
        .frame(width: 460)
        .onChange(of: wallet.buySuggestion) { _, suggestion in
            guard typed == suggested else { return }
            typed = suggestion
            suggested = suggestion
        }
    }

    @ViewBuilder
    private var form: some View {
        Picker("Token", selection: $asset) {
            ForEach(Asset.allCases) { Text($0.rawValue).tag($0) }
        }
        .pickerStyle(.segmented)
        LabeledContent("Amount") {
            HStack(spacing: 4) {
                Text(display.symbol)
                    .secondaryText()
                TextField("Amount", value: $typed, format: .number.grouping(.never))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .frame(width: 90)
                    .monospacedDigit()
            }
        }
        destination
        Text("\(cryptoAmount.map { "About \($0) \(asset.rawValue). " } ?? "")\(PurchaseWording.checkoutNote(display))")
            .font(.caption)
            .secondaryText()
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Where it ends up, or why it can't.
    @ViewBuilder
    private var destination: some View {
        switch plan.problem {
        case .belowMinimum:
            Text("\(PurchaseWording.provider)'s minimum is about \(display.whole(BuyPlan.minimumUsdMicros, rounding: .up)), depending on how you pay.")
                .secondaryText()
        case .noGasToSweep:
            Notice(.warning, HotWalletWording.buyNoGas(asset.rawValue, savings: savingsName))
        case .notReadYet:
            Text("Reading this wallet…")
                .secondaryText()
        case nil:
            VStack(alignment: .leading, spacing: 4) {
                Text(whereItGoes)
                if plan.aboveCap > 0, hasSavings {
                    Text("Keep \(AppName.current) open until it lands. If it's closed, it moves the next time it opens.")
                        .font(.caption)
                        .secondaryText()
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var whereItGoes: String {
        HotWalletWording.buyLands(fits: plan.fits > 0 ? wallet.money(plan.fits) : nil, aboveCap: plan.aboveCap > 0 ? wallet.money(plan.aboveCap) : nil, savings: savingsName)
    }

    private var buttons: some View {
        HStack {
            Spacer()
            if isStarting { ProgressView().controlSize(.small) }
            Button("Cancel") { dismiss() }
                .keyboardShortcut(.cancelAction)
            if wallet.address == nil {
                Button("Set Up Spending Money") {
                    started()
                    dismiss()
                }
                .keyboardShortcut(.defaultAction)
            } else {
                Button("Continue on \(PurchaseWording.provider)") { Task { await start() } }
                    .keyboardShortcut(.defaultAction)
                    .disabled(plan.problem != nil || cryptoAmount == nil || isStarting || !wallet.canTopUp)
            }
        }
    }

    private func start() async {
        guard let address = wallet.address, let cryptoAmount else { return }
        isStarting = true
        defer { isStarting = false }
        do {
            // What was typed goes to the page, so it starts at that number, and not at what a rate made of it.
            let typed = display.isConverted ? Money(micros: String(UInt128(chosen) * Money.dollar), currency: display.currency) : nil
            let page = try await purchases.begin(wallet: address.lowercased, asset: asset.rawValue, dollars: Int(clamping: usdMicros / Money.dollar), cryptoAmount: cryptoAmount, typed: typed)
            openURL(page)
            started()
            dismiss()
        } catch {
            failure = PurchaseTracker.message(for: error)
        }
    }
}

/// One purchase, and where it's got to. Like a send, it only gets its check once the chain shows it arrived, and its cost lights up as it becomes known.
struct PurchaseRow: View {
    let purchase: TrackedPurchase
    let phase: PurchasePhase
    let main: CurrencyCode
    let dismiss: () -> Void
    /// Only when it arrives while the row's on screen. One that arrived earlier is just there.
    @State private var justArrived = false

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(PurchaseWording.title(purchase, beside: main))
                    .monospacedDigit()
                Text(PurchaseWording.status(phase, beside: main))
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(PurchaseWording.isWarning(phase) ? Tone.warning.style : Tone.secondary.style)
                    .contentTransition(.opacity)
                    .flash(justArrived, .known)
            }
            Spacer()
            Group {
                if !phase.isFinished, !phase.isUpToThem {
                    ProgressView().controlSize(.small)
                } else if isArrived {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(Tone.gain.style)
                        .transition(.symbolEffect(.drawOn))
                        .accessibilityLabel("Arrived")
                }
            }
            .frame(width: 18)
            if phase.isFinished || phase.isUpToThem {
                Button(phase.isUpToThem ? "I Didn't Buy It" : "Dismiss", systemImage: "xmark.circle") { dismiss() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help(phase.isUpToThem ? "Stop waiting for this one" : "Dismiss")
            }
            if let hash = purchase.order?.txHash, let url = Basescan.transaction(hash) {
                Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                    .foregroundStyle(.secondary)
                    .help("Open this transaction")
            }
        }
        .motion(Motion.state, value: phase)
        .onChange(of: isArrived) { _, arrived in justArrived = arrived }
        .flash(trigger: justArrived, rest: false) { justArrived = false }
    }

    /// Seen on the chain, with what it cost. Anything short of that isn't checked off.
    private var isArrived: Bool {
        if case .recorded = phase { true } else { false }
    }
}
