import HotWalletKit
import PricetagKit
import SwiftUI

/// Every transaction, by day and newest first: what happened, who with, how much and what it made. ⌘F searches, and a menu narrows it to a token.
/// Running totals and what they leave out are in each transaction's details, and on the chart.
struct TransactionsPage<Notices: View>: View {
    let portfolio: Portfolio
    let store: PortfolioStore
    let hotWallet: HotWallet
    let isLive: Bool
    @Bindable var navigation: Navigation
    let notices: Notices
    @State private var log: TransactionLog?
    @State private var days: [TransactionDay] = []
    @State private var shownCount = 0
    @State private var query = ""
    @State private var asset: String?
    @FocusState private var isSearching: Bool

    /// What the list is built from. The store's revision stands in for the portfolio, whose points are too many to compare each time
    /// the view updates. It changes with every replacement, including numbers the server or this Mac kept from an earlier read.
    private struct Source: Equatable, Sendable {
        let revision: Int
        let signed: [SentTransaction]
        let names: [String: String]
    }

    private var source: Source {
        Source(revision: store.portfolioRevision, signed: signed, names: names)
    }

    /// What this Mac sent from the wallet showing, until the server has read it.
    private var signed: [SentTransaction] {
        guard let address = hotWallet.address?.lowercased, address == store.address else { return [] }
        return hotWallet.records.compactMap(SentTransaction.init)
    }

    /// What the person calls each of their wallets and the ones they watch.
    private var names: [String: String] {
        var names: [String: String] = [:]
        for entry in store.walletList(hotWallet: hotWallet).all where !WalletAddress.isDemo(entry.address) {
            if let name = entry.name ?? (entry.kind.isOwn ? entry.kind.label : nil) { names[entry.address.lowercased()] = name }
        }
        return names
    }

