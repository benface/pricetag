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
    let purchases: PurchaseTracker
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
                .environment(\.updatingNote, store.updatingNote)
                .frame(minWidth: 320, minHeight: 320)
                .navigationTitle(navigation.section.title)
                // The wallet comes first when there's only room for one of them.
                .toolbar(removing: width < Self.titleWidth ? .title : nil)
                .toolbar { toolbar }
                .inspector(isPresented: inspectorBinding) { inspector }
        }
        .frame(minWidth: Self.minimumSize.width, minHeight: Self.minimumSize.height)
        // Only for the details opening and closing. It doesn't reach anything else that changes at another moment.
        .motion(Motion.panel, value: navigation.target == nil)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { newWidth in
            let wasWide = width >= Self.sidebarWidth
            let isWide = newWidth >= Self.sidebarWidth
            width = newWidth
            if wasWide != isWide { columns = isWide ? .all : .detailOnly }
        }
        .sheet(isPresented: detailsSheetBinding) { detailsSheet }
        // Coming back from the provider's page is when there's news, whichever section this is on.
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
            Task { await purchases.check() }
        }
        .sheet(isPresented: $navigation.isBuying) {
            BuySheet(wallet: hotWallet, purchases: purchases) { navigation.showSpendingMoney() } addSavings: { navigation.addSavings() }
        }
        .sheet(isPresented: $navigation.isReceiving) {
            ReceiveSheet(wallet: hotWallet) { navigation.showSpendingMoney() }
        }
        .sheet(isPresented: $navigation.isResolving) {
            ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, noteWriter: hotWallet) { AnyView(PublishFromDeviceButton(link: $0, browsers: .real)) }
        }
        .sheet(isPresented: $navigation.isSettingUpSpendingMoney) {
            SpendingMoneySetup(wallet: hotWallet, store: store) { navigation.isSettingUpSpendingMoney = false }
                .frame(width: 480, height: 400)
        }
        .confirmationDialog(navigation.removingFromSavings.map { "Remove \($0.title) from savings?" } ?? "", isPresented: Binding(get: { navigation.removingFromSavings != nil }, set: { if !$0 { navigation.removingFromSavings = nil } }), presenting: navigation.removingFromSavings) { entry in
            Button("Remove from Savings", role: .destructive) { store.removeFromSavings(entry, hotWallet: hotWallet) }
        } message: { entry in
            Text(hotWallet.removingFromSavingsMessage(entry.address))
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
                    exportError = "The price service couldn't make this file."
                }
            }
        }
        // What's open belongs to the wallet it was opened on.
        .onChange(of: store.address) {
            navigation.forgetDetails()
            navigation.isResolving = false
            navigation.openPendingQuestions()
        }
        .onChange(of: store.portfolio?.address) { navigation.openPendingQuestions() }
        .onChange(of: navigation.isResolving) { _, open in
            if !open { navigation.returnFromQuestions() }
        }
        // Or it would open again by itself with the window.
        .onDisappear {
            navigation.isSwitchingWallet = false
            navigation.removingFromSavings = nil
        }
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
                FeedBadge(feed: store.feed, portfolio: portfolio, readingSince: store.readingSince)
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
        ToolbarItem(placement: .navigation) {
            WalletButton(store: store, hotWallet: hotWallet, navigation: navigation, maxWidth: width < Self.sidebarWidth ? 230 : 300)
        }
        // With no title in a small window, nothing else would hold the rest at the far end.
        ToolbarSpacer(.flexible)
        if hotWallet.availability == .ready {
            ToolbarItem(placement: .primaryAction) {
                Button("Buy", systemImage: "plus") { navigation.isBuying = true }
                    // A plus on its own could mean adding anything.
                    .labelStyle(.titleAndIcon)
                    .help("Buy crypto")
            }
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let target = navigation.target {
            ExplanationPane(target: target, store: store)
                .safeAreaBar(edge: .top) { metricPicker(target) }
                .inspectorColumnWidth(min: 300, ideal: 330, max: 520)
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
        case .overview:
            if isShowingSpendingMoney {
                spendingMoneyOverview
            } else {
                walletPage { portfolio in
                    GeometryReader { window in
                        overviewPage(pageWidth: window.size.width) { overview(portfolio, pageHeight: window.size.height) }
                    }
                }
            }
        case .transactions: walletPage(transactions)
        case .taxReport:
            if store.address == nil {
                NoWalletYet(navigation: navigation)
            } else {
                TaxReportView(store: store, wallets: store.walletList(hotWallet: hotWallet).pickable, readAddress: AddressText.readAnywhere, onResolve: { navigation.resolve(in: $0) }, onOpen: { navigation.explain($0) })
            }
        }
    }

    /// A section that shows a wallet, or says why there's nothing to show. The first numbers fade in over the spinner rather than replacing it at once.
    private func walletPage(_ content: @escaping (Portfolio) -> some View) -> some View {
        walletPageContent(content)
            .motion(Motion.state, value: portfolio == nil)
    }

    @ViewBuilder
    private func walletPageContent(_ content: @escaping (Portfolio) -> some View) -> some View {
        if store.feed == .noWallet {
            if navigation.section == .overview {
                Welcome(store: store, hotWallet: hotWallet, navigation: navigation)
            } else {
                NoWalletYet(navigation: navigation)
            }
        } else if let portfolio {
            Group {
                // A failure says what's wrong even before there's anything to show, rather than only that the data hasn't reached this wallet.
                if !portfolio.progress.started, store.feed.isStale {
                    Unavailable(store: store)
                } else if !portfolio.progress.started {
                    ContentUnavailableView("Almost There", systemImage: "hourglass", description: Text(Wording.notStarted))
                } else if portfolio.isEmpty {
                    NoActivity(portfolio: portfolio, entry: store.walletList(hotWallet: hotWallet).entry(for: store.address), hotWallet: hotWallet, navigation: navigation, notices: notices(portfolio))
                } else {
                    content(portfolio)
                }
            }
            // Another wallet starts from the top with nothing selected, and its numbers appear rather than rolling from these.
            .id(store.address)
            .transition(.opacity)
        } else if store.feed == .reading {
            ContentUnavailableView {
                ProgressView().controlSize(.large)
            } description: {
                // Says how long it's been once that's worth saying, without promising when it ends.
                ReadingClock(since: store.readingSince ?? .now) { seconds in
                    Text(seconds < FeedState.longReadSeconds ? Wording.reading : Wording.stillReading(seconds: seconds))
                        .contentTransition(.numericText())
                }
            }
            .transition(.opacity)
        } else {
            Unavailable(store: store)
        }
    }

    private var isShowingSpendingMoney: Bool {
        // With no wallet showing and no key yet, there's nothing here for these to be equal about.
        guard hotWallet.availability == .ready, let address = hotWallet.address else { return false }
        return address.lowercased == store.address
    }

    /// The same numbers as any wallet, with what only this one can do around them. Those work whatever the server's doing, so they stay on the page either way.
    private var spendingMoneyOverview: some View {
        GeometryReader { window in
            overviewPage(pageWidth: window.size.width) {
                HotWalletDetails(wallet: hotWallet, store: store, siteBridge: siteBridge, navigation: navigation, purchases: purchases, showsHoldings: !hasHoldingsInOverview) {
                    walletPage { overview($0, pageHeight: window.size.height) }
                        .frame(minHeight: hasHoldingsInOverview ? nil : 260)
                }
            }
        }
    }

    private var hasHoldingsInOverview: Bool {
        guard let portfolio else { return false }
        return portfolio.progress.started && !portfolio.isEmpty
    }

    private func overviewPage(pageWidth: CGFloat, @ViewBuilder content: () -> some View) -> some View {
        ScrollView {
            content()
                // A line of numbers gets hard to read across a very wide window.
                .frame(maxWidth: 1280, alignment: .leading)
                .padding(pageWidth < 520 ? 14 : 20)
                .frame(maxWidth: .infinity)
        }
        .scrollBounceBehavior(.basedOnSize)
    }

    /// Fills the window: the chart takes the height the rest doesn't use, within reason, and the page scrolls once it needs more than there is.
    private func overview(_ portfolio: Portfolio, pageHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            notices(portfolio)
            PortfolioSummary(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total($0) }
                // Short of height, its amounts would shrink and cut off instead of the page scrolling.
                .fixedSize(horizontal: false, vertical: true)
            PortfolioAttention(portfolio: portfolio, onOpen: { navigation.target = $0 }, onResolve: { navigation.resolve() })
                .arrives()
            PnlHistorySection(portfolio: portfolio, isLive: isLive, range: $navigation.chartRange, metric: $navigation.chartMetric) { navigation.target = .transaction($0) }
                .frame(height: portfolio.canChart(navigation.chartMetric) ? chartHeight(pageHeight, rows: portfolio.listedPositions.count) : nil)
            HoldingsSection(portfolio: portfolio, store: store, isLive: isLive, target: $navigation.target) { navigation.resolve($0) }
            HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: isLive) { navigation.target = .holdComparison }
        }
        // A notice, the attention box or the chart coming or going, without the page below it jumping.
        .motion(Motion.state, value: pageShape(portfolio))
    }

    /// What can add or remove a whole block of the page.
    private func pageShape(_ portfolio: Portfolio) -> [Bool] {
        [portfolio.attention == nil, portfolio.canChart(navigation.chartMetric), store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) == nil, portfolio.linkedFailed.isEmpty, portfolio.linkedReading.isEmpty]
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
        if let problem = store.feed.problem(serverURL: store.serverURL, portfolio: portfolio) {
            Notice(.warning, problem.message, detail: problem.detail, actionTitle: "Try Again", action: store.refresh)
        } else if let notice = store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) {
            Notice(.warning, notice)
                .arrives()
        }
        // Each number that may change has a spinner by it. This says how long it's been, once that's worth saying. After a failure, the
        // retry says so too, while the warning above still says how old these numbers are.
        if store.feed == .reading || store.feed.isStale, let since = store.readingSince {
            ReadingClock(since: since) { seconds in
                if seconds >= FeedState.longReadSeconds {
                    Notice(.info, store.feed == .reading ? Wording.stillUpdating(seconds: seconds, lastUpdate: portfolio.latest.date.map(Format.time) ?? portfolio.latest.timestamp) : Wording.tryingAgain(seconds: seconds))
                }
            }
        }
        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
        if !portfolio.linkedFailed.isEmpty {
            HStack(spacing: 8) {
                Notice(.warning, Wording.linkedFailed(portfolio.linkedFailed.count))
                Button("Try Again") { store.refresh() }
            }
            .arrives()
        }
        if !portfolio.linkedReading.isEmpty {
            Notice(.info, "Reading your other \(portfolio.linkedReading.count == 1 ? "wallet" : "wallets"). Until then, what came from \(portfolio.linkedReading.count == 1 ? "it" : "them") has an unknown cost.")
                .arrives()
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
    /// Costs that were unknown until this last read. They're lit for a moment, and only ever after the server's said so.
    @State private var justKnown: Set<String> = []

    /// The narrowest the table fits in, with only the columns that never give way.
    private static let tableWidth: CGFloat = 640

    private var sort: Binding<HoldingsSort> {
        Binding(get: { store.holdingsSort }, set: { store.holdingsSort = $0 })
    }

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
                HoldingsTable(portfolio: portfolio, isLive: isLive, width: width, justKnown: justKnown, sort: sort, target: $target, onResolve: onResolve)
                    .frame(height: HoldingsTable.height(rows: portfolio.listedPositions.count))
            } else {
                rows
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: portfolio.costWatch) { old, new in
            let arrived = new.arrivals(since: old)
            if !arrived.isEmpty { justKnown.formUnion(arrived) }
        }
        .task(id: justKnown) {
            guard !justKnown.isEmpty else { return }
            try? await Task.sleep(for: Motion.highlight)
            if !Task.isCancelled { justKnown = [] }
        }
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
            ForEach(portfolio.listedPositions.sorted(using: store.holdingsSort)) { position in
                Button { target = .asset(position.asset, .amount) } label: {
                    CompactHolding(position: position, currency: portfolio.currency, isLive: isLive)
                        .padding(.horizontal, 4)
                        .justKnown(justKnown.contains(position.asset))
                }
                .buttonStyle(RowButtonStyle())
                .contextMenu {
                    HoldingActions(position: position, currency: portfolio.currency, onShow: { target = .asset(position.asset, .amount) }, onResolve: { onResolve(position.asset) })
                }
                Divider()
            }
        }
    }
}

