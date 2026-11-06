// Where the menu bar item's right-click menu opens.

import Foundation

public enum StatusItemMenuPlacement {
    /// AppKit puts a menu's first row at the point it's given, with this much of the menu above it. Measured on macOS 27.2.
    static let spaceAboveFirstRow: CGFloat = 5

    /// The point to open the menu at, in screen coordinates, so its top edge sits directly under the menu bar at the item's left edge.
    /// A menu that starts even a point too high scrolls, with an arrow in place of its first row. The bar's bottom is the lower of two edges, because on a display with a notch the item's window stops a point short of it, and it's the window's when the menu bar hides itself and the display's free space reaches the top.
    /// `screenVisibleFrame` is nil if the window has no screen.
    public static func origin(itemWindow: CGRect, screenVisibleFrame: CGRect?) -> CGPoint {
        CGPoint(x: itemWindow.minX, y: min(itemWindow.minY, screenVisibleFrame?.maxY ?? itemWindow.minY) - spaceAboveFirstRow)
    }
}
