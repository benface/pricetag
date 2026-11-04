import PricetagKit
import SwiftUI

/// The details: every number in here clicks through to its legs, price source and transaction, in the inspector.
struct MainWindow: View {
    let store: PortfolioStore
    @Bindable var navigation: Navigation
    @Environment(\.openWindow) private var openWindow

    private var portfolio: Portfolio? { store.portfolio }
    private var isLive: Bool { store.feed.isLive }

    var body: some View {
        content
            .frame(minWidth: 780, minHeight: 560)
            .navigationTitle(AppName.current)
            .navigationSubtitle(subtitle)
            .toolbar { toolbar }
            .inspector(isPresented: inspectorBinding) { inspector }
            .sheet(isPresented: $navigation.isChangingWallet) {
                WalletSheet(store: store)
            }
            .sheet(isPresented: $navigation.isExportingTaxReport) {
                TaxReportView(store: store) { navigation.isExportingTaxReport = false }
            }
            // What's open belongs to the wallet it was opened on.
            .onChange(of: store.address) {
                navigation.target = nil
                navigation.isExportingTaxReport = false
            }
    }

    private var subtitle: String {
        guard let address = store.address else { return "" }
        return address == WalletAddress.demo ? "Demo wallet" : Format.shortHash(address)
    }

    private var inspectorBinding: Binding<Bool> {
        Binding(get: { navigation.target != nil }, set: { if !$0 { navigation.target = nil } })
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .navigation) {
            Button("Change Wallet", systemImage: "wallet.bifold") { navigation.isChangingWallet = true }
                .help("Change wallet (⌘L)")
        }
        ToolbarItem(placement: .navigation) {
            Button("Spending Money", systemImage: "banknote") { openWindow(id: WindowID.hotWallet) }
                .help("This Mac's spending money (⇧⌘M)")
        }
        ToolbarItem(placement: .principal) {
            Picker(Wording.methodName, selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("\(Wording.methodHelp) (⌘1, ⌘2)")
        }
        ToolbarItem(placement: .primaryAction) {
            Button("Tax Report", systemImage: "doc.text") { navigation.isExportingTaxReport = true }
                .disabled(store.address == nil)
                .help("Export a tax report (⌘E)")
        }
        ToolbarItem(placement: .status) {
            FeedBadge(feed: store.feed, portfolio: portfolio)
                .padding(.horizontal, 6)
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let target = navigation.target {
            ExplanationPane(target: target, store: store)
                .inspectorColumnWidth(min: 320, ideal: 380, max: 520)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        Button("Close Details", systemImage: "xmark") { navigation.target = nil }
                            .keyboardShortcut(.cancelAction)
                            .help("Close (Esc)")
                    }
                }
        }
    }

    @ViewBuilder
    private var content: some View {
        if store.feed == .noWallet {
            Welcome(store: store)
        } else if let portfolio {
            details(portfolio)
        } else if store.feed == .reading {
            ContentUnavailableView {
                ProgressView().controlSize(.large)
            } description: {
                Text(Wording.reading)
            }
        } else {
            Unavailable(store: store)
        }
    }

    private func details(_ portfolio: Portfolio) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            notices(portfolio)
            if !portfolio.progress.started {
                ContentUnavailableView("Nothing to show yet", systemImage: "hourglass", description: Text(Wording.notStarted))
            } else if portfolio.isEmpty {
                ContentUnavailableView("No activity", systemImage: "tray", description: Text("Nothing moved for \(portfolio.address) in this time."))
            } else {
                summary(portfolio)
                history(portfolio)
                HoldingsTable(portfolio: portfolio, isLive: isLive, target: $navigation.target)
                    .frame(minHeight: 150)
            }
            if portfolio.progress.started {
                Text(Wording.coverage(portfolio))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(16)
    }

    /// The same size whichever it shows, so switching moves nothing else.
    private func history(_ portfolio: Portfolio) -> some View {
        GroupBox {
            Group {
                if navigation.showsTransactions {
                    TransactionsTable(transactions: portfolio.transactions, currency: portfolio.currency, isLive: isLive, target: $navigation.target)
                } else if portfolio.hasChartableData {
                    PnlChartView(points: portfolio.points, currency: portfolio.currency, isLive: isLive) { navigation.target = .transaction($0) }
                        .padding(6)
                } else {
                    Text(Wording.nothingToChart)
                        .foregroundStyle(.secondary)
                        .help(Wording.pnlHelp)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(height: 170)
        } label: {
            HStack {
                Spacer()
                Picker("History", selection: $navigation.showsTransactions) {
                    Text("Chart").tag(false)
                    Text("Transactions").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .fixedSize()
                .help("Chart or transactions (⌘T)")
            }
        }
    }

    @ViewBuilder
    private func notices(_ portfolio: Portfolio) -> some View {
        if let notice = store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) {
            Notice(.warning, notice)
        }
        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
    }

    private func summary(_ portfolio: Portfolio) -> some View {
        HStack(alignment: .top, spacing: 32) {
            PnlHeadline(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total(.pnl) }
                .frame(maxWidth: .infinity, alignment: .leading)
            HStack(alignment: .top, spacing: 26) {
                ForEach(portfolio.totalStats, id: \.metric) { stat in
                    TotalStat(label: stat.label, help: stat.help, text: stat.text, coverage: stat.coverage, isLive: isLive) { navigation.target = .total(stat.metric) }
                        .frame(minWidth: 88, alignment: .leading)
                }
            }
            // The headline's caveats can wrap, and these can't.
            .fixedSize()
        }
    }
}

/// Up and down move through positions and show each one's legs. Every number opens its own explanation.
private struct HoldingsTable: View {
    let portfolio: Portfolio
    let isLive: Bool
    @Binding var target: ExplainTarget?
    @State private var selection: Position.ID?

    private var currency: CurrencyCode { portfolio.currency }

    var body: some View {
        Table(portfolio.positions, selection: $selection) {
            TableColumn("Asset") { position in
                HStack(spacing: 5) {
                    Text(position.asset).fontWeight(.medium)
                    if let note = position.note {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .opacity(position.isHeld ? 1 : 0.6)
            }
            .width(min: 110, ideal: 170)
            TableColumn(Wording.balanceCheck) { position in
                Button {
                    target = .asset(position.asset, .onchain)
                } label: {
                    OnchainCheck(position: position, showsLabel: true)
                }
                .buttonStyle(NumberButtonStyle())
            }
            .width(min: 100, ideal: 120)
            TableColumn("Amount") { position in
                let warn = position.hasShortfall || position.isIncomplete
                number(position, .amount, Format.amount(position.values.qty, decimals: position.decimals), tone: warn ? .warning : .neutral, warn: warn)
            }
            .alignment(.numeric)
            TableColumn(Wording.averagePricePaid) { position in
                if position.isHeld {
                    number(position, .average, position.values.averageCostMicros.map { Format.price($0, currency) } ?? "Unknown", tone: position.hasUnknownCost ? .warning : .neutral, warn: position.hasUnknownCost)
                } else {
                    dash
                }
            }
            .width(min: 130, ideal: 140)
            .alignment(.numeric)
            TableColumn("Value") { position in
                if position.isHeld {
                    let value = position.values.valueMicros
                    number(position, .value, value.map { Format.money($0, currency) } ?? "No price", tone: value == nil ? .warning : .neutral, warn: value == nil)
                } else {
                    dash
                }
            }
            .alignment(.numeric)
            TableColumn("Realized") { position in
                let realized = position.values.realizedMicros
                number(position, .realized, realized.map { Format.signedMoney($0, currency) } ?? Wording.pnlUnavailable, tone: Tone(signed: realized), warn: realized == nil)
            }
            .width(min: 110, ideal: 130)
            .alignment(.numeric)
            TableColumn("Unrealized") { position in
                if position.isHeld {
                    let unrealized = position.values.unrealizedMicros
                    number(position, .unrealized, unrealized.map { Format.signedMoney($0, currency) } ?? Wording.pnlUnavailable, tone: Tone(signed: unrealized), warn: unrealized == nil)
                } else {
                    dash
                }
            }
            .width(min: 110, ideal: 130)
            .alignment(.numeric)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .onChange(of: selection) { _, asset in
            // Moving to a row shows its legs. A number clicked in that row has already said what to show.
            guard let asset, targetAsset != asset else { return }
            target = .asset(asset, .amount)
        }
        // The row follows the inspector, wherever it was opened from. Closing it ends the selection, so the same row can open it again.
        .onChange(of: target, initial: true) {
            selection = targetAsset
        }
    }

    private var targetAsset: String? {
        if case .asset(let asset, _) = target { asset } else { nil }
    }

    private var dash: some View {
        Text("—").foregroundStyle(.tertiary)
    }

    private func number(_ position: Position, _ metric: AssetMetric, _ text: String, tone: Tone, warn: Bool) -> some View {
        Button {
            target = .asset(position.asset, metric)
        } label: {
            HStack(spacing: 4) {
                if warn { WarningIcon() }
                LiveNumber(text, tone: isLive ? tone : (warn ? .warning : .neutral))
                    .lineLimit(1)
            }
            .opacity(isLive ? (position.isHeld ? 1 : 0.6) : 0.55)
        }
        .buttonStyle(NumberButtonStyle())
        .help(metric.help ?? "")
        .accessibilityLabel("\(position.asset) \(metric.label), \(text)")
    }
}

/// Each transaction the chart plots. Up and down move through them and show each one's legs.
private struct TransactionsTable: View {
    let transactions: [PnlPoint]
    let currency: CurrencyCode
    let isLive: Bool
    @Binding var target: ExplainTarget?
    @State private var selection: PnlPoint.ID?
    @FocusState private var isFocused: Bool

    private var targetHash: String? {
        if case .transaction(let hash) = target { hash } else { nil }
    }

    var body: some View {
        Table(transactions, selection: $selection) {
            TableColumn("Time") { point in
                Text(point.date.map(Format.time) ?? point.timestamp)
            }
            TableColumn("Total PnL after") { point in
                HStack(spacing: 4) {
                    if point.pnlMicros == nil { WarningIcon() }
                    LiveNumber(point.pnlMicros.map { Format.signedMoney($0, currency) } ?? "Unavailable", tone: isLive ? Tone(signed: point.pnlMicros) : .neutral)
                }
                .help(Wording.pnlHelp)
            }
            .alignment(.numeric)
            TableColumn("Leaves out") { point in
                if point.excludedCount > 0 {
                    LiveNumber("\(point.excludedCount) unknown", tone: .warning)
                } else {
                    Text("—").foregroundStyle(.tertiary)
                }
            }
            .alignment(.numeric)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .focused($isFocused)
        .onAppear { isFocused = true }
        .onChange(of: selection) { _, id in
            guard let hash = transactions.first(where: { $0.id == id })?.txHash, hash != targetHash else { return }
            target = .transaction(hash)
        }
        .onChange(of: target, initial: true) {
            selection = transactions.first { $0.txHash == targetHash }?.id
        }
        .accessibilityLabel("Transactions")
    }
}

private struct WarningIcon: View {
    @Environment(\.backgroundProminence) private var prominence

    var body: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.caption2)
            .foregroundStyle(prominence == .increased ? Tone.neutral.style : Tone.warning.style)
    }
}

private struct Welcome: View {
    let store: PortfolioStore

    var body: some View {
        ContentUnavailableView {
            Label("Every transfer gets a price", systemImage: "tag")
        } description: {
            Text("Add a Base address to see its holdings, cost and PnL, with every number explained. This is view-only: there are no keys here, and it can't send anything.")
                .help(Wording.pnlHelp)
        } actions: {
            WalletForm(store: store, onDone: {})
                .frame(width: 440)
        }
    }
}

private struct Unavailable: View {
    let store: PortfolioStore

    var body: some View {
        ContentUnavailableView {
            Label("Can't show this wallet", systemImage: "exclamationmark.triangle")
        } description: {
            Text(store.feed.staleNotice(serverURL: store.serverURL, portfolio: nil) ?? "")
        } actions: {
            Button("Try Again") { store.start() }
            if store.address != WalletAddress.demo {
                // A button, never automatic: fixtures must not quietly stand in for someone's real wallet.
                Button("Use the Demo Wallet") { store.setWallet(WalletAddress.demo) }
            }
        }
    }
}

struct WalletSheet: View {
    let store: PortfolioStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Change Wallet").font(.headline)
            WalletForm(store: store) { dismiss() }
            HStack {
                Spacer()
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
        }
        .padding(18)
        .frame(width: 480)
    }
}

/// Addresses only. Nothing in this app ever asks for a key or a recovery phrase.
struct WalletForm: View {
    let store: PortfolioStore
    let onDone: () -> Void
    @State private var input = ""
    @State private var error: String?
    @FocusState private var isFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField("Paste any Base address, 0x…", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    .autocorrectionDisabled()
                    .focused($isFocused)
                    .onSubmit(submit)
                Button("Look Up", action: submit)
                    .keyboardShortcut(.defaultAction)
                    .disabled(input.isEmpty)
                    .fixedSize()
            }
            if let error {
                WarningText(error).font(.callout)
            }
            Button("Try the demo wallet") {
                store.setWallet(WalletAddress.demo)
                onDone()
            }
            .buttonStyle(.link)
        }
        .onAppear { isFocused = true }
    }

    private func submit() {
        let value = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard WalletAddress.isValid(value) else {
            error = Wording.notAnAddress
            return
        }
        error = nil
        store.setWallet(value)
        onDone()
    }
}
