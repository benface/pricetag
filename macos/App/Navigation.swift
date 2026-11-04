import Observation
import PricetagKit

/// What the main window shows, set from the popover and the menus too.
@Observable
final class Navigation {
    /// The number being explained in the inspector.
    var target: ExplainTarget?
    var isChangingWallet = false
}
