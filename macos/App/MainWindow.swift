import PricetagKit
import SwiftUI
import UniformTypeIdentifiers

/// The file a CSV export writes.
struct CSVDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.commaSeparatedText]
    let text: String

    init(text: String) {
        self.text = text
    }

    init(configuration: ReadConfiguration) throws {
        text = configuration.file.regularFileContents.flatMap { String(data: $0, encoding: .utf8) } ?? ""
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(text.utf8))
    }
}

/// The details: every number in here clicks through to its legs, price source and transaction, in the inspector.
struct MainWindow: View {
    let store: PortfolioStore
    @Bindable var navigation: Navigation
    var noteWriter: (any CostNoteWriter)?
    @State private var exporting = false
    @State private var exportDocument: CSVDocument?
    @State private var exportError: String?
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
            .sheet(isPresented: $navigation.isResolving) {
                ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, noteWriter: noteWriter)
            }
            .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .commaSeparatedText, defaultFilename: "\(AppName.current) \(subtitle)") { result in
                if case .failure(let error) = result { exportError = error.localizedDescription }
                exportDocument = nil
            }
            .alert("Couldn't export", isPresented: Binding(get: { exportError != nil }, set: { if !$0 { exportError = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(exportError ?? "")
            }
            // The menu asks for it. The file's written only once the server has answered.
            .onChange(of: navigation.isExporting) { _, asked in
                guard asked else { return }
                navigation.isExporting = false
                Task {
                    do {
                        exportDocument = CSVDocument(text: try await store.exportCSV())
                        exporting = true
                    } catch {
                        exportError = "The server couldn't make this file."
                    }
                }
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
        let wallet = address == WalletAddress.demo ? "Demo wallet" : Format.shortHash(address)
        return store.activeRuleName.map { "\(wallet) · \($0)" } ?? wallet
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
                .safeAreaBar(edge: .top) { metricPicker(target) }
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

    /// Every number in the asset's row, including those the holdings table has no room for when it's narrow.
    @ViewBuilder
    private func metricPicker(_ target: ExplainTarget) -> some View {
        if case .asset(let asset, let metric) = target, let position = portfolio?.positions.first(where: { $0.asset == asset }) {
            Picker("Show", selection: Binding(get: { metric }, set: { navigation.target = .asset(asset, $0) })) {
                ForEach(position.explainableMetrics, id: \.self) { Text($0.title).tag($0) }
            }
            .pickerStyle(.menu)
            .fixedSize()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
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

    /// Fills the window while it fits, with the table taking what's spare, and scrolls once it needs more height than the window has.
    private func details(_ portfolio: Portfolio) -> some View {
        GeometryReader { window in
            ScrollView {
                AtLeastHeight(window.size.height) {
                    VStack(alignment: .leading, spacing: 16) {
                        notices(portfolio)
                        if !portfolio.progress.started {
                            ContentUnavailableView("Still catching up", systemImage: "hourglass", description: Text(Wording.notStarted))
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else if portfolio.isEmpty {
                            VStack(spacing: 14) {
                                ContentUnavailableView("No activity", systemImage: "tray", description: Text("Nothing moved for \(Format.shortHash(portfolio.address)) in this time."))
                                coverageNote(portfolio)
                                    .multilineTextAlignment(.center)
                            }
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                        } else {
                            summary(portfolio)
                            HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: isLive) { navigation.target = .holdComparison }
                            history(portfolio)
                            VStack(alignment: .leading, spacing: 4) {
                                Text("Holdings").font(.headline)
                                HoldingsTable(portfolio: portfolio, isLive: isLive, target: $navigation.target) { navigation.resolve($0) }
                            }
                            .frame(minHeight: 160)
                            VStack(alignment: .leading, spacing: 2) {
                                if let noMarket = Wording.noMarket(portfolio) {
                                    Text(noMarket)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .fixedSize(horizontal: false, vertical: true)
                                }
                                coverageNote(portfolio)
                            }
                        }
                    }
                    .padding(16)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func coverageNote(_ portfolio: Portfolio) -> some View {
        Text([Wording.allBalancesMatch(portfolio), Wording.coverage(portfolio)].compactMap(\.self).joined(separator: " "))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The same size whether it's the chart or the list, so switching moves nothing else, and it gives up some height before the page has to scroll.
    /// With too little to plot, it says so in one line and leaves the room to the holdings.
    private func history(_ portfolio: Portfolio) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("History").font(.headline)
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
            if navigation.showsTransactions {
                TransactionsTable(transactions: portfolio.transactions, currency: portfolio.currency, isLive: isLive, target: $navigation.target)
                    .frame(minHeight: 120, idealHeight: 170, maxHeight: 170)
            } else if !portfolio.hasChartableData {
                nothingToChart(Wording.nothingToChart, detail: nil)
                    .help(Wording.pnlHelp)
            } else if portfolio.isTooNewToChart {
                nothingToChart(Wording.tooNewToChart, detail: Wording.transactionsSoFar(portfolio.transactions.count))
            } else {
                PnlChartView(points: portfolio.points, currency: portfolio.currency, isLive: isLive) { navigation.target = .transaction($0) }
                    .frame(minHeight: 120, idealHeight: 170, maxHeight: 170)
            }
        }
    }

    private func nothingToChart(_ title: String, detail: String?) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "chart.xyaxis.line")
                .foregroundStyle(.tertiary)
            Text(title)
            if let detail {
                Text(detail).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
        }
        .font(.callout)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(.quaternary.opacity(0.35), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    @ViewBuilder
    private func notices(_ portfolio: Portfolio) -> some View {
        if let notice = store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) {
            Notice(.warning, notice)
        }
        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
        if !portfolio.linkedFailed.isEmpty {
            HStack(spacing: 8) {
                Notice(.warning, Wording.linkedFailed(portfolio.linkedFailed.count))
                Button("Try Again") { store.start() }
            }
        }
        if !portfolio.linkedReading.isEmpty {
            Notice(.info, "Reading your other \(portfolio.linkedReading.count == 1 ? "wallet" : "wallets"). What came from \(portfolio.linkedReading.count == 1 ? "it" : "them") has an unknown cost until that's done.")
        }
    }

    private func summary(_ portfolio: Portfolio) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            PortfolioSummary(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total($0) }
                // Short of height, its amounts would shrink and cut off instead of the page scrolling.
                .fixedSize(horizontal: false, vertical: true)
            PortfolioAttention(portfolio: portfolio, onOpen: { navigation.target = $0 }, onResolve: { navigation.resolve() })
        }
    }
}

/// Offers its content a height, and is taller if the content needs more. A scroll view offers none, and a frame with an ideal height stops at that height, which leaves nothing to scroll.
private struct AtLeastHeight: Layout {
    let height: CGFloat

    init(_ height: CGFloat) {
        self.height = height
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let fit = subviews.first?.sizeThatFits(ProposedViewSize(width: proposal.width, height: height)) ?? .zero
        return CGSize(width: fit.width, height: max(fit.height, height))
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        // The same offer as above. Offered what it asked for instead, the chart grows again and the page runs past its end.
        subviews.first?.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: height))
    }
}

/// Up and down move through positions and show each one's legs. Every number opens its own explanation.
private struct HoldingsTable: View {
    let portfolio: Portfolio
    let isLive: Bool
    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @State private var selection: Position.ID?
    @State private var width: CGFloat = 0
    @State private var columns = TableColumnCustomization<Position>()

    private var currency: CurrencyCode { portfolio.currency }

    /// What each column needs, for what's usually in it. A column can always grow if there's room.
    private enum Column {
        static let asset: CGFloat = 170
        static let amount: CGFloat = 100
        static let averagePrice: CGFloat = 105
        static let value: CGFloat = 100
        static let realized: CGFloat = 100
        static let unrealized: CGFloat = 145

        static let averagePriceID = "average-price"

        /// A column that was hidden comes back wider than it left, more so each time, unless something stops it.
        static let comebackRoom: CGFloat = 30

        /// All six, with what the table adds around them, and the one that comes back at its widest.
        static let allWidth = asset + amount + averagePrice + value + realized + unrealized + 130 + comebackRoom
    }

    /// Below the width all six need, which is the default window with the details open and the smallest window without them,
    /// the average price paid gives way. It's in the details' menu.
    private var isNarrow: Bool { width < Column.allWidth }

    /// Hiding a column doesn't give its width to the others, so when narrow, each stops at what it needs, and the five always fit.
    /// Only a change of limits reaches the rows: setting a column's width outright moves its header and leaves its cells behind.
    private func limit(_ width: CGFloat) -> CGFloat? {
        isNarrow ? width : nil
    }

    var body: some View {
        Table(portfolio.listedPositions, selection: $selection, columnCustomization: $columns) {
            TableColumn("Asset") { position in
                HStack(spacing: 5) {
                    Text(position.asset).fontWeight(.medium)
                    if let note = position.note {
                        Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    // Once per row, however many of its numbers it affects. A balance that matches says nothing.
                    balanceCheck(position)
                }
                .opacity(position.isHeld ? 1 : 0.6)
            }
            .width(min: Column.asset, ideal: Column.asset, max: limit(Column.asset))
            .disabledCustomizationBehavior(.all)
            TableColumn("Amount") { position in
                number(position, .amount, Format.amount(position.values.qty, decimals: position.decimals), tone: .neutral)
            }
            .width(min: Column.amount, ideal: Column.amount, max: limit(Column.amount))
            .disabledCustomizationBehavior(.all)
            .alignment(.numeric)
            TableColumn("Average paid") { position in
                if position.isHeld {
                    number(position, .average, position.values.averageCostMicros.map { Format.estimate(Format.price($0, currency), position.estimates.cost) } ?? Wording.unknown, tone: position.hasUnknownCost ? .secondary : .neutral)
                } else {
                    dash
                }
            }
            .width(min: Column.averagePrice, ideal: Column.averagePrice, max: Column.averagePrice + Column.comebackRoom)
            .alignment(.numeric)
            .customizationID(Column.averagePriceID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Value") { position in
                if position.isHeld {
                    let value = position.values.valueMicros
                    number(position, .value, value.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price", tone: value == nil ? .secondary : .neutral)
                } else {
                    dash
                }
            }
            .width(min: Column.value, ideal: Column.value, max: limit(Column.value))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Realized") { position in
                let realized = position.values.realizedMicros
                number(position, .realized, realized.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized) } ?? Wording.unknown, tone: realized == nil ? .secondary : Tone(signed: realized))
            }
            .width(min: Column.realized, ideal: Column.realized, max: limit(Column.realized))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Unrealized") { position in
                if position.isHeld {
                    let unrealized = position.values.unrealizedMicros
                    HStack(spacing: 6) {
                        if position.resolvable {
                            Button("Fill In") { onResolve(position.asset) }
                                .controlSize(.mini)
                                .accessibilityLabel("Fill in \(position.asset)'s cost")
                                .help("Answer what the app can't work out about \(position.asset)")
                        }
                        number(position, .unrealized, unrealized.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.unrealized) } ?? Wording.unknown, tone: unrealized == nil ? .secondary : Tone(signed: unrealized))
                    }
                } else {
                    dash
                }
            }
            .width(min: Column.unrealized, ideal: Column.unrealized, max: limit(Column.unrealized))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        // Not `if` around the column: a column that comes back that way lands at the end, under another column's header.
        .onChange(of: isNarrow, initial: true) {
            columns[visibility: Column.averagePriceID] = isNarrow ? .hidden : .visible
        }
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

    private func balanceCheck(_ position: Position) -> some View {
        Button {
            target = .asset(position.asset, .onchain)
        } label: {
            OnchainCheck(position: position)
        }
        .buttonStyle(NumberButtonStyle())
    }

    private func number(_ position: Position, _ metric: AssetMetric, _ text: String, tone: Tone) -> some View {
        Button {
            target = .asset(position.asset, metric)
        } label: {
            LiveNumber(text, tone: isLive ? tone : .neutral)
                .lineLimit(1)
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
                LiveNumber(point.pnlMicros.map { Format.signedMoney($0, currency) } ?? "Unavailable", tone: point.pnlMicros == nil ? .secondary : isLive ? Tone(signed: point.pnlMicros) : .neutral)
                    .help(Wording.pnlHelp)
            }
            .alignment(.numeric)
            TableColumn("Leaves out") { point in
                if point.excludedCount > 0 {
                    LiveNumber("\(point.excludedCount) unknown", tone: .secondary)
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
