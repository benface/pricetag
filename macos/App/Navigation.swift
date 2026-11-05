import HotWalletKit
import Observation
import PricetagKit

/// The main window's sections.
enum AppSection: String, CaseIterable, Identifiable {
    case overview, transactions, taxReport

    var id: Self { self }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .transactions: "Transactions"
        case .taxReport: "Tax Report"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "chart.line.uptrend.xyaxis"
        case .transactions: "list.bullet"
        case .taxReport: "doc.text"
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
        didSet { if section != oldValue { target = nil } }
    }
    var chartRange: ChartRange = .all
    /// The number being explained in the details.
    var target: ExplainTarget?
    var isSwitchingWallet = false {
        // Here and not in a view, because the view that opened the list can be gone by the time it closes.
        didSet { if oldValue, !isSwitchingWallet { onSwitcherClosed?() } }
    }
    /// A wallet's name while it's being typed. Closing the list keeps it, whichever way the list closes, and only Esc cancels.
    let pendingWalletName = PendingWalletName()
    @ObservationIgnored var onSwitcherClosed: (() -> Void)?
    /// The extension's Top Up button was pressed. Spending Money's page takes it from here.
    var wantsTopUp = false
    /// The menu bar's Send button was pressed. Spending Money's page takes it from here.
    var wantsSend = false
    /// Buy was pressed. It isn't tied to a section, so the window takes it from anywhere.
    var isBuying = false
    /// Receive was pressed. Like Buy, the window takes it from anywhere.
    var isReceiving = false
    /// The extension's Receive button was pressed. The menu bar item opens the window for it, since nothing else may be open.
    var wantsReceive = false
    /// Delete was chosen in the wallet list. Spending Money's page asks to confirm it.
    var wantsDelete = false
    /// Buy needs a savings wallet first. Spending Money's page takes it from here.
    var wantsAddSavings = false
    /// The web app sent over an account from a device. Spending Money's page asks the person to check it.
    var addingSavings: AddSavingsLink?
    /// There's no Spending Money to show yet, or it can't be opened. This says what it is, and is the only place that makes a key.
    var isSettingUpSpendingMoney = false
    /// Asked for from a row in the wallet list, which closes first. So it's the window that holds this.
    var removingFromSavings: WalletEntry?
    /// Which pane Settings opens on, for what points there from elsewhere.
    var settingsPane = SettingsView.Pane.general
    var isResolving = false
    /// Which holding Fill In was clicked on, so its questions come first.
    var resolvingAsset: String?
    var isExporting = false

    func switchWallet() {
        isSwitchingWallet = true
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

    /// Opens the details of a number, which belong to the overview.
    func explain(_ target: ExplainTarget) {
        section = .overview
        self.target = target
    }

    /// Goes to spending money and asks for its Send sheet, which appears once the page is on screen.
    func send() {
        showSpendingMoney()
        wantsSend = true
    }

    /// Goes to spending money and asks for its Top Up sheet, which appears once the page is on screen.
    func topUp() {
        showSpendingMoney()
        wantsTopUp = true
    }

    /// Goes to spending money and adds a savings wallet, which appears once the page is on screen.
    func addSavings() {
        showSpendingMoney()
        wantsAddSavings = true
    }

    /// Goes to spending money and asks to confirm deleting it, which appears once the page is on screen.
    func deleteSpendingMoney() {
        showSpendingMoney()
        wantsDelete = true
    }

    func resolve(_ asset: String? = nil) {
        resolvingAsset = asset
        isResolving = true
    }
}