/// What a right-click on a holding offers. Each is also in the interface: the row opens its details, and answering is in the row.
private struct HoldingActions: View {
    let position: Position
    let currency: CurrencyCode
    let onShow: () -> Void
    let onResolve: () -> Void

    var body: some View {
        Button("Show Details", action: onShow)
        if position.resolvable {
            Button("Answer Questions…", action: onResolve)
        }
        Divider()
        Button("Copy") { Clipboard.copy(position.copyText(currency: currency)) }
    }
}

/// A holding in a narrow window: what it is, how much at what price, then what it's worth and how it's done. The rest is in its details.
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
                LiveNumber(amountAtPrice, tone: .secondary).font(.caption)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                LiveNumber(position.isHeld ? position.values.valueMicros.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price" : "—", tone: position.values.valueMicros == nil ? .secondary : .neutral)
                    .updatingMark()
                LiveNumber(howItsDone, tone: position.pnlMicros == nil ? .secondary : isLive ? Tone(signed: position.pnlMicros) : .neutral)
                    .font(.caption)
            }
        }
        .lineLimit(1)
        .padding(.vertical, 7)
        .opacity(isLive ? (position.isHeld ? 1 : 0.6) : 0.55)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var amountAtPrice: String {
        let amount = Format.amount(position.values.qty, decimals: position.decimals)
        guard let price = position.price else { return amount }
        return "\(amount) · \(Format.estimate(Format.price(price.micros, currency), position.estimates.value))"
    }

    /// Its PnL, then its return when that's known. An unknown return says nothing the PnL doesn't.
    private var howItsDone: String {
        let pnl = position.pnlMicros.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized || position.estimates.unrealized) } ?? Wording.pnlUnavailable
        guard position.isHeld, let bps = position.returnBps else { return pnl }
        // One "≈" says the line rests on an estimate.
        return "\(pnl) · \(Format.estimate(Format.percent(bps: bps), position.estimates.unrealized && !pnl.hasPrefix("≈")))"
    }
}

