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

/// A sidebar of sections, and the section. Every number clicks through to what's behind it.
struct MainWindow: View {
    let store: PortfolioStore
    @Bindable var navigation: Navigation
    let hotWallet: HotWallet
    let siteBridge: SiteBridge
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var width: CGFloat = 1120
    @State private var exporting = false
    @State private var exportDocument: CSVDocument?
    @State private var exportError: String?

    /// How small the window can get, with the sidebar closed. It closes by itself below `sidebarWidth`.
    static let minimumSize = CGSize(width: 480, height: 400)
    private static let sidebarWidth: CGFloat = 640
    private static let titleWidth: CGFloat = 560
    /// Below this the details open over the window, because there's no room beside the section.
    private static let inspectorWidth: CGFloat = 900

    private var portfolio: Portfolio? { store.portfolio }
    private var isLive: Bool { store.feed.isLive }
    private var usesSheetForDetails: Bool { width < Self.inspectorWidth }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } detail: {
            page
                .frame(minWidth: 320, minHeight: 320)
                .navigationTitle(navigation.section.title)
                // The wallet comes first when there's only room for one of them.
                .toolbar(removing: width < Self.titleWidth ? .title : nil)
                .toolbar { toolbar }
                .inspector(isPresented: inspectorBinding) { inspector }
        }
        .frame(minWidth: Self.minimumSize.width, minHeight: Self.minimumSize.height)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { newWidth in
            let wasWide = width >= Self.sidebarWidth
            let isWide = newWidth >= Self.sidebarWidth
            width = newWidth
            if wasWide != isWide { columns = isWide ? .all : .detailOnly }
        }
        .sheet(isPresented: detailsSheetBinding) { detailsSheet }
        .sheet(isPresented: $navigation.isResolving) {
            ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, noteWriter: hotWallet)
        }
        .fileExporter(isPresented: $exporting, document: exportDocument, contentType: .commaSeparatedText, defaultFilename: exportName) { result in
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
        // What's open belongs to the wallet it was opened on.
        .onChange(of: store.address) {
            navigation.target = nil
            navigation.isResolving = false
        }
        // Or it would open again by itself with the window.
        .onDisappear { navigation.isSwitchingWallet = false }
    }

    private var sidebar: some View {
        List(selection: Binding(get: { navigation.section }, set: { if let section = $0 { navigation.section = section } })) {
            ForEach(AppSection.allCases) { section in
                Label(section.title, systemImage: section.symbol).tag(section)
            }
        }
        .navigationSplitViewColumnWidth(min: 150, ideal: 190, max: 260)
        // A status, so it looks like one: it's text, and it's down here with nothing around it that suggests a click.
        .safeAreaInset(edge: .bottom) {
            if store.feed != .noWallet {
                FeedBadge(feed: store.feed, portfolio: portfolio)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 10)
            }
        }
    }

    private var walletTitle: String? {
        store.walletList(hotWallet: hotWallet).entry(for: store.address)?.title
    }

    /// A name can hold what a file's name can't.
    private var exportName: String {
        [AppName.current, walletTitle, store.activeRuleName].compactMap(\.self).joined(separator: " ")
            .replacing(/[\/:]/, with: "-")
    }

    private var inspectorBinding: Binding<Bool> {
        Binding(get: { navigation.target != nil && !usesSheetForDetails }, set: { if !$0 { navigation.target = nil } })
    }

    private var detailsSheetBinding: Binding<Bool> {
        Binding(get: { navigation.target != nil && usesSheetForDetails }, set: { if !$0 { navigation.target = nil } })
    }

    /// Only what does something in this section. The leading slot is the wallet's.
    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if navigation.section != .spendingMoney {
            ToolbarItem(placement: .navigation) {
                WalletButton(store: store, hotWallet: hotWallet, navigation: navigation, maxWidth: width < Self.sidebarWidth ? 230 : 300)
            }
        }
        // With no title in a small window, nothing else would hold the rest at the far end.
        ToolbarSpacer(.flexible)
        if store.address != nil, navigation.section == .overview || navigation.section == .transactions {
            ToolbarItem(placement: .primaryAction) {
                Button("Refresh", systemImage: "arrow.clockwise") { store.start() }
                    .help("Refresh (⌘R)")
            }
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let target = navigation.target {
            ExplanationPane(target: target, store: store)
                .safeAreaBar(edge: .top) { metricPicker(target) }
                .inspectorColumnWidth(min: 300, ideal: 360, max: 520)
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
    private var detailsSheet: some View {
        if let target = navigation.target {
            VStack(spacing: 0) {
                HStack {
                    metricPicker(target)
                    Spacer(minLength: 8)
                    Button("Done") { navigation.target = nil }
                        .keyboardShortcut(.cancelAction)
                }
                .padding(12)
                Divider()
                ExplanationPane(target: target, store: store)
            }
            .frame(minWidth: 320, idealWidth: 420, minHeight: 320, idealHeight: 520)
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
            .labelsHidden()
            .fixedSize()
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
    }

    @ViewBuilder
    private var page: some View {
        switch navigation.section {
        case .overview: walletPage(overview)
        case .transactions: walletPage(transactions)
        case .spendingMoney: HotWalletWindow(wallet: hotWallet, store: store, siteBridge: siteBridge, navigation: navigation)
        case .taxReport:
            if store.address == nil {
                NoWalletYet(navigation: navigation)
            } else {
                TaxReportView(store: store)
            }
        }
    }

    /// A section that shows a wallet, or says why there's nothing to show.
    @ViewBuilder
    private func walletPage(_ content: @escaping (Portfolio) -> some View) -> some View {
        if store.feed == .noWallet {
            if navigation.section == .overview {
                Welcome(store: store, hotWallet: hotWallet, navigation: navigation)
            } else {
                NoWalletYet(navigation: navigation)
            }
        } else if let portfolio {
            if !portfolio.progress.started {
                ContentUnavailableView("Almost There", systemImage: "hourglass", description: Text(Wording.notStarted))
            } else if portfolio.isEmpty {
                NoActivity(portfolio: portfolio, navigation: navigation, notices: notices(portfolio))
            } else {
                content(portfolio)
            }
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

    /// Fills the window: the chart takes the height the rest doesn't use, within reason, and the page scrolls once it needs more than there is.
    private func overview(_ portfolio: Portfolio) -> some View {
        GeometryReader { window in
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    notices(portfolio)
                    PortfolioSummary(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total($0) }
                        // Short of height, its amounts would shrink and cut off instead of the page scrolling.
                        .fixedSize(horizontal: false, vertical: true)
                    PortfolioAttention(portfolio: portfolio, onOpen: { navigation.target = $0 }, onResolve: { navigation.resolve() })
                    PnlHistorySection(portfolio: portfolio, isLive: isLive, range: $navigation.chartRange) { navigation.target = .transaction($0) }
                        .frame(height: portfolio.hasChartableData && !portfolio.isTooNewToChart ? chartHeight(window.size.height, rows: portfolio.listedPositions.count) : nil)
                    HoldingsSection(portfolio: portfolio, store: store, isLive: isLive, target: $navigation.target) { navigation.resolve($0) }
                    HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: isLive) { navigation.target = .holdComparison }
                }
                // A line of numbers gets hard to read across a very wide window.
                .frame(maxWidth: 1280, alignment: .leading)
                .padding(window.size.width < 520 ? 14 : 20)
                .frame(maxWidth: .infinity)
            }
            .scrollBounceBehavior(.basedOnSize)
        }
    }

    private func chartHeight(_ pageHeight: CGFloat, rows: Int) -> CGFloat {
        let rest = 430 + CGFloat(rows) * HoldingsTable.rowHeight
        return min(max(pageHeight - rest, 200), 460)
    }

    private func transactions(_ portfolio: Portfolio) -> some View {
        VStack(spacing: 0) {
            let notices = notices(portfolio)
            notices.padding(12)
            if portfolio.transactions.isEmpty {
                ContentUnavailableView("No Transactions Yet", systemImage: "list.bullet", description: Text("They'll show up here as they happen."))
            } else {
                TransactionsTable(transactions: portfolio.transactions, currency: portfolio.currency, isLive: isLive, target: $navigation.target)
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
            Notice(.info, "Reading your other \(portfolio.linkedReading.count == 1 ? "wallet" : "wallets"). Until then, what came from \(portfolio.linkedReading.count == 1 ? "it" : "them") has an unknown cost.")
        }
    }
}

/// Rarely changed, so it sits quietly by the numbers it affects. It says what's in use, because the numbers depend on it.
struct CostMethodMenu: View {
    let store: PortfolioStore

    var body: some View {
        Menu {
            Picker(Wording.methodName, selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Text("Cost: \(store.method.label)")
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)
        .fixedSize()
        .foregroundStyle(.secondary)
        .help(Wording.methodHelp)
    }
}

/// What a wallet holds: a table when there's room for its columns, and two-line rows when there isn't.
private struct HoldingsSection: View {
    let portfolio: Portfolio
    let store: PortfolioStore
    let isLive: Bool
    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @State private var width: CGFloat = 800
    @State private var showsAbout = false

    private static let tableWidth: CGFloat = 560

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text("Holdings").font(.headline)
                if let matches = Wording.allBalancesMatch(portfolio) {
                    Image(systemName: "checkmark.seal.fill")
                        .font(.callout)
                        .foregroundStyle(Tone.gain.style)
                        .help(matches)
                        .accessibilityLabel(matches)
                }
                Spacer(minLength: 8)
                if let rule = store.activeRuleName {
                    Text("\(Wording.rulesTitle): \(rule)")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                CostMethodMenu(store: store)
                Button("About This Data", systemImage: "info.circle") { showsAbout.toggle() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help("What this covers")
                    .popover(isPresented: $showsAbout, arrowEdge: .bottom) { about }
            }
            if width >= Self.tableWidth {
                HoldingsTable(portfolio: portfolio, isLive: isLive, width: width, target: $target, onResolve: onResolve)
                    .frame(height: HoldingsTable.height(rows: portfolio.listedPositions.count))
            } else {
                rows
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
    }

    /// The fine print, for whoever wants it.
    private var about: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Wording.coverage(portfolio))
            if let noMarket = Wording.noMarket(portfolio) { Text(noMarket) }
        }
        .font(.callout)
        .fixedSize(horizontal: false, vertical: true)
        .padding(14)
        .frame(width: 300)
    }

    private var rows: some View {
        VStack(spacing: 0) {
            ForEach(portfolio.listedPositions) { position in
                Button { target = .asset(position.asset, .amount) } label: {
                    CompactHolding(position: position, currency: portfolio.currency, isLive: isLive)
                }
                .buttonStyle(.plain)
                Divider()
            }
        }
    }
}

/// A holding in a narrow window: what it is and how much, then what it's worth and how it's done. The rest is in its details.
private struct CompactHolding: View {
    let position: Position
    let currency: CurrencyCode
    let isLive: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    Text(position.asset).fontWeight(.medium)
                    OnchainCheck(position: position)
                }
                LiveNumber(Format.amount(position.values.qty, decimals: position.decimals), tone: .secondary).font(.caption)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                LiveNumber(position.isHeld ? position.values.valueMicros.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price" : "—", tone: position.values.valueMicros == nil ? .secondary : .neutral)
                LiveNumber(position.pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized || position.estimates.unrealized) } ?? Wording.pnlUnavailable, tone: position.pnlMicros == nil ? .secondary : Tone(signed: position.pnlMicros))
                    .font(.caption)
            }
        }
        .lineLimit(1)
        .padding(.vertical, 7)
        .opacity(isLive ? (position.isHeld ? 1 : 0.6) : 0.55)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

