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
    @State private var dollars: Int?
    @State private var isStarting = false
    @State private var failure: String?

    enum Asset: String, CaseIterable, Identifiable {
        case eth = "ETH"
        case usdc = "USDC"
        var id: Self { self }
    }

    /// ETH first, because it also pays for what a sweep costs.
    init(wallet: HotWallet, purchases: PurchaseTracker, dollars: Int? = nil, asset: Asset = .eth, failure: String? = nil, started: @escaping () -> Void, addSavings: @escaping () -> Void) {
        self.wallet = wallet
        self.purchases = purchases
        self.started = started
        self.addSavings = addSavings
        _dollars = State(initialValue: dollars ?? max(BuyPlan.minimumDollars, min(Int(wallet.topUpRoom / Money.dollar), 20)))
        _asset = State(initialValue: asset)
        _failure = State(initialValue: failure)
    }

    /// What's typed, which can be nothing, or below zero. Nothing here assumes it's an amount until `BuyPlan` has said so.
    private var chosen: Int { dollars ?? 0 }
    private var hasSavings: Bool { wallet.settings.sweepDestination != nil }

    private var token: Token { asset == .eth ? Base.eth : Base.tokens.first { $0.symbol == asset.rawValue } ?? Base.eth }

    private var plan: BuyPlan {
        BuyPlan(dollars: chosen, token: token, priceUsdMicros: asset == .eth ? wallet.snapshot?.ethUsdMicros : wallet.snapshot?.usdcUsdMicros, holdings: wallet.holdings, capUsdMicros: wallet.settings.capUsdMicros, roomUsdMicros: wallet.topUpRoom, fees: wallet.snapshot?.fees, destination: wallet.settings.sweepDestination)
    }

    /// What the savings wallet is called, because that's what someone knows it by.
    private var savingsName: String {
        wallet.settings.coldWallets.first { $0.address == wallet.settings.sweepDestination }?.name ?? "your savings"
    }

    private var cryptoAmount: String? {
        BuyPlan.cryptoAmount(dollars: chosen, isNative: asset == .eth, ethUsdMicros: wallet.snapshot?.ethUsdMicros)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Buy")
                .font(.title2.bold())
            if wallet.address == nil {
                Notice(.info, "What you buy lands in Spending Money, so that comes first.")
            } else if !hasSavings, wallet.topUpRoom < UInt128(BuyPlan.minimumDollars) * Money.dollar {
                Notice(.info, "There's only room for \(wallet.usd(wallet.topUpRoom)) in Spending Money. To buy more, add a savings wallet for the rest to go to.")
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
                Text(wallet.usd(dollars: 0).replacing("0", with: ""))
                    .foregroundStyle(.secondary)
                TextField("Amount", value: $dollars, format: .number.grouping(.never))
                    .labelsHidden()
                    .multilineTextAlignment(.trailing)
                    .frame(width: 90)
                    .monospacedDigit()
            }
        }
        destination
        Text("\(cryptoAmount.map { "About \($0) \(asset.rawValue). " } ?? "")You'll need a \(PurchaseWording.provider) account. Its fees are added, and that total becomes the cost here.")
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// Where it ends up, or why it can't.
    @ViewBuilder
    private var destination: some View {
        switch plan.problem {
        case .belowMinimum:
            Text("\(PurchaseWording.provider)'s minimum is about \(wallet.usd(dollars: BuyPlan.minimumDollars)), depending on how you pay.")
                .foregroundStyle(.secondary)
        case .needsSavings:
            Notice(.info, "There's room for \(wallet.usd(wallet.topUpRoom)) in Spending Money. To buy more, add a savings wallet for the rest to go to.")
        case .noGasToSweep:
            Notice(.warning, "This wallet doesn't have enough ETH to move USDC to \(savingsName), so it could get stuck here. Buy ETH this time.")
        case .notReadYet:
            Text("Reading this wallet…")
                .foregroundStyle(.secondary)
        case nil:
            VStack(alignment: .leading, spacing: 4) {
                Text(whereItGoes)
                // The page can change the amount, and nothing here can stop it.
                if !hasSavings {
                    Text("If you buy more on \(PurchaseWording.provider)'s page, the rest stays here above your cap until you add a savings wallet.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
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
        return "\(wallet.usd(plan.stays)) stays in Spending Money, the rest goes to \(savingsName)."
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
            } else if !hasSavings, plan.problem == .needsSavings || wallet.topUpRoom < UInt128(BuyPlan.minimumDollars) * Money.dollar {
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
            let page = try await purchases.begin(wallet: address.lowercased, asset: asset.rawValue, dollars: chosen, cryptoAmount: cryptoAmount)
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
    let usd: (Int) -> String
    let dismiss: () -> Void

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(PurchaseWording.title(purchase, usd: usd))
                    .monospacedDigit()
                Text(PurchaseWording.status(phase))
                    .font(.caption)
                    .foregroundStyle(PurchaseWording.isWarning(phase) ? Tone.warning.style : AnyShapeStyle(.secondary))
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
