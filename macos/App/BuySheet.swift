import HotWalletKit
import PricetagKit
import SwiftUI

/// Picks what to buy, and sends it to Coinbase's page, which takes the payment. This never signs anything.
struct BuySheet: View {
    let wallet: HotWallet
    let purchases: PurchaseTracker
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var asset: Asset
    @State private var dollars = 0.0
    @State private var isStarting = false
    @State private var failure: String?

    enum Asset: String, CaseIterable, Identifiable {
        case eth = "ETH"
        case usdc = "USDC"
        var id: Self { self }
    }

    /// Coinbase's own minimum is about this. Its page has the last word.
    private static let minimum = 5

    init(wallet: HotWallet, purchases: PurchaseTracker, failure: String? = nil) {
        self.wallet = wallet
        self.purchases = purchases
        _failure = State(initialValue: failure)
        _asset = State(initialValue: .eth)
    }

    private var room: Int { Int(wallet.topUpRoom / Money.dollar) }

    /// The amount in the token, which is what a page in any currency can start from, and what keeps it under the cap. Nil with no price to work it out from.
    private var cryptoAmount: String? {
        switch asset {
        case .usdc: return String(Int(dollars))
        case .eth:
            guard let price = wallet.snapshot?.ethUsdMicros, price > 0 else { return nil }
            return Self.decimal(Money.amount(ofUsdMicros: UInt128(dollars) * Money.dollar, priceMicros: price, decimals: 18), decimals: 18, keeping: 6)
        }
    }

    /// In plain digits for Coinbase, rounded down, so this never asks for more than was chosen.
    static func decimal(_ units: UInt128, decimals: Int, keeping: Int) -> String {
        let text = String(units)
        let padded = String(repeating: "0", count: max(0, decimals + 1 - text.count)) + text
        let whole = padded.dropLast(decimals)
        let fraction = padded.suffix(decimals).prefix(keeping)
        return "\(whole).\(fraction)"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Buy")
                .font(.title2.bold())
            if room < Self.minimum {
                Notice(.info, room < 1 ? "This wallet is already at its cap of \(wallet.usd(wallet.settings.capUsdMicros)). Anything more would be swept to your savings." : "There's only room for \(wallet.usd(wallet.topUpRoom)) under your cap, and Coinbase's minimum is about \(wallet.usd(dollars: Self.minimum)).")
            } else {
                Picker("Token", selection: $asset) {
                    ForEach(Asset.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented)
                LabeledContent("Amount") {
                    HStack {
                        // A slider needs two ends, and with room for only the minimum, the other end is too much.
                        Slider(value: $dollars, in: Double(Self.minimum)...Double(max(room, Self.minimum + 1)), step: 1)
                            .disabled(room <= Self.minimum)
                        Text(wallet.usd(dollars: Int(dollars)))
                            .monospacedDigit()
                            .frame(width: 56, alignment: .trailing)
                    }
                }
                Text(caption)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if asset == .usdc, wallet.holdings.first(where: { $0.token.isNative })?.balance ?? 0 < SweepPlanner.minimumGasReserveWei {
                    Notice(.warning, "Buy some of it as ETH. This wallet needs a little to pay for its sweeps.")
                }
            }
            if let failure {
                WarningText(failure).font(.callout)
            }
            HStack {
                Spacer()
                if isStarting { ProgressView().controlSize(.small) }
                Button(room >= Self.minimum ? "Cancel" : "Done") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                if room >= Self.minimum {
                    Button("Continue on Coinbase") { Task { await start() } }
                        .keyboardShortcut(.defaultAction)
                        .disabled(cryptoAmount == nil || isStarting)
                }
            }
        }
        .padding(20)
        .frame(width: 460)
        .onAppear { dollars = Double(max(Self.minimum, min(room, 20))) }
        // A read can leave less room than there was when this opened. What's chosen stays if it still fits.
        .onChange(of: room) { dollars = max(Double(Self.minimum), min(dollars, Double(room))) }
    }

    private var caption: String {
        let amount = cryptoAmount.map { "About \($0) \(asset.rawValue). " } ?? ""
        return "\(amount)Coinbase adds its fees, and that total becomes its cost here."
    }

    private func start() async {
        guard let address = wallet.address, let cryptoAmount else { return }
        isStarting = true
        defer { isStarting = false }
        do {
            let page = try await purchases.begin(wallet: address.lowercased, asset: asset.rawValue, dollars: Int(dollars), cryptoAmount: cryptoAmount)
            openURL(page)
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
            if !phase.isFinished, phase != .onProvidersPage {
                ProgressView().controlSize(.small)
            }
            if phase.isFinished || phase == .onProvidersPage {
                Button(phase == .onProvidersPage ? "I Didn't Buy It" : "Dismiss", systemImage: "xmark.circle") { dismiss() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help(phase == .onProvidersPage ? "Stop waiting for this one" : "Dismiss")
            }
            if let hash = purchase.order?.txHash, let url = URL(string: "https://basescan.org/tx/\(hash)") {
                Link(destination: url) { Image(systemName: "arrow.up.right.square") }
                    .foregroundStyle(.secondary)
                    .help("Open this transaction")
            }
        }
    }
}
