import HotWalletKit
import Observation
import PricetagKit
import SwiftUI

/// The main window's sections.
enum AppSection: String, CaseIterable, Identifiable {
    case overview, transactions, taxReport, security

    var id: Self { self }

    /// Security is about what Spending Money can do, and what a site was allowed to, and a watch-only build can act on none of it.
    static var shown: [AppSection] {
        Build.isWatchOnly ? allCases.filter { $0 != .security } : allCases
    }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .transactions: "Transactions"
        case .taxReport: "Tax Report"
        case .security: "Security"
        }
    }

    /// ⌘4 was Spending Money's before it was a wallet like any other, and it still is, so Security comes after it.
    var shortcut: KeyEquivalent {
        switch self {
        case .overview: "1"
        case .transactions: "2"
        case .taxReport: "3"
        case .security: "5"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "chart.line.uptrend.xyaxis"
        case .transactions: "list.bullet"
        case .taxReport: "doc.text"
        case .security: "lock.shield"
        }
    }
}

/// Something asked for from elsewhere, which may have no window open yet. It waits in `Navigation.pending` until what it's for is on screen,
/// and that takes it. There's only ever one: whatever was asked for last is what the person wants now.
enum Intent: Equatable {
    /// The extension's Top Up button, or Top Up in the menu bar. Spending Money's page takes these, and the next four.
    case topUp
    case send
    /// Buy needs a savings wallet first.
    case addSavings
    /// The web app sent over an account from a device. The page opens the sheet that asks the person to check it, and the sheet takes it.
    case addSavingsFromDevice(AddSavingsLink)
    /// A notification was clicked. The page scrolls to its row and lights it up.
    case show(row: String)
    /// Delete was chosen in the wallet list. The page asks to confirm it.
    case deleteSpendingMoney
    /// The window takes these three from any section.
    case buy
    case receive
    case export
    /// ⌘F. The search field of the section showing takes it.
    case search

    /// What only Spending Money's page can take. If it doesn't get made, there's no page, and left waiting these would open by surprise once there is one.
    var needsSpendingMoney: Bool {
        switch self {
        case .topUp, .send, .addSavings, .addSavingsFromDevice, .show: true
        case .deleteSpendingMoney, .buy, .receive, .export, .search: false
        }
    }
}

/// What the main window shows, set from the popover and the menus too.
@Observable
final class Navigation {
    @ObservationIgnored private let store: PortfolioStore
    @ObservationIgnored private let hotWallet: HotWallet

    init(store: PortfolioStore, hotWallet: HotWallet) {
        self.store = store
        self.hotWallet = hotWallet
    }

    /// Details belong to the section they were opened from, so set this first when opening both.
    var section: AppSection = .overview {
        didSet { if section != oldValue { forgetDetails() } }
    }
    var chartRange: ChartRange = .all
    var chartMetric: ChartMetric = .pnl
    /// The number being explained in the details.
    var target: ExplainTarget? {
        didSet { if target == nil, let oldValue { closedTarget = oldValue } }
    }
    /// What the details last showed, so Show Details opens them again on it.
    @ObservationIgnored private var closedTarget: ExplainTarget?
    var isSwitchingWallet = false {
        // Here and not in a view, because the view that opened the list can be gone by the time it closes.
        didSet { if oldValue, !isSwitchingWallet { onSwitcherClosed?() } }
    }
    /// A wallet's name while it's being typed. Closing the list keeps it, whichever way the list closes, and only Esc cancels.
    let pendingWalletName = PendingWalletName()
    @ObservationIgnored var onSwitcherClosed: (() -> Void)?
    /// Welcome was chosen in the Help menu, with a wallet already showing.
    var isShowingWelcomeAgain = false
    /// What's been asked for and not been taken yet.
    var pending: Intent?
    /// There's no Spending Money to show yet, or it can't be opened. This says what it is, and is the only place that makes a key.
    var isSettingUpSpendingMoney = false {
        // Here and not in a view, for the same reason as the wallet list. Cancelled, there's no page to take what was asked for.
        didSet { if oldValue, !isSettingUpSpendingMoney, hotWallet.address == nil, pending?.needsSpendingMoney == true { pending = nil } }
    }
    /// Asked for from a row in the wallet list, which closes first. So it's the window that holds this.
    var removingFromSavings: WalletEntry?
    /// Which pane Settings opens on, for what points there from elsewhere.
    var settingsPane = SettingsView.Pane.general
    var isResolving = false
    /// Which holding's questions were asked for, so they come first.
    var resolvingAsset: String?
    /// Another wallet whose questions open once it's showing, like one a tax report includes.
    private(set) var resolvingWallet: String?
    /// Where to go back to once those questions close.
    private(set) var returnWallet: String?
    /// What's being searched for in the holdings, until they're left. It's here so a test scene can set it.
    var holdingsQuery = ""

