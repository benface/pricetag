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
        didSet { if section != oldValue { target = nil } }
    }
    var chartRange: ChartRange = .all
    /// The number being explained in the details.
    var target: ExplainTarget?
    var isChangingWallet = false
    /// The extension's Top Up button was pressed. The hot wallet's section takes it from here.
    var wantsTopUp = false
    /// The menu bar's Send button was pressed. The hot wallet's section takes it from here.
    var wantsSend = false
    var isResolving = false
    /// Which holding Fill In was clicked on, so its questions come first.
    var resolvingAsset: String?
    var isExporting = false

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

    func resolve(_ asset: String? = nil) {
        resolvingAsset = asset
        isResolving = true
    }
}
