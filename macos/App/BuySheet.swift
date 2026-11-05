import HotWalletKit
import PricetagKit
import SwiftUI

/// Picks what to buy and sends it to the provider's page, which takes the payment. It all lands in spending money, and what's above the cap sweeps to savings. This never signs anything.
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
        let display = wallet.display
        _typed = State(initialValue: typed ?? max(display.wholeAmount(BuyPlan.minimumUsdMicros, rounding: .up), min(display.wholeAmount(wallet.topUpRoom, rounding: .down), 20)))
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

    /// What the savings wallet is called, because that's what someone knows it by.
    private var savingsName: String {
        wallet.settings.coldWallets.first { $0.address == wallet.settings.sweepDestination }?.name ?? "your savings"
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
            } else if !hasSavings {
                Notice(.info, "What you buy lands in Spending Money, and anything above your cap moves to your savings. \(PurchaseWording.provider)'s page can change the amount, so add a savings wallet first.")
            } else {
                form
            }
            if let failure {
                WarningText(failure).font(.callout)
            }
            buttons
        }
        .padding(20)
        .frame(width: 460)
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
        case .needsSavings:
            // The sheet asks for one instead of showing this.
            EmptyView()
        case .noGasToSweep:
            Notice(.warning, "This wallet doesn't have enough ETH to move USDC to \(savingsName), so it could get stuck here. Buy ETH this time.")
        case .notReadYet:
            Text("Reading this wallet…")
                .secondaryText()
        case nil:
            VStack(alignment: .leading, spacing: 4) {
                Text(whereItGoes)
                if plan.sweeps > 0 {
                    Text("Keep \(AppName.current) open until it lands. If it's closed, it moves the next time it opens.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var whereItGoes: String {
        if plan.sweeps == 0 { return "It all stays in Spending Money." }
        if plan.stays == 0 { return "Spending Money is full, so it all goes to \(savingsName)." }
        return "\(wallet.money(plan.stays)) stays in Spending Money, the rest goes to \(savingsName)."
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
            } else if !hasSavings {
                Button("Add a Savings Wallet…") {
                    addSavings()
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

/// One purchase, and where it's got to.
struct PurchaseRow: View {
    let purchase: TrackedPurchase
    let phase: PurchasePhase
    let main: CurrencyCode
    let dismiss: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(PurchaseWording.title(purchase, beside: main))
                    .monospacedDigit()
                Text(PurchaseWording.status(phase, beside: main))
                    .font(.caption)
                    .foregroundStyle(PurchaseWording.isWarning(phase) ? Tone.warning.style : Tone.secondary.style)
                    .contentTransition(.opacity)
                    .animation(Motion.state, value: phase)
            }
            Spacer()
            if !phase.isFinished, !phase.isUpToThem {
                ProgressView().controlSize(.small)
            }
            if phase.isFinished || phase.isUpToThem {
                Button(phase.isUpToThem ? "I Didn't Buy It" : "Dismiss", systemImage: "xmark.circle") { dismiss() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help(phase.isUpToThem ? "Stop waiting for this one" : "Dismiss")
            }
            if let hash = purchase.order?.txHash, let url = URL(string: "https://basescan.org/tx/\(hash)") {
                Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                    .foregroundStyle(.secondary)
                    .help("Open this transaction")
            }
        }
    }
}