/// Up and down move through positions and show each one's legs. Every number opens its own explanation.
private struct HoldingsTable: View {
    let portfolio: Portfolio
    let isLive: Bool
    /// As much as there is, because a hidden column doesn't give its width to the others.
    let width: CGFloat
    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @State private var selection: Position.ID?
    @State private var columns = TableColumnCustomization<Position>()

    private var currency: CurrencyCode { portfolio.currency }

    static let rowHeight: CGFloat = 28

    /// Exactly its rows, so the page does the scrolling and no row is cut off inside a shorter table.
    static func height(rows: Int) -> CGFloat {
        CGFloat(rows) * rowHeight + 40
    }

    /// What each column needs, for what's usually in it. A column can always grow if there's room.
    private enum Column {
        static let asset: CGFloat = 130
        /// With a note and a warning beside its name.
        static let assetRoom: CGFloat = 175
        static let amount: CGFloat = 100
        static let averagePrice: CGFloat = 90
        static let value: CGFloat = 90
        static let realized: CGFloat = 85
        static let unrealized: CGFloat = 130

        static let averagePriceID = "average-price"
        static let realizedID = "realized"

        /// A column that was hidden comes back wider than it left, more so each time, unless something stops it.
        static let comebackRoom: CGFloat = 30

        /// What the table adds around its columns.
        static let chrome: CGFloat = 100
    }

