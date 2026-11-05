// When a holding's cost goes from unknown to known. It's for the one moment the app makes something of that, so it only ever reports what the server's numbers already say.

import Foundation

public struct CostWatch: Equatable, Sendable {
    let wallet: String
    let unknown: Set<String>
    let known: Set<String>

    /// Which holdings have a cost now and didn't in `earlier`. None across wallets, and none where a holding only arrived now, since nothing became known about it.
    public func arrivals(since earlier: CostWatch) -> Set<String> {
        wallet == earlier.wallet ? known.intersection(earlier.unknown) : []
    }
}

extension Portfolio {
    public var costWatch: CostWatch {
        let held = listedPositions.filter(\.isHeld)
        return CostWatch(
            wallet: address.lowercased(),
            unknown: Set(held.filter(\.hasUnknownCost).map(\.asset)),
            known: Set(held.filter { !$0.hasUnknownCost && $0.values.averageCostMicros != nil }.map(\.asset))
        )
    }
}
