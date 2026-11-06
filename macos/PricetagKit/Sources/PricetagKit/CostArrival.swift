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

/// Rows that just appeared in a list, marked for a moment so the eye finds them. One that appears under a sheet, like a send whose sheet
/// waits for its receipt, is held until the sheet goes, or its mark would come and go where nobody can see it.
public struct NewRowMarks: Equatable, Sendable {
    /// What's marked now.
    public private(set) var lit: Set<String> = []
    private var held: Set<String> = []

    public init() {}

    public mutating func rowsChanged(from old: [String], to new: [String], isCovered: Bool) {
        let added = Set(new).subtracting(old)
        if isCovered { held.formUnion(added) } else { lit.formUnion(added) }
    }

    /// The sheet's gone, however it closed: what came in under it is marked from now.
    public mutating func uncovered() {
        lit.formUnion(held)
        held = []
    }

    /// Once it's been marked long enough.
    public mutating func fade() {
        lit = []
    }
}