    var body: some View {
        VStack(spacing: 0) {
            notices.padding(12)
            if let log {
                if log.isEmpty {
                    ContentUnavailableView("No Transactions Yet", systemImage: "list.bullet", description: Text("They'll show up here as they happen."))
                } else {
                    filterBar(log)
                    Divider()
                    // In the list's own currency, which is the one its amounts were read in, until the new list is ready.
                    TransactionsTable(days: days, currency: log.currency, portfolio: portfolio, isLive: isLive, showsWallets: portfolio.isAllYours, target: $navigation.target) { navigation.resolve($0) }
                        .overlay {
                            if days.isEmpty { ContentUnavailableView.search(text: query) }
                        }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .searchable(text: $query, placement: .toolbar, prompt: "Token, name, address or hash")
        .searchFocused($isSearching)
        // Tens of thousands of rows take a moment to read, so that's done away from the screen.
        .task(id: source) {
            // The points and their currency from the same portfolio.
            let built = await readLog(portfolio.points, currency: portfolio.currency, signed: source.signed, names: source.names)
            guard !Task.isCancelled else { return }
            log = built
            if let asset, !built.assets.contains(asset) { self.asset = nil }
            refilter()
        }
        .onChange(of: query) { refilter() }
        .onChange(of: asset) { refilter() }
        .onChange(of: navigation.wantsSearch, initial: true) { _, wants in
            guard wants else { return }
            navigation.wantsSearch = false
            isSearching = true
        }
    }

    private func refilter() {
        guard let log else { return }
        days = log.days(query: query, asset: asset)
        shownCount = days.reduce(0) { $0 + $1.items.count }
    }

    private func filterBar(_ log: TransactionLog) -> some View {
        HStack(spacing: 8) {
            Picker("Token", selection: $asset) {
                Text("All Tokens").tag(String?.none)
                Divider()
                ForEach(log.assets, id: \.self) { Text($0).tag(String?.some($0)) }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .fixedSize()
            .help("Show only what moved one token")
            Spacer(minLength: 8)
            Text(count(of: log))
                .font(.callout)
                .secondaryText()
                .monospacedDigit()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func count(of log: TransactionLog) -> String {
        let total = log.items.count
        let noun = total == 1 ? "transaction" : "transactions"
        return shownCount == total ? "\(total.formatted()) \(noun)" : "\(shownCount.formatted()) of \(total.formatted()) \(noun)"
    }
}

/// Away from the main thread, and outside the generic view, which a detached task can't capture.
private func readLog(_ points: [PnlPoint], currency: CurrencyCode, signed: [SentTransaction], names: [String: String]) async -> TransactionLog {
    await Task.detached(priority: .userInitiated) {
        TransactionLog(points: points, currency: currency, signed: signed, names: names)
    }.value
}

/// The rows, under a heading for each day. Up and down move through them and show each one's details.
private struct TransactionsTable: View {
    let days: [TransactionDay]
    /// The rows' own, and not the portfolio's, which can already be in another one.
    let currency: CurrencyCode
    /// Only for what can be answered, which is about the numbers now.
    let portfolio: Portfolio
    let isLive: Bool
    /// Which wallet each one is in, for All Yours.
    let showsWallets: Bool
    @Binding var target: ExplainTarget?
    let onResolve: (String) -> Void
    @Environment(\.walletNames) private var walletNames
    @State private var selection: TransactionItem.ID?
    @State private var width: CGFloat = 800
    @State private var columns = TableColumnCustomization<TransactionItem>()
    @FocusState private var isFocused: Bool

    /// Below this, who it was with and which wallet give way. They're still in the details, and still searchable.
    private static let counterpartyWidth: CGFloat = 620
    private static let counterpartyID = "counterparty"
    private static let walletID = "wallet"

    private var targetHash: String? {
        if case .transaction(let hash) = target { hash } else { nil }
    }

    private var isNarrow: Bool { width < Self.counterpartyWidth }

    /// Hiding a column doesn't give its width to the others, so in a narrow window each stops at what it needs, and what happened gets the rest.
    private func limit(_ width: CGFloat) -> CGFloat? {
        isNarrow ? width : nil
    }

    private var whatHappenedLimit: CGFloat? {
        isNarrow ? max(160, width - 70 - 90 - 80 - 100) : nil
    }

    var body: some View {
        Table(of: TransactionItem.self, selection: $selection, columnCustomization: $columns) {
            TableColumn("Time") { item in
                Text(item.date.map(Format.clock) ?? "—")
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .tableCell()
            }
            .width(min: 64, ideal: 70, max: limit(70) ?? 90)
            .disabledCustomizationBehavior(.all)
            TableColumn("What happened") { item in
                whatHappened(item)
                    .tableCell()
            }
            .width(min: 160, max: whatHappenedLimit)
            .disabledCustomizationBehavior(.all)
            TableColumn("Who") { item in
                if let who = item.counterpartyText {
                    Text(who)
                        .lineLimit(1)
                        .help(item.counterparty ?? who)
                        .tableCell()
                } else {
                    dash
                }
            }
            .width(min: 90, ideal: 150, max: 220)
            .customizationID(Self.counterpartyID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Wallet") { item in
                let names = item.wallets.map(walletNames.walletName).formatted(.list(type: .and))
                Text(names)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .help(names)
                    .tableCell()
            }
            .width(min: 90, ideal: 110, max: 220)
            .customizationID(Self.walletID)
            .disabledCustomizationBehavior(.all)
            TableColumn("Amount") { item in
                if let amount = item.amountText(currency) {
                    LiveNumber(amount, tone: item.amount?.micros == nil ? .secondary : .neutral)
                        .lineLimit(1)
                        .stale(!isLive)
                        .accessibilityLabel(Spoken.number("Amount", amount, isLive: isLive))
                        .tableCell()
                } else {
                    dash
                }
            }
            .width(min: 80, ideal: 100, max: limit(90) ?? 140)
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
            TableColumn("Gain") { item in
                // What a sale made rests on costs, so it's what can change while a read runs. Once per row, like the holdings.
                if let gain = item.gainText(currency) {
                    LiveNumber(gain, tone: item.gain?.micros == nil ? .secondary : isLive ? Tone(signed: item.gain?.micros) : .neutral)
                        .lineLimit(1)
                        .stale(!isLive)
                        .help(Wording.realizedHelp)
                        .accessibilityLabel(Spoken.number("Gain", gain, isLive: isLive))
                        .updatingMark()
                        .tableCell()
                } else {
                    dash.updatingMark()
                }
            }
            .width(min: 70, ideal: 90, max: limit(80) ?? 120)
            .alignment(.numeric)
            .disabledCustomizationBehavior(.all)
        } rows: {
            ForEach(days) { day in
                Section(day.title) {
                    ForEach(day.items) { TableRow($0) }
                }
            }
        }
        .tableStyle(.inset)
        .alternatingRowBackgrounds(.disabled)
        .focused($isFocused)
        .onAppear { isFocused = true }
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width = $0 }
        .onChange(of: isNarrow, initial: true) {
            columns[visibility: Self.counterpartyID] = isNarrow ? .hidden : .visible
        }
        // Not `if` around the column, for the same reason as the holdings' columns.
        .onChange(of: showsWallets && !isNarrow, initial: true) { _, shows in
            columns[visibility: Self.walletID] = shows ? .visible : .hidden
        }
        .onChange(of: selection) { _, id in
            // What the server hasn't read has nothing to explain yet.
            guard let id, id != targetHash, item(id)?.isRead == true else { return }
            target = .transaction(id)
        }
        .onChange(of: target, initial: true) {
            selection = targetHash
        }
        .contextMenu(forSelectionType: TransactionItem.ID.self) { ids in
            if let id = ids.first, let item = item(id) {
                // What the server hasn't read has no details to show yet.
                TransactionActions(hash: item.txHash, onShow: item.isRead ? { target = .transaction(id) } : nil)
                if let counterparty = item.counterparty {
                    Button("Copy Address") { Clipboard.copy(counterparty) }
                }
            }
        }
        .onCopyCommand {
            guard let hash = selection.flatMap(item)?.txHash else { return [] }
            return [NSItemProvider(object: hash as NSString)]
        }
        .accessibilityLabel("Transactions")
    }

    private func item(_ id: TransactionItem.ID) -> TransactionItem? {
        for day in days {
            if let item = day.items.first(where: { $0.id == id }) { return item }
        }
        return nil
    }

    @ViewBuilder
    private func whatHappened(_ item: TransactionItem) -> some View {
        HStack(spacing: 6) {
            switch item.status {
            case .pending:
                Text("On its way").font(.caption).secondaryText()
            case .failed:
                Text("Failed").font(.caption.weight(.medium)).foregroundStyle(Tone.warning.style)
                    .help("It didn't go through. Its network fee was still spent.")
            case .done:
                EmptyView()
            }
            if let summary = item.summary {
                Text(summary)
                    .lineLimit(1)
                    .help(summary)
            } else {
                Text("—").foregroundStyle(.tertiary)
            }
            Spacer(minLength: 4)
            unknownCost(item)
        }
    }

    /// Said once per row, with a way to fix it when there is one.
    @ViewBuilder
    private func unknownCost(_ item: TransactionItem) -> some View {
        if !item.unknownCost.isEmpty {
            let fixable = item.answerableAsset(in: portfolio.questions)
            // In a narrow window, or beside the wallets, what happened needs the room more, and the button's tooltip still says it.
            if !(isNarrow || showsWallets) || fixable == nil {
                Text("Cost unknown")
                    .font(.caption)
                    .secondaryText()
                    .lineLimit(1)
                    .fixedSize()
                    .help("What you paid for \(list(item.unknownCost)) is unknown, so it isn't in your PnL.")
            }
            if let fixable {
                let title = Wording.answerQuestions(portfolio.questions.count { $0.arrivals.contains { $0.asset == fixable } })
                // The same button as the holdings, whose name is in its tooltip and for VoiceOver.
                Button(title, systemImage: "questionmark.bubble") { onResolve(fixable) }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .accessibilityLabel("\(title) about \(fixable)")
                    .help("What you paid for \(list(item.unknownCost)) is unknown. \(title) about \(fixable), so what you paid is known.")
            }
        }
    }

    private func list(_ assets: [String]) -> String {
        assets.formatted(.list(type: .and))
    }

    private var dash: some View {
        Text("—").foregroundStyle(.tertiary).tableCell()
    }
}