    /// Below the width each needs, the average price paid gives way, then realized. Both stay in the details' menu.
    private var showsAverage: Bool { width >= Column.assetRoom + Column.amount + Column.averagePrice + Column.value + Column.realized + Column.unrealized + Column.chrome + Column.comebackRoom }
    private var showsRealized: Bool { width >= Column.assetRoom + Column.amount + Column.value + Column.realized + Column.unrealized + Column.chrome + Column.comebackRoom }

    /// Hiding a column doesn't give its width to the others, so while any is hidden, each stops at what it needs, and what's left always fits.
    /// Only a change of limits reaches the rows: setting a column's width outright moves its header and leaves its cells behind.
    private func limit(_ width: CGFloat) -> CGFloat? {
        showsAverage ? nil : width
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
            .width(min: Column.asset, ideal: Column.assetRoom, max: limit(Column.assetRoom))
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
            .width(min: Column.realized, ideal: Column.realized, max: showsAverage ? nil : Column.realized + Column.comebackRoom)
            .alignment(.numeric)
            .customizationID(Column.realizedID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Unrealized") { position in
                if position.isHeld {
                    let unrealized = position.values.unrealizedMicros
                    HStack(spacing: 6) {
                        if position.resolvable {
                            Button("Fill In") { onResolve(position.asset) }
                                .buttonStyle(.bordered)
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
        .scrollDisabled(true)
        // Not `if` around the column: a column that comes back that way lands at the end, under another column's header.
        .onChange(of: showsAverage, initial: true) {
            columns[visibility: Column.averagePriceID] = showsAverage ? .visible : .hidden
        }
        .onChange(of: showsRealized, initial: true) {
            columns[visibility: Column.realizedID] = showsRealized ? .visible : .hidden
        }
        .onChange(of: selection) { _, asset in
            // Moving to a row shows its legs. A number clicked in that row has already said what to show.
            guard let asset, targetAsset != asset else { return }
            target = .asset(asset, .amount)
        }
        // The row follows the details, wherever they were opened from. Closing them ends the selection, so the same row can open them again.
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
                // A long amount gets smaller rather than losing digits.
                .minimumScaleFactor(0.7)
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
            .width(min: 120)
            TableColumn("Total PnL") { point in
                LiveNumber(point.pnlMicros.map { Format.signedMoney($0, currency) } ?? "Unavailable", tone: point.pnlMicros == nil ? .secondary : isLive ? Tone(signed: point.pnlMicros) : .neutral)
                    .help(Wording.pnlHelp)
            }
            .width(min: 90)
            .alignment(.numeric)
            TableColumn("Left out") { point in
                if point.excludedCount > 0 {
                    LiveNumber("\(point.excludedCount) unknown", tone: .secondary)
                } else {
                    Text("—").foregroundStyle(.tertiary)
                }
            }
            .width(min: 70)
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

/// For a section that needs a wallet, before there is one.
private struct NoWalletYet: View {
    let navigation: Navigation

    var body: some View {
        ContentUnavailableView {
            Label("No Wallet Yet", systemImage: "wallet.bifold")
        } description: {
            Text("Add one to see this.")
        } actions: {
            Button("Add Wallet") { navigation.switchWallet() }
                .buttonStyle(.borderedProminent)
        }
    }
}

/// A wallet with nothing to show. It says how far back it looked, because nothing moving lately doesn't mean it's empty.
private struct NoActivity<Notices: View>: View {
    let portfolio: Portfolio
    let navigation: Navigation
    let notices: Notices

    var body: some View {
        VStack(spacing: 8) {
            notices.padding(.horizontal, 20).padding(.top, 12)
            ContentUnavailableView {
                Label("Nothing Here Yet", systemImage: "tray")
            } description: {
                Text("Nothing has moved for this wallet in \(Format.duration(ms: BlockTime.msBetween(portfolio.coverage.fromBlock, portfolio.coverage.toBlock))).")
                    .help(Wording.coverage(portfolio))
            } actions: {
                Button("Switch Wallet") { navigation.switchWallet() }
            }
            // Fills what's left, so a notice stays at the top instead of floating over it.
            .frame(maxHeight: .infinity)
        }
    }
}

private struct Welcome: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @State private var problem: String?

    var body: some View {
        ContentUnavailableView {
            Label("See What a Wallet Is Worth", systemImage: "wallet.bifold")
        } description: {
            Text("See the holdings, cost and PnL of any Base wallet.")
                .help("A wallet you watch is only read, and nothing signs for it.")
        } actions: {
            VStack(spacing: 16) {
                spendingMoney
                VStack(alignment: .leading, spacing: 6) {
                    WalletAddressField(prompt: "Paste an address to watch it", problem: $problem) { store.setWallet($0) }
                        .textFieldStyle(.roundedBorder)
                    if let problem {
                        WarningText(problem).font(.callout)
                    }
                }
                if WalletList.offersDemo {
                    Button("Try the Demo Wallet") { store.setWallet(WalletAddress.demo) }
                        .buttonStyle(.link)
                }
            }
            .frame(width: 340)
        }
    }

    /// Nothing to offer on a build that can't hold a key. The rest of this screen still works there.
    @ViewBuilder
    private var spendingMoney: some View {
        if hotWallet.availability == .ready {
            if let address = hotWallet.address {
                Button("Show \(HotWalletWording.title)") { store.setWallet(address.lowercased) }
                    .buttonStyle(.borderedProminent)
            } else {
                // That section says what this is and what can go wrong, and only it makes the key.
                Button("Create \(HotWalletWording.title)…") { navigation.section = .spendingMoney }
                    .buttonStyle(.borderedProminent)
                    .help(HotWalletWording.summary)
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
            Label("Can't Show This Wallet", systemImage: "exclamationmark.triangle")
        } description: {
            Text(store.feed.staleNotice(serverURL: store.serverURL, portfolio: nil) ?? "")
        } actions: {
            Button("Try Again") { store.start() }
                .buttonStyle(.borderedProminent)
        }
    }
}
