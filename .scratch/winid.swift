import CoreGraphics
import Foundation
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowOwnerName as String] as? String) == "Patina" {
  print(w[kCGWindowNumber as String]!, w[kCGWindowName as String] ?? "", w[kCGWindowBounds as String]!)
}
