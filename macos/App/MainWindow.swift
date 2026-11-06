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
    /// What someone new is still to see. Nothing, for anything that doesn't say otherwise.
    var firstRun: FirstRun = .finished
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var width: CGFloat = 1120
    @State private var exporting = false
    @State private var exportDocument: CSVDocument?
    @State private var exportError: String?
    /// Asked for from the details sheet, which closes first.
    @State private var resolvingAfterDetails: String?

    /// How small the window can get, with the sidebar closed. It closes by itself below `sidebarWidth`.
    static let minimumSize = CGSize(width: 480, height: 400)
    private static let sidebarWidth: CGFloat = 640
    private static let titleWidth: CGFloat = 560
    /// Below this the details open over the window, because there's no room beside the section.
    private static let inspectorWidth: CGFloat = 900

    private var portfolio: Portfolio? { store.portfolio }
    private var isLive: Bool { store.feed.isLive }
    private var usesSheetForDetails: Bool { width < Self.inspectorWidth }
    /// On the way to a first wallet, the sections and the wallet menu have nothing to offer yet. A wallet that's turned out to be empty is
    /// on the page with its way onward, so they come back for it.
    private var isOnWayToWallet: Bool { firstRun.isWelcoming && portfolio == nil }
    private var hasNumbers: Bool { portfolio.map { $0.progress.started && !$0.isEmpty } ?? false }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            sidebar
        } detail: {
            pageWithDeviceNotice
                .environment(\.updatingNote, store.updatingNote)
                .environment(\.staleNote, store.staleNote)
                .frame(minWidth: 320, minHeight: 320)
                // With the sidebar closed, the status has nowhere else to be, and it only has to be seen when there's something to say. Over the page, so nothing moves, and a toolbar short of room can't fold it away.
                .overlay(alignment: .bottomLeading) {
                    if columns == .detailOnly, !isOnWayToWallet, store.feed != .noWallet, store.hasStatusDetails {
                        FeedStatus(store: store)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                            .padding(12)
                            .transition(.opacity)
                    }
                }
                .animation(Motion.state, value: store.hasStatusDetails)
                .navigationTitle(navigation.section.title)
                // The wallet comes first when there's only room for one of them.
                .toolbar(removing: width < Self.titleWidth || isOnWayToWallet ? .title : nil)
                .toolbar { toolbar }
                .inspector(isPresented: inspectorBinding) { inspector }
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    if Build.isWatchOnly { WatchOnlyNotice() }
                }
        }
        .frame(minWidth: Self.minimumSize.width, minHeight: Self.minimumSize.height)
        // What each wallet is called, wherever All Yours says which wallet something is in.
        .environment(\.walletNames, store.walletList(hotWallet: hotWallet).names)
        // Only for the details opening and closing. It doesn't reach anything else that changes at another moment.
        .motion(Motion.panel, value: navigation.target == nil)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { newWidth in
            let wasWide = width >= Self.sidebarWidth
            let isWide = newWidth >= Self.sidebarWidth
            width = newWidth
            if wasWide != isWide, !isOnWayToWallet { columns = isWide ? .all : .detailOnly }
        }
        .onAppear { if isOnWayToWallet { columns = .detailOnly } }
        .onChange(of: isOnWayToWallet) { _, isOnWay in
            columns = !isOnWay && width >= Self.sidebarWidth ? .all : .detailOnly
        }
        // A first wallet's numbers are the end of the welcome, and so is going anywhere else in the app. Overview is where it lives, so going there isn't leaving it.
        .onChange(of: hasNumbers, initial: true) { _, hasNumbers in
            if hasNumbers { firstRun.finishWelcome() }
        }
        .onChange(of: isShowingSpendingMoney, initial: true) { _, isShowing in
            if isShowing { firstRun.finishWelcome() }
        }
        .onChange(of: navigation.section) { _, section in
            if section != .overview { firstRun.finishWelcome() }
        }
        .onChange(of: navigation.isSwitchingWallet) { _, isSwitching in
            if isSwitching { firstRun.finishWelcome() }
        }
        // Whatever's on the page, so it's known however fast or slow the numbers are. Help can ask again for the wallet that's showing.
        .onChange(of: store.address, initial: true) { checkContract() }
        .onChange(of: firstRun.explainsContract) { checkContract() }
        // The note's said what it had to once they've found the numbers click through.
        .onChange(of: navigation.target != nil) { _, isOpen in
            if isOpen { firstRun.finishNumbers() }
        }
        .sheet(isPresented: detailsSheetBinding, onDismiss: {
            if let asset = resolvingAfterDetails {
                resolvingAfterDetails = nil
                navigation.resolve(asset)
            }
        }) { detailsSheet }
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
            // Publishing what you paid signs a transaction, here or on a device, so a watch-only build only keeps it on this Mac.
            if Build.isWatchOnly {
                ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, firstRun: firstRun)
            } else {
                ResolveFlow(store: store, firstAsset: navigation.resolvingAsset, noteWriter: hotWallet, firstRun: firstRun) { AnyView(PublishFromDeviceButton(link: $0, browsers: .real)) }
            }
        }
        // On the way to a first wallet, the welcome asks for it itself.
        .sheet(isPresented: Binding(get: { Build.isForOtherPeople && store.asksForInvite && !isOnWayToWallet }, set: { if !$0 { store.declineInvite() } })) {
            // The store closes this when an invite's given, and opens it again if the server refuses that one.
            InvitePrompt(store: store, decline: store.declineInvite)
        }
        .sheet(isPresented: $navigation.isShowingWelcomeAgain) {
            WelcomeAgain()
        }
        // Whatever was going to follow making one is off, if it wasn't made.
        .onChange(of: navigation.isSettingUpSpendingMoney) { _, isOpen in
            if !isOpen, hotWallet.address == nil { navigation.wantsAddSavings = false }
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
        // The menu asks for it, which opens the window if it's closed. The file's written only once the server has answered.
        .onChange(of: navigation.isExporting, initial: true) { _, asked in
            guard asked else { return }
            navigation.isExporting = false
            Task {
                do {
                    exportDocument = CSVDocument(text: try await store.exportCSV())
                    exporting = true
                } catch FetchError.notCaughtUp(let message) {
                    exportError = message
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
            ForEach(AppSection.shown) { section in
                Label(section.title, systemImage: section.symbol).tag(section)
            }
        }
        // Before the width, which it would otherwise hide from the split view.
        .toolbar(removing: isOnWayToWallet ? .sidebarToggle : nil)
        .navigationSplitViewColumnWidth(min: 150, ideal: 190, max: 260)
        // A status, so it looks like one: it's text, and it's down here. It only clicks when there's more to say about what's wrong.
        .safeAreaInset(edge: .bottom) {
            if store.feed != .noWallet {
                FeedStatus(store: store)
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
        if !isOnWayToWallet {
            ToolbarItem(placement: .navigation) {
                WalletButton(store: store, hotWallet: hotWallet, navigation: navigation, maxWidth: width < Self.sidebarWidth ? 230 : 300)
            }
        }
        // With no title in a small window, nothing else would hold the rest at the far end.
        ToolbarSpacer(.flexible)
        if firstRun.isWelcoming, store.feed == .noWallet {
            ToolbarItem(placement: .primaryAction) {
                Button("Skip") {
                    // There's still the invite to give, but this has said to leave it for now.
                    store.declineInvite()
                    firstRun.skip()
                }
                .keyboardShortcut(.cancelAction)
                .help("Skip this introduction. You can see it again from the Help menu.")
            }
        } else if hotWallet.availability == .ready, !isOnWayToWallet {
            ToolbarItem(placement: .primaryAction) {
                Button("Buy", systemImage: "plus") { navigation.isBuying = true }
                    // A plus on its own could mean adding anything.
                    .labelStyle(.titleAndIcon)
                    // With every wallet showing, it says which one it's for.
                    .help(WalletAddress.isAllYours(store.address) ? "Buy crypto for \(HotWalletWording.title)" : "Buy crypto")
            }
        }
    }

    @ViewBuilder
    private var inspector: some View {
        if let target = navigation.target {
            ExplanationPane(target: target, store: store) { navigation.resolve($0) }
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
                // Questions open in a sheet of their own, so they wait for this one to close.
                ExplanationPane(target: target, store: store) { asset in
                    resolvingAfterDetails = asset
                    navigation.target = nil
                }
            }
            .frame(minWidth: 320, idealWidth: 420, minHeight: 320, idealHeight: 520)
        }
    }

    /// Every number in the asset's row, including those the holdings table has no room for when it's narrow.
    @ViewBuilder
    private func metricPicker(_ target: ExplainTarget) -> some View {
        if case .asset(let asset, let metric) = target, let position = portfolio?.positions.first(where: { $0.asset == asset }) {
            // The pane has no title of its own for these, so this names both the asset and the number.
            HStack(spacing: 8) {
                Text(asset).font(.headline)
                Picker("Show", selection: Binding(get: { metric }, set: { navigation.target = .asset(asset, $0) })) {
                    ForEach(position.explainableMetrics, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.menu)
                .labelsHidden()
                .fixedSize()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.vertical, 6)
        }
    }

    /// About this Mac rather than the wallet showing, so it's above every section, with or without numbers to show.
    private var pageWithDeviceNotice: some View {
        VStack(spacing: 0) {
            if store.hasUnreadableSaved {
                Notice(.warning, Wording.unreadableSaved, actionTitle: "OK", action: store.dismissUnreadableSaved)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                Divider()
            }
            // Some pages are only as tall as what they say, which would leave the notice halfway down.
            page.frame(maxWidth: .infinity, maxHeight: .infinity)
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
        case .security:
            SecurityPage(store: store, hotWallet: hotWallet, navigation: navigation)
        }
    }

    /// A section that shows a wallet, or says why there's nothing to show. The first numbers fade in over the spinner rather than replacing it at once.
    private func walletPage(isInsidePage: Bool = false, _ content: @escaping (Portfolio) -> some View) -> some View {
        walletPageContent(isInsidePage: isInsidePage, content)
            .motion(Motion.state, value: portfolio == nil)
    }

    @ViewBuilder
    private func walletPageContent(isInsidePage: Bool, _ content: @escaping (Portfolio) -> some View) -> some View {
        if store.feed == .noWallet {
            if firstRun.isWelcoming {
                FirstRunWelcome(store: store, hotWallet: hotWallet, navigation: navigation)
            } else if navigation.section == .overview {
                Welcome(store: store, hotWallet: hotWallet, navigation: navigation)
            } else {
                NoWalletYet(navigation: navigation)
            }
        } else if let portfolio {
            Group {
                // A failure says what's wrong even before there's anything to show, rather than only that the data hasn't reached this wallet.
                if !portfolio.progress.started, store.feed.isStale {
                    Unavailable(store: store, firstRun: firstRun)
                } else if !portfolio.progress.started {
                    ContentUnavailableView("Almost There", systemImage: "hourglass", description: Text(Wording.notStarted))
                } else if portfolio.isEmpty {
                    NoActivity(portfolio: portfolio, entry: store.walletList(hotWallet: hotWallet).entry(for: store.address), hotWallet: hotWallet, navigation: navigation, notices: notices(portfolio), firstRun: firstRun, store: store)
                } else {
                    content(portfolio)
                }
            }
            // Another wallet starts from the top with nothing selected, and its numbers appear rather than rolling from these.
            .id(store.address)
            .transition(.opacity)
        } else if hasReadSteps, store.feed == .reading || store.feed == .tooSlow {
            FirstRead(store: store, firstRun: firstRun, isInsidePage: isInsidePage)
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
            Unavailable(store: store, firstRun: firstRun)
        }
    }

    /// The server only reports on an address, which neither All Yours nor the demo wallet is. On the way to a first wallet, the demo wallet still has this page's way back.
    private var hasReadSteps: Bool {
        firstRun.isWelcoming || store.address.map(WalletAddress.isValid) == true
    }

    private func checkContract() {
        firstRun.checkContract(of: store.address) { [store] in store.currentSource }
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
                    walletPage(isInsidePage: true) { overview($0, pageHeight: window.size.height) }
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
    @ViewBuilder
    private func overview(_ portfolio: Portfolio, pageHeight: CGFloat) -> some View {
        if portfolio.holdsOnlyOtherTokens {
            VStack(alignment: .leading, spacing: 18) {
                notices(portfolio)
                OtherTokensSection(portfolio: portfolio)
            }
        } else {
            pricedOverview(portfolio, pageHeight: pageHeight)
        }
    }

    private func pricedOverview(_ portfolio: Portfolio, pageHeight: CGFloat) -> some View {
        VStack(alignment: .leading, spacing: 18) {
            if firstRun.explainsNumbers {
                Notice(.info, Wording.firstNumbers(portfolio), actionTitle: "Got It", action: firstRun.finishNumbers)
                    .arrives()
            }
            notices(portfolio)
            PortfolioSummary(portfolio: portfolio, isLive: isLive, size: 40) { navigation.target = .total($0) }
                // Short of height, its amounts would shrink and cut off instead of the page scrolling.
                .fixedSize(horizontal: false, vertical: true)
            // Its one line of room stays when there's nothing to say, so it can come and go without moving the chart.
            PortfolioAttention(portfolio: portfolio, onOpen: { navigation.target = $0 }, onResolve: { navigation.resolve() })
                .arrives()
                .frame(minHeight: Self.attentionHeight, alignment: .top)
            PnlHistorySection(portfolio: portfolio, isLive: isLive, range: $navigation.chartRange, metric: $navigation.chartMetric) { navigation.target = .transaction($0) }
                .frame(height: portfolio.canChart(navigation.chartMetric) ? chartHeight(pageHeight, rows: portfolio.listedPositions.count) : nil)
            HoldingsSection(portfolio: portfolio, store: store, isLive: isLive, navigation: navigation)
            HoldComparisonCard(comparison: portfolio.holdComparison, currency: portfolio.currency, isLive: isLive) { navigation.target = .holdComparison }
            // Last, because they're read after everything else, and can arrive without moving anything above them.
            if portfolio.hasOtherTokens { OtherTokensSection(portfolio: portfolio) }
        }
        // What's left that can change a block's height, which glides rather than jumps. The connection isn't one: it's in the status.
        .motion(Motion.state, value: pageShape(portfolio))
    }

    /// What can add or remove a whole block of the page.
    private func pageShape(_ portfolio: Portfolio) -> [Int] {
        [firstRun.explainsNumbers ? 1 : 0, firstRun.warnsOfContract(store.address) ? 1 : 0, portfolio.attention == nil ? 1 : 0, portfolio.canChart(navigation.chartMetric) ? 1 : 0, portfolio.listedPositions.count]
    }

    private static let attentionHeight: CGFloat = 38

    private func chartHeight(_ pageHeight: CGFloat, rows: Int) -> CGFloat {
        let rest = 430 + Self.attentionHeight + CGFloat(rows) * HoldingsTable.rowHeight
        return min(max(pageHeight - rest, 200), 460)
    }

    private func transactions(_ portfolio: Portfolio) -> some View {
        TransactionsPage(portfolio: portfolio, store: store, hotWallet: hotWallet, isLive: isLive, navigation: navigation, notices: notices(portfolio))
    }

    @ViewBuilder
    private func notices(_ portfolio: Portfolio) -> some View {
        if firstRun.warnsOfContract(store.address) {
            Notice(.warning, Wording.contractNotice, actionTitle: "Got It", action: firstRun.finishContract)
                .arrives()
        }
        // What's wrong with the connection, and wallets that aren't in yet, are in the status, so they can't move the page.
        if portfolio.mode == .demo {
            Notice(.info, Wording.demo)
        }
    }
}

/// Rarely changed, so it sits quietly by the numbers it affects. It says what's in use, because the numbers depend on it. Settings is the other place to change it.
struct CostMethodMenu: View {
    let store: PortfolioStore

    var body: some View {
        Menu {
            Picker(Wording.methodName, selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.inline)
        } label: {
            Text("\(Wording.methodName): \(store.method.label)")
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)
        .fixedSize()
        .secondaryText()
        .help(Wording.methodHelp)
    }
}

/// What a wallet holds: a table when there's room for its columns, and two-line rows when there isn't. ⌘F searches them.
private struct HoldingsSection: View {
    let portfolio: Portfolio
    let store: PortfolioStore
    let isLive: Bool
    @Bindable var navigation: Navigation
    @Environment(\.walletNames) private var walletNames
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var isSearching: Bool
    @State private var width: CGFloat = 800
    @State private var showsAbout = false
    /// Costs that were unknown until this last read. They're lit for a moment, and only ever after the server's said so.
    @State private var justKnown: Set<String> = []

    /// The narrowest the table fits in, with only the columns that never give way.
    private static let tableWidth: CGFloat = 640

    private static let scrollID = "holdings"

    private var sort: Binding<HoldingsSort> {
        Binding(get: { store.holdingsSort }, set: { store.holdingsSort = $0 })
    }

    private var shown: [Position] {
        portfolio.listedPositions.filter { $0.matches(navigation.holdingsQuery, names: walletNames) }
    }

    var body: some View {
        // Inside the page's scroll view, which is the one it scrolls.
        ScrollViewReader { proxy in
            section
                .id(Self.scrollID)
                // They can be below the chart, out of sight of what's being typed.
                .onChange(of: navigation.holdingsQuery.isEmpty, initial: true) { _, isEmpty in
                    if !isEmpty { reveal(with: proxy) }
                }
                .onChange(of: navigation.wantsSearch, initial: true) { _, wants in
                    guard wants else { return }
                    navigation.wantsSearch = false
                    isSearching = true
                    reveal(with: proxy)
                }
        }
        .searchable(text: $navigation.holdingsQuery, placement: .toolbar, prompt: portfolio.isAllYours ? "Token or wallet" : "Token")
        .searchFocused($isSearching)
        .onDisappear { navigation.holdingsQuery = "" }
    }

    private func reveal(with proxy: ScrollViewProxy) {
        withAnimation(reduceMotion ? nil : .default) { proxy.scrollTo(Self.scrollID, anchor: .top) }
    }

    private var section: some View {
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
                        .secondaryText()
                        .lineLimit(1)
                }
                CostMethodMenu(store: store)
                Button("About This Data", systemImage: "info.circle") { showsAbout.toggle() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .help("What this covers")
                    .popover(isPresented: $showsAbout, arrowEdge: .bottom) { about }
            }
            if shown.isEmpty, !navigation.holdingsQuery.isEmpty {
                ContentUnavailableView.search(text: navigation.holdingsQuery)
                    .frame(maxWidth: .infinity, minHeight: 180)
            } else if width >= Self.tableWidth {
                HoldingsTable(portfolio: portfolio, positions: shown, isLive: isLive, width: width, justKnown: justKnown, sort: sort, target: $navigation.target) { navigation.resolve($0) }
                    .frame(height: HoldingsTable.height(rows: shown.count))
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
            ForEach(shown.sorted(using: store.holdingsSort)) { position in
                Button { navigation.target = .asset(position.asset, .amount) } label: {
                    CompactHolding(position: position, currency: portfolio.currency, isLive: isLive)
                        .padding(.horizontal, 4)
                        .justKnown(justKnown.contains(position.asset))
                }
                .buttonStyle(RowButtonStyle())
                .contextMenu {
                    HoldingActions(position: position, currency: portfolio.currency, onShow: { navigation.target = .asset(position.asset, .amount) }, onResolve: { navigation.resolve(position.asset) })
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
                LiveNumber(position.isHeld ? position.values.valueMicros.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? Wording.noPrice : "—", tone: position.values.valueMicros == nil ? .secondary : .neutral)
                    .updatingMark()
                LiveNumber(howItsDone, tone: position.pnlMicros == nil ? .secondary : isLive ? Tone(signed: position.pnlMicros) : .neutral)
                    .font(.caption)
            }
        }
        .lineLimit(1)
        .padding(.vertical, 7)
        .stale(!isLive || !position.isHeld)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(HoldingRow.spokenLabel(
            position,
            currency,
            isLive: isLive,
            amount: Format.amount(position.values.qty, decimals: position.decimals),
            price: position.price.map { Format.estimate(Format.price($0.micros, currency), position.estimates.value) },
            returnText: position.isHeld ? position.returnBps.map { Format.estimate(Format.percent(bps: $0), position.estimates.unrealized) } : nil
        ))
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
    /// The ones to list, which a search can narrow.
    let positions: [Position]
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
    @Environment(\.walletNames) private var walletNames

    private var rows: [Position] { positions.sorted(using: sort) }

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
                        Text(note).font(.caption).secondaryText().lineLimit(1)
                    }
                    // Once per row, however many of its numbers it affects. A balance that matches says nothing.
                    balanceCheck(position)
                }
                .stale(!position.isHeld)
                .help(breakdown(position) ?? "")
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
                number(position, .price, price.map { Format.estimate(Format.price($0.micros, currency), position.estimates.value) } ?? Wording.noPrice, tone: price == nil ? .secondary : .neutral)
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
                    number(position, .value, value.map { Format.estimate(Format.money($0, currency), position.estimates.value) } ?? Wording.noPrice, tone: value == nil ? .secondary : .neutral)
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
                    number(position, .return, position.returnText, tone: position.returnBps == nil ? .secondary : Tone(signed: position.returnBps))
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

    /// Only a listed one. The selection outlives a search that hides its row, and what isn't showing can't be copied.
    private func position(_ asset: String) -> Position? {
        positions.first { $0.asset == asset }
    }

    private var dash: some View {
        Text("—").foregroundStyle(.tertiary).accessibilityLabel("None").tableCell()
    }

    private func balanceCheck(_ position: Position) -> some View {
        Button {
            target = .asset(position.asset, .onchain)
        } label: {
            OnchainCheck(position: position)
        }
        .buttonStyle(NumberButtonStyle())
    }

    /// Where each wallet's share is, for All Yours, so nothing that's unknown hides inside a total.
    private func breakdown(_ position: Position) -> String? {
        guard let parts = position.wallets, !parts.isEmpty else { return nil }
        return parts.map { part in
            let unknown = part.hasUnknownCost ? ", \(Format.amount(part.unknownCostQty, decimals: position.decimals)) at an unknown cost" : ""
            return "\(walletNames.walletName(part.wallet)): \(Format.amount(part.qty, decimals: position.decimals)) \(position.asset)\(unknown)"
        }.joined(separator: "\n")
    }

    /// Which wallets an unknown cost is in, for All Yours.
    private func unknownIn(_ position: Position) -> String? {
        let parts = (position.wallets ?? []).filter(\.hasUnknownCost)
        guard !parts.isEmpty else { return nil }
        return "Unknown cost in \(parts.map { walletNames.walletName($0.wallet) }.formatted(.list(type: .and)))"
    }

    private func number(_ position: Position, _ metric: AssetMetric, _ text: String, tone: Tone) -> some View {
        Button {
            target = .asset(position.asset, metric)
        } label: {
            LiveNumber(text, tone: isLive ? tone : .neutral)
                .lineLimit(1)
                // A long amount gets smaller rather than losing digits.
                .minimumScaleFactor(0.7)
                .stale(!isLive || !position.isHeld)
                .justKnown(justKnown.contains(position.asset) && (metric == .average || metric == .unrealized || metric == .return))
        }
        .buttonStyle(NumberButtonStyle())
        .help((text == Wording.unknown ? unknownIn(position) : nil) ?? metric.help ?? "")
        .accessibilityLabel(Spoken.number("\(position.asset) \(metric.label)", text, isLive: isLive))
        .tableCell()
    }
}

extension View {
    /// Lines a cell up with its column's title, which the header draws a couple of points in from each side.
    func tableCell() -> some View {
        padding(.horizontal, 2)
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
    let firstRun: FirstRun
    let store: PortfolioStore

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
                if firstRun.isWelcoming, !isSpendingMoney, !canBuy {
                    Button("Try Another Address") { store.setWallet(nil) }
                        .buttonStyle(.borderedProminent)
                    if WalletList.offersDemo, store.address != WalletAddress.demo {
                        Button("Try the Demo Wallet") { store.setWallet(WalletAddress.demo) }
                            .buttonStyle(.link)
                    }
                } else if !isSpendingMoney, !canBuy {
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
            Text("Nothing has moved \(portfolio.isAllYours ? "in any of your wallets" : "for this wallet") in \(Format.duration(ms: BlockTime.msBetween(portfolio.coverage.fromBlock, portfolio.coverage.toBlock))).")
                .help(Wording.coverage(portfolio))
            if firstRun.isWelcoming {
                Text(Wording.emptyOnFirstRead)
            }
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
                Text("or").font(.callout).secondaryText()
                VStack { Divider() }
            }
        }
    }
}

private struct Unavailable: View {
    let store: PortfolioStore
    let firstRun: FirstRun

    /// A server that wants an invite isn't something to try again or restart: only a build with its own server's invite answers it.
    private var wantsInvite: Bool { Build.isForOtherPeople && store.needsInvite }

    var body: some View {
        let problem = store.feed.problem(serverURL: store.serverURL, portfolio: nil)
        ContentUnavailableView {
            Label(wantsInvite ? "This Needs Your Invite" : problem?.title ?? "Can't Show This Wallet", systemImage: wantsInvite ? "envelope" : "exclamationmark.triangle")
        } description: {
            Text(wantsInvite ? InvitePrompt.explanation : problem?.message ?? "")
            if let since = store.readingSince {
                ReadingClock(since: since) { seconds in
                    if seconds >= FeedState.longReadSeconds {
                        Label(Wording.tryingAgain(seconds: seconds), systemImage: "arrow.clockwise")
                            .contentTransition(.numericText())
                    }
                }
            }
        } actions: {
            if wantsInvite {
                Button("Enter Invite…") {
                    if firstRun.isWelcoming { store.setWallet(nil) } else { store.askForInvite() }
                }
                .buttonStyle(.borderedProminent)
            } else if firstRun.isWelcoming {
                // Three would spread out across the page.
                HStack(spacing: 12) {
                    Button("Try Again") { store.refresh() }
                        .buttonStyle(.borderedProminent)
                    Button("Choose Another Wallet") { store.setWallet(nil) }
                    if let detail = problem?.detail {
                        DetailsButton(detail: detail)
                    }
                }
            } else {
                Button("Try Again") { store.refresh() }
                    .buttonStyle(.borderedProminent)
                if let detail = problem?.detail {
                    DetailsButton(detail: detail)
                }
            }
        }
    }
}
