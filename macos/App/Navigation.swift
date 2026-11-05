import Observation
import PricetagKit

/// The main window's sections.
enum AppSection: String, CaseIterable, Identifiable {
    case overview, transactions, spendingMoney, taxReport

    var id: Self { self }

    var title: String {
        switch self {
        case .overview: "Overview"
        case .transactions: "Transactions"
        case .spendingMoney: "Spending Money"
        case .taxReport: "Tax Report"
        }
    }

    var symbol: String {
        switch self {
        case .overview: "chart.line.uptrend.xyaxis"
        case .transactions: "list.bullet"
        case .spendingMoney: "banknote"
        case .taxReport: "doc.text"
        }
    }
}

/// What the main window shows, set from the popover and the menus too.
@Observable
final class Navigation {
    /// Details belong to the section they were opened from, so set this first when opening both.
    var section: AppSection = .overview {
        didSet {
            if section != oldValue { target = nil }
            // There's no wallet button there for the list to belong to.
            if section == .spendingMoney { isSwitchingWallet = false }
        }
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
    /// The extension's Top Up button was pressed. The hot wallet's section takes it from here.
    var wantsTopUp = false
    /// The menu bar's Send button was pressed. The hot wallet's section takes it from here.
    var wantsSend = false
    /// Buy was pressed. It isn't tied to a section, so the window takes it from anywhere.
    var isBuying = false
    /// Buy needs a savings wallet first. The hot wallet's section takes it from here.
    var wantsAddSavings = false
    /// The web app sent over an account from a device. The hot wallet's window asks the person to check it.
    var addingSavings: AddSavingsLink?
    /// Asked for from a row in the wallet list, which closes when the person goes off to sign. So it's the window that holds this.
    var provingWallet: WalletProof?
    var isResolving = false
    /// Which holding Fill In was clicked on, so its questions come first.
    var resolvingAsset: String?
    var isExporting = false
    /// A notification was clicked. Spending Money scrolls to its row and lights it up, and the window opens if it's closed.
    var shownRow: String?

    /// Spending Money is always this Mac's, so the wallet button isn't there. Every other section shows the wallet chosen.
    func switchWallet() {
        showChosenWallet()
        isSwitchingWallet = true
    }

    func showChosenWallet() {
        if section == .spendingMoney { section = .overview }
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

    /// Goes to spending money and asks for its Send sheet, which appears once the section is on screen.
    func send() {
        section = .spendingMoney
        wantsSend = true
    }

    /// Goes to spending money and asks for its Top Up sheet, which appears once the section is on screen.
    func topUp() {
        section = .spendingMoney
        wantsTopUp = true
    }

    /// Goes to spending money and adds a savings wallet, which appears once the section is on screen.
    func addSavings() {
        section = .spendingMoney
        wantsAddSavings = true
    }

    /// Goes to spending money and shows one of its rows, which it scrolls to once the section is on screen.
    func show(row: String) {
        section = .spendingMoney
        shownRow = row
    }

    func resolve(_ asset: String? = nil) {
        resolvingAsset = asset
        isResolving = true
    }
}
