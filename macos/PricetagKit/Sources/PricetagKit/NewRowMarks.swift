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
