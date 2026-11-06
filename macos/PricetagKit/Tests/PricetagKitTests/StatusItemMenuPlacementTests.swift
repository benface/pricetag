import Foundation
import Testing
@testable import PricetagKit

struct StatusItemMenuPlacementTests {
    /// Measured on a MacBook Pro with a notch on macOS 27.2: the item's window ends at 1084, and the free space at 1083.
    @Test func staysBelowTheMenuBarOnADisplayWithANotch() {
        let origin = StatusItemMenuPlacement.origin(
            itemWindow: CGRect(x: 1026, y: 1084, width: 16, height: 33),
            screenVisibleFrame: CGRect(x: 0, y: 54, width: 1728, height: 1029)
        )
        #expect(origin == CGPoint(x: 1026, y: 1078))
    }

    @Test func usesTheItemsWindowWhenItAlreadyEndsUnderTheMenuBar() {
        let origin = StatusItemMenuPlacement.origin(
            itemWindow: CGRect(x: 1200, y: 1056, width: 40, height: 24),
            screenVisibleFrame: CGRect(x: 0, y: 0, width: 1920, height: 1056)
        )
        #expect(origin == CGPoint(x: 1200, y: 1051))
    }

    /// With the menu bar hiding itself, the free space reaches the top of the display, and the bar comes down over it.
    @Test func usesTheItemsWindowWhenTheMenuBarHidesItself() {
        let origin = StatusItemMenuPlacement.origin(
            itemWindow: CGRect(x: 1200, y: 1056, width: 40, height: 24),
            screenVisibleFrame: CGRect(x: 0, y: 0, width: 1920, height: 1080)
        )
        #expect(origin == CGPoint(x: 1200, y: 1051))
    }

    /// A second display above the first, whose coordinates don't start at zero.
    @Test func worksOnADisplayAwayFromTheOrigin() {
        let origin = StatusItemMenuPlacement.origin(
            itemWindow: CGRect(x: -400, y: 2197, width: 40, height: 33),
            screenVisibleFrame: CGRect(x: -1000, y: 1117, width: 1728, height: 1079)
        )
        #expect(origin == CGPoint(x: -400, y: 2191))
    }

    @Test func usesTheItemsWindowWithoutAScreen() {
        let origin = StatusItemMenuPlacement.origin(itemWindow: CGRect(x: 10, y: 20, width: 40, height: 24), screenVisibleFrame: nil)
        #expect(origin == CGPoint(x: 10, y: 15))
    }
}