    func switchWallet() {
        isSwitchingWallet = true
    }

    /// Asked for from the Help menu, from whichever section this is on.
    func showWelcome(_ firstRun: FirstRun) {
        let hasWallet = store.address != nil
        firstRun.showAgain(hasWallet: hasWallet)
        if hasWallet {
            isShowingWelcomeAgain = true
        } else {
            section = .overview
        }
    }

    /// Spending Money is a wallet like any other, so this chooses it and goes to its page, or offers to make one.
    func showSpendingMoney() {
        section = .overview
        if let address = hotWallet.address {
            store.setWallet(address.lowercased)
        } else {
            isSettingUpSpendingMoney = true
        }
    }

    /// What the wallet's page shows: its holdings, or where to enter a wallet when there isn't one.
    func showOverview() {
        section = .overview
    }

    /// Only where there's a wallet's numbers to explain.
    var canShowDetails: Bool {
        section == .overview || section == .transactions
    }

    /// The View menu's. With nothing opened yet, the details start on the total PnL, which everything else adds up to.
    func toggleDetails() {
        target = target == nil ? closedTarget ?? .total(.pnl) : nil
    }

    /// For another section or wallet, where the last details mean something else, or nothing.
    func forgetDetails() {
        target = nil
        closedTarget = nil
    }

    /// Opens the details of a number, which belong to the overview.
    func explain(_ target: ExplainTarget) {
        section = .overview
        self.target = target
    }

    /// Goes to spending money and asks for its Send sheet, which appears once the page is on screen.
    func send() {
        showSpendingMoney()
        pending = .send
    }

    /// Goes to spending money and asks for its Top Up sheet, which appears once the page is on screen.
    func topUp() {
        showSpendingMoney()
        pending = .topUp
    }

    /// Goes to spending money and adds a savings wallet, which appears once the page is on screen.
    func addSavings() {
        showSpendingMoney()
        pending = .addSavings
    }

    /// Goes to spending money and asks to confirm deleting it, which appears once the page is on screen.
    func deleteSpendingMoney() {
        showSpendingMoney()
        pending = .deleteSpendingMoney
    }

    /// What ⌘F searches: the holdings on the overview. The other sections have no search of their own, so it goes to the transactions.
    var findTitle: String {
        section == .overview ? "Find Holdings…" : "Find Transactions…"
    }

    /// A wallet with nothing to show has neither, and no field to take it.
    var canFind: Bool {
        guard let portfolio = store.portfolio else { return false }
        return portfolio.progress.started && !portfolio.isEmpty && !portfolio.holdsOnlyOtherTokens
    }

    /// Puts the cursor in the holdings' search field on the overview. From anywhere else, goes to the transactions and puts it in theirs.
    func find() {
        if section != .overview { section = .transactions }
        pending = .search
    }

    /// Goes to spending money and shows one of its rows, which it scrolls to once the page is on screen.
    func show(row: String) {
        showSpendingMoney()
        pending = .show(row: row)
    }

    /// Spending Money's page is the one chosen, whether or not the window's open.
    var isShowingSpendingMoney: Bool {
        guard section == .overview, let address = hotWallet.address else { return false }
        return store.address == address.lowercased
    }

    func resolve(_ asset: String? = nil) {
        resolvingAsset = asset
        isResolving = true
    }

    /// A wallet's questions are about that wallet, so this shows it, opens them once its numbers are in, and comes back
    /// to the wallet that was showing when they close. The section stays, so a tax report is still there with the answers.
    func resolve(in wallet: String) {
        guard wallet != store.address else { return resolve() }
        returnWallet = store.address
        resolvingWallet = wallet
        store.setWallet(wallet)
    }

    /// Called whenever the wallet or its numbers change.
    func openPendingQuestions() {
        guard let resolvingWallet else { return }
        if store.address != resolvingWallet {
            // Another wallet was chosen in the meantime, so neither the questions nor the way back apply anymore.
            if store.address != returnWallet { forgetPendingQuestions() }
            return
        }
        guard store.portfolio?.address.lowercased() == resolvingWallet else { return }
        self.resolvingWallet = nil
        resolve()
    }

    /// Called when the questions close.
    func returnFromQuestions() {
        guard resolvingWallet == nil, let returnWallet else { return }
        self.returnWallet = nil
        store.setWallet(returnWallet)
    }

    private func forgetPendingQuestions() {
        resolvingWallet = nil
        returnWallet = nil
    }
}
