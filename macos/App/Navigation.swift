import Observation
import PricetagKit

/// What the main window shows, set from the popover and the menus too.
@Observable
final class Navigation {
    /// The number being explained in the inspector.
    var target: ExplainTarget?
    var isChangingWallet = false
    var isExportingTaxReport = false
    /// The chart's transactions as a list, which is how to reach them from the keyboard or VoiceOver.
    var showsTransactions = false
}
