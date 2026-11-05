import HotWalletKit
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
    var hotWallet: HotWallet?
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
                ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, noteWriter: hotWallet)
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
            if let open = portfolio?.questions.count, open > 0 {
                Button("Resolve \(open)", systemImage: "questionmark.circle") { navigation.resolve() }
                    .help("Answer what the app can't work out by itself (⇧⌘R)")
            }
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
            Welcome(store: store, hotWallet: hotWallet)
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
                    VStack(alignment: .leading, spacing: 14) {
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
                            HoldingsTable(portfolio: portfolio, isLive: isLive, target: $navigation.target) { navigation.resolve($0) }
                                .frame(minHeight: 140)
                            if let noMarket = Wording.noMarket(portfolio) {
                                Text(noMarket)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            coverageNote(portfolio)
                        }
                    }
                    .padding(16)
                }
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func coverageNote(_ portfolio: Portfolio) -> some View {
        Text(Wording.coverage(portfolio))
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// The same size whichever it shows, so switching moves nothing else. It gives up some height before the page has to scroll.
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
            .frame(minHeight: 120, idealHeight: 170, maxHeight: 170)
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
        if !portfolio.linkedFailed.isEmpty {
            HStack(spacing: 8) {
                Notice(.warning, Wording.linkedFailed(portfolio.linkedFailed.count))
                Button("Try Again") { store.start() }
            }
        }
        if !portfolio.linkedReading.isEmpty {
            Notice(.info, "Reading your other \(portfolio.linkedReading.count == 1 ? "wallet" : "wallets"). What came from \(portfolio.linkedReading.count == 1 ? "it" : "them") shows as unresolved until that's done.")
        }
    }

    private func summary(_ portfolio: Portfolio) -> some View {
        HStack(alignment: .top, spacing: 32) {
            PnlHeadline(portfolio: portfolio, isLive: isLive, size: 40, onOpen: { navigation.target = .total(.pnl) }, onResolve: { navigation.resolve() })
                // Short of height, its amounts would shrink and cut off instead of the page scrolling.
                .fixedSize(horizontal: false, vertical: true)
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

    /// What each column needs.
    private enum Column {
        static let asset: CGFloat = 160
        static let balanceCheck: CGFloat = 100
        static let amount: CGFloat = 100
        static let averagePrice: CGFloat = 130
        static let value: CGFloat = 85
        static let realized: CGFloat = 120
        static let unrealized: CGFloat = 165

        static let balanceCheckID = "balance-check"
        static let averagePriceID = "average-price"

        /// A column that was hidden comes back wider than it left, more so each time, unless something stops it.
        static let comebackRoom: CGFloat = 30

        /// All seven, with what the table adds around them, and the two that come back at their widest.
        static let allWidth = asset + balanceCheck + amount + averagePrice + value + realized + unrealized + 155 + 2 * comebackRoom
    }

    /// Below the width all seven need, which is the default window with the details open and the smallest window without them,
    /// two columns give way. The balance check moves next to the asset, and the average price paid is in the details' menu.
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
                    // A problem with the balance stays visible without its column.
                    if isNarrow {
                        balanceCheck(position, showsLabel: false)
                            .frame(width: 14)
                    }
                    Text(position.asset).fontWeight(.medium)
                    if let note = position.note {
                        Text(note).font(.caption).foregroundStyle(.secondary)
                    }
                }
                .opacity(position.isHeld ? 1 : 0.6)
            }
            .width(min: Column.asset, ideal: Column.asset, max: limit(Column.asset))
            .disabledCustomizationBehavior(.all)
            TableColumn(Wording.balanceCheck) { position in
                balanceCheck(position, showsLabel: true)
            }
            .width(min: Column.balanceCheck, ideal: Column.balanceCheck, max: Column.balanceCheck + Column.comebackRoom)
            .customizationID(Column.balanceCheckID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Amount") { position in
                let warn = position.hasShortfall || position.isIncomplete
                number(position, .amount, Format.amount(position.values.qty, decimals: position.decimals), tone: warn ? .warning : .neutral, warn: warn)
            }
            .width(min: Column.amount, ideal: Column.amount, max: limit(Column.amount))
            .disabledCustomizationBehavior(.all)
            .alignment(.numeric)
            TableColumn(Wording.averagePricePaid) { position in
                if position.isHeld {
                    number(position, .average, position.values.averageCostMicros.map { Format.estimate(Format.price($0, currency), position.estimates.cost) } ?? "Unknown", tone: position.hasUnknownCost ? .warning : .neutral, warn: position.hasUnknownCost)
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
                    number(position, .value, value.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price", tone: value == nil ? .warning : .neutral, warn: value == nil)
                } else {
                    dash
                }
            }
            .width(min: Column.value, ideal: Column.value, max: limit(Column.value))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Realized") { position in
                let realized = position.values.realizedMicros
                number(position, .realized, realized.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized) } ?? Wording.pnlUnavailable, tone: Tone(signed: realized), warn: realized == nil)
            }
            .width(min: Column.realized, ideal: Column.realized, max: limit(Column.realized))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Unrealized") { position in
                if position.isHeld {
                    let unrealized = position.values.unrealizedMicros
                    HStack(spacing: 6) {
                        number(position, .unrealized, unrealized.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.unrealized) } ?? Wording.pnlUnavailable, tone: Tone(signed: unrealized), warn: unrealized == nil)
                        if position.resolvable {
                            Button("Resolve") { onResolve(position.asset) }
                                .controlSize(.mini)
                                .accessibilityLabel("Resolve \(position.asset)")
                        }
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
        // Not `if` around the columns: a column that comes back that way lands at the end, under another column's header.
        .onChange(of: isNarrow, initial: true) {
            columns[visibility: Column.balanceCheckID] = isNarrow ? .hidden : .visible
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

    private func balanceCheck(_ position: Position, showsLabel: Bool) -> some View {
        Button {
            target = .asset(position.asset, .onchain)
        } label: {
            OnchainCheck(position: position, showsLabel: showsLabel)
        }
        .buttonStyle(NumberButtonStyle())
    }

    private func number(_ position: Position, _ metric: AssetMetric, _ text: String, tone: Tone, warn: Bool) -> some View {
        Button {
            target = .asset(position.asset, metric)
        } label: {
            HStack(spacing: 4) {
                if warn { WarningIcon() }
                LiveNumber(text, tone: isLive ? tone : (warn ? .warning : .neutral))
                    .lineLimit(1)
                    // A long amount gets smaller rather than losing digits.
                    .minimumScaleFactor(0.7)
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
    let hotWallet: HotWallet?
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        ContentUnavailableView {
            Label("Every transfer gets a price", systemImage: "tag")
        } description: {
            Text("See the holdings, cost and PnL of any Base wallet, with every number explained. A wallet you look up is only read, and nothing signs for it.")
                .help(Wording.pnlHelp)
        } actions: {
            VStack(spacing: 20) {
                spendingMoney
                WalletForm(store: store, onDone: {})
            }
            .frame(width: 440)
        }
    }

    /// Nothing to offer on a build that can't hold a key. The rest of this screen still works there.
    @ViewBuilder
    private var spendingMoney: some View {
        if let hotWallet, hotWallet.availability == .ready {
            VStack(spacing: 6) {
                if let address = hotWallet.address {
                    Button("Show Spending Money") { store.setWallet(address.lowercased) }
                        .buttonStyle(.borderedProminent)
                    Text("This Mac already has spending money.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                } else {
                    // The window says what this is and what can go wrong, and only it makes the key.
                    Button("Create Spending Money…") { openWindow(id: WindowID.hotWallet) }
                        .buttonStyle(.borderedProminent)
                    Text(HotWalletWording.summary)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            }
            HStack {
                VStack { Divider() }
                Text("or").font(.callout).foregroundStyle(.secondary)
                VStack { Divider() }
            }
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