/// Up and down move through positions and show each one's legs. Every number opens its own explanation.
private struct HoldingsTable: View {
    let portfolio: Portfolio
    let isLive: Bool
    /// As much as there is, because a hidden column doesn't give its width to the others.
    let width: CGFloat
    let justKnown: Set<String>
    /// Headers sort. A row with no number goes last either way, and isn't treated as zero.
    @Binding var sort: HoldingsSort
    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @State private var selection: Position.ID?
    @State private var columns = TableColumnCustomization<Position>()

    private var rows: [Position] { portfolio.listedPositions.sorted(using: sort) }

    private var sortOrder: Binding<[HoldingsSort]> {
        Binding(get: { [sort] }, set: { if let first = $0.first { sort = first } })
    }

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
        static let price: CGFloat = 90
        static let averagePrice: CGFloat = 90
        static let value: CGFloat = 90
        static let realized: CGFloat = 85
        static let unrealized: CGFloat = 130
        static let returns: CGFloat = 75

        static let priceID = "price"
        static let averagePriceID = "average-price"
        static let realizedID = "realized"

        /// A column that was hidden comes back wider than it left, more so each time, unless something stops it.
        static let comebackRoom: CGFloat = 30

        /// What the table adds between columns, and around them.
        static let spacing: CGFloat = 18
        static let insets: CGFloat = 24
    }

    /// The room these columns need, with what's always there: what it is, how much, what it's worth and how it's done.
    private static func needs(_ more: CGFloat...) -> CGFloat {
        let columns = [Column.assetRoom, Column.amount, Column.value, Column.unrealized, Column.returns] + more
        return columns.reduce(0, +) + CGFloat(columns.count) * Column.spacing + Column.insets + Column.comebackRoom
    }

    /// Below the width each needs, the average price paid gives way, then realized, then the price. All stay in the details' menu.
    private var showsAverage: Bool { width >= Self.needs(Column.price, Column.realized, Column.averagePrice) }
    private var showsRealized: Bool { width >= Self.needs(Column.price, Column.realized) }
    private var showsPrice: Bool { width >= Self.needs(Column.price) }

    /// Hiding a column doesn't give its width to the others, so while any is hidden, each stops at what it needs, and what's left always fits.
    /// Only a change of limits reaches the rows: setting a column's width outright moves its header and leaves its cells behind.
    private func limit(_ width: CGFloat) -> CGFloat? {
        showsAverage ? nil : width
    }

    var body: some View {
        Table(rows, selection: $selection, sortOrder: sortOrder, columnCustomization: $columns) {
            TableColumn("Asset", sortUsing: HoldingsSort(.asset)) { position in
                HStack(spacing: 5) {
                    Text(position.asset).fontWeight(.medium)
                    if let note = position.note {
                        Text(note).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    }
                    // Once per row, however many of its numbers it affects. A balance that matches says nothing.
                    balanceCheck(position)
                }
                .opacity(position.isHeld ? 1 : 0.6)
                .tableCell()
            }
            .width(min: Column.asset, ideal: Column.assetRoom, max: limit(Column.assetRoom))
            .disabledCustomizationBehavior(.all)
            TableColumn("Amount", sortUsing: HoldingsSort(.amount)) { position in
                number(position, .amount, Format.amount(position.values.qty, decimals: position.decimals), tone: .neutral)
            }
            .width(min: Column.amount, ideal: Column.amount, max: limit(Column.amount))
            .disabledCustomizationBehavior(.all)
            .alignment(.numeric)
            TableColumn("Price", sortUsing: HoldingsSort(.price)) { position in
                let price = position.price
                number(position, .price, price.map { Format.estimate(Format.price($0.micros, currency), position.estimates.value) } ?? "No price", tone: price == nil ? .secondary : .neutral)
            }
            .width(min: Column.price, ideal: Column.price, max: Column.price + Column.comebackRoom)
            .alignment(.numeric)
            .customizationID(Column.priceID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Average paid", sortUsing: HoldingsSort(.average)) { position in
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
            TableColumn("Value", sortUsing: HoldingsSort(.value)) { position in
                if position.isHeld {
                    let value = position.values.valueMicros
                    number(position, .value, value.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? "No price", tone: value == nil ? .secondary : .neutral)
                        .updatingMark()
                } else {
                    dash.updatingMark()
                }
            }
            .width(min: Column.value, ideal: Column.value, max: limit(Column.value))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Realized", sortUsing: HoldingsSort(.realized)) { position in
                let realized = position.values.realizedMicros
                number(position, .realized, realized.map { Format.estimate(Format.signedMoney($0, currency), position.estimates.realized) } ?? Wording.unknown, tone: realized == nil ? .secondary : Tone(signed: realized))
            }
            .width(min: Column.realized, ideal: Column.realized, max: showsAverage ? nil : Column.realized + Column.comebackRoom)
            .alignment(.numeric)
            .customizationID(Column.realizedID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Unrealized", sortUsing: HoldingsSort(.unrealized)) { position in
                if position.isHeld {
                    let unrealized = position.values.unrealizedMicros
                    HStack(spacing: 6) {
                        if position.resolvable {
                            // The column has room for the number beside a symbol, not a name. The name's in its tooltip and for VoiceOver.
                            Button(questionsTitle(position.asset), systemImage: "questionmark.bubble") { onResolve(position.asset) }
                                .labelStyle(.iconOnly)
                                .buttonStyle(.bordered)
                                .controlSize(.mini)
                                .accessibilityLabel("\(questionsTitle(position.asset)) about \(position.asset)")
                                .help("\(questionsTitle(position.asset)) about \(position.asset), so what you paid is known")
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
            TableColumn("Return", sortUsing: HoldingsSort(.return)) { position in
                if position.isHeld {
                    number(position, .return, returnText(position), tone: position.returnBps == nil ? .secondary : Tone(signed: position.returnBps))
                } else {
                    dash
                }
            }
            .width(min: Column.returns, ideal: Column.returns, max: limit(Column.returns))
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .scrollDisabled(true)
        .contextMenu(forSelectionType: Position.ID.self) { assets in
            if let position = assets.first.flatMap(position) {
                HoldingActions(position: position, currency: currency, onShow: { target = .asset(position.asset, .amount) }, onResolve: { onResolve(position.asset) })
            }
        }
        .onCopyCommand {
            guard let position = selection.flatMap(position) else { return [] }
            return [NSItemProvider(object: position.copyText(currency: currency) as NSString)]
        }
        // Not `if` around the column: a column that comes back that way lands at the end, under another column's header.
        .onChange(of: showsAverage, initial: true) {
            columns[visibility: Column.averagePriceID] = showsAverage ? .visible : .hidden
        }
        .onChange(of: showsRealized, initial: true) {
            columns[visibility: Column.realizedID] = showsRealized ? .visible : .hidden
        }
        .onChange(of: showsPrice, initial: true) {
            columns[visibility: Column.priceID] = showsPrice ? .visible : .hidden
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

    /// Counts this holding's own questions, which are the ones that come first.
    private func questionsTitle(_ asset: String) -> String {
        Wording.answerQuestions(max(1, portfolio.questions.count { $0.arrivals.contains { $0.asset == asset } }))
    }

    private func position(_ asset: String) -> Position? {
        portfolio.listedPositions.first { $0.asset == asset }
    }

    private var dash: some View {
        Text("—").foregroundStyle(.tertiary).tableCell()
    }

    /// Unknown whenever its cost is, and never 0%. With a known cost of nothing, there's no share of it to show.
    private func returnText(_ position: Position) -> String {
        if let bps = position.returnBps { return Format.estimate(Format.percent(bps: bps), position.estimates.unrealized) }
        if position.values.costMicros == nil { return Wording.unknown }
        return position.values.valueMicros == nil ? "No price" : "—"
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
                .justKnown(justKnown.contains(position.asset) && (metric == .average || metric == .unrealized || metric == .return))
        }
        .buttonStyle(NumberButtonStyle())
        .help(metric.help ?? "")
        .accessibilityLabel("\(position.asset) \(metric.label), \(text)")
        .tableCell()
    }
}

extension View {
    /// Lines a cell up with its column's title, which the header draws a couple of points in from each side.
    fileprivate func tableCell() -> some View {
        padding(.horizontal, 2)
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

    private func hash(_ id: PnlPoint.ID) -> String? {
        transactions.first { $0.id == id }?.txHash
    }

    var body: some View {
        Table(transactions, selection: $selection) {
            TableColumn("Time") { point in
                Text(point.date.map(Format.time) ?? point.timestamp)
                    .tableCell()
            }
            // Only what they need, so the words get the rest, and a small window still has room for the last column.
            .width(min: 120, ideal: 120, max: 130)
            TableColumn("What happened") { point in
                if let summary = point.summary {
                    Text(summary)
                        .lineLimit(1)
                        .help(summary)
                        .tableCell()
                } else {
                    Text("—").foregroundStyle(.tertiary).tableCell()
                }
            }
            .width(min: 100)
            TableColumn("Total PnL") { point in
                LiveNumber(point.pnlMicros.map { Format.signedMoney($0, currency) } ?? "Unavailable", tone: point.pnlMicros == nil ? .secondary : isLive ? Tone(signed: point.pnlMicros) : .neutral)
                    .opacity(isLive ? 1 : 0.55)
                    .help(Wording.pnlHelp)
                    .updatingMark()
                    .tableCell()
            }
            .width(min: 90, ideal: 90, max: 110)
            .alignment(.numeric)
            TableColumn("Left out") { point in
                if point.excludedCount > 0 {
                    LiveNumber("\(point.excludedCount) unknown", tone: .secondary).tableCell()
                } else {
                    Text("—").foregroundStyle(.tertiary).tableCell()
                }
            }
            .width(min: 70, ideal: 70, max: 90)
            .alignment(.numeric)
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .contextMenu(forSelectionType: PnlPoint.ID.self) { ids in
            if let hash = ids.first.flatMap(hash) {
                TransactionActions(hash: hash) { target = .transaction(hash) }
            }
        }
        .onCopyCommand {
            guard let hash = selection.flatMap(hash) else { return [] }
            return [NSItemProvider(object: hash as NSString)]
        }
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

/// A wallet with nothing to show. One of yours offers ways to fund it. A watched one says how far back it looked, because nothing
/// moving lately doesn't mean it's empty.
private struct NoActivity<Notices: View>: View {
    let portfolio: Portfolio
    let entry: WalletEntry?
    let hotWallet: HotWallet
    let navigation: Navigation
    let notices: Notices

    /// This Mac's wallet, while it can still take money.
    private var isSpendingMoney: Bool { entry?.kind == .spendingMoney && hotWallet.canSend }
    /// Buying lands in Spending Money, whichever wallet of yours this is.
    private var canBuy: Bool { entry?.kind.isOwn == true && hotWallet.canSend }
    /// A wallet of yours whose key is somewhere else. A replaced spending key's is nowhere, so nothing should go to it, and the one
    /// Spending Money is moving to is this Mac's.
    private var isHeldElsewhere: Bool {
        guard let entry, entry.kind == .savings || entry.kind == .yours else { return false }
        return !entry.isReplacedKey && !entry.isNewKey
    }

    var body: some View {
        VStack(spacing: 8) {
            notices.padding(.horizontal, 20).padding(.top, 12)
            ContentUnavailableView {
                Label("Nothing Here Yet", systemImage: "tray")
            } description: {
                description
            } actions: {
                if isSpendingMoney {
                    Button("Receive…") { navigation.isReceiving = true }
                        .buttonStyle(.borderedProminent)
                }
                if canBuy {
                    Button("Buy…") { navigation.isBuying = true }
                }
                if !isSpendingMoney, !canBuy {
                    Button("Switch Wallet") { navigation.switchWallet() }
                }
            }
            // Fills what's left, so a notice stays at the top instead of floating over it.
            .frame(maxHeight: .infinity)
        }
    }

    @ViewBuilder
    private var description: some View {
        if isSpendingMoney {
            Text("Receive from another wallet or an exchange, or buy some with a card.")
        } else if isHeldElsewhere {
            // Never shown here: what holds the key is the only place to trust it, since a tampered page could show another.
            Text("To receive here, copy the address from the device or app that holds its key, and check it there.")
        } else {
            Text("Nothing has moved for this wallet in \(Format.duration(ms: BlockTime.msBetween(portfolio.coverage.fromBlock, portfolio.coverage.toBlock))).")
                .help(Wording.coverage(portfolio))
        }
    }
}

private struct Welcome: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @State private var input = ""

    var body: some View {
        ContentUnavailableView {
            Label("See What a Wallet Is Worth", systemImage: "wallet.bifold")
        } description: {
            Text("See the holdings, cost and PnL of any Base wallet.")
                .help("A wallet you watch is only read, and nothing signs for it.")
        } actions: {
            VStack(spacing: 16) {
                spendingMoney
                AddressField(prompt: "Paste an address to watch it", text: $input, wallets: store.walletList(hotWallet: hotWallet).pickable, read: AddressText.readAnywhere, onAddress: { store.setWallet($0) })
                    .textFieldStyle(.roundedBorder)
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
                // That sheet says what this is and what can go wrong, and only it makes the key.
                Button("Create \(HotWalletWording.title)…") { navigation.showSpendingMoney() }
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
        let problem = store.feed.problem(serverURL: store.serverURL, portfolio: nil)
        ContentUnavailableView {
            Label(problem?.title ?? "Can't Show This Wallet", systemImage: "exclamationmark.triangle")
        } description: {
            Text(problem?.message ?? "")
            if let since = store.readingSince {
                ReadingClock(since: since) { seconds in
                    if seconds >= FeedState.longReadSeconds {
                        Label(Wording.tryingAgain(seconds: seconds), systemImage: "arrow.clockwise")
                            .contentTransition(.numericText())
                    }
                }
            }
        } actions: {
            Button("Try Again") { store.refresh() }
                .buttonStyle(.borderedProminent)
            if let detail = problem?.detail {
                DetailsButton(detail: detail)
            }
        }
    }
}
