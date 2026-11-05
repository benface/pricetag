/// How far apart Base's blocks are. The same as `chain.ts` in the SDK, which format-vectors.json holds this to.
public enum BlockTime {
    /// Base's first block of the 200 ms upgrade, set for November 5, 2026 at 18:00 UTC. Blocks are 2 s apart up to this one,
    /// and 200 ms apart after it. Change it if Base moves the date.
    static let last2sBlock = 53_556_127
    private static let slowMs = 2000
    private static let fastMs = 200

    /// How long after block `from` block `to` came.
    public static func msBetween(_ from: Int, _ to: Int) -> Int {
        let slow = max(0, min(to, last2sBlock) - from)
        let fast = max(0, to - max(from, last2sBlock))
        return slow * slowMs + fast * fastMs
    }

    /// The newest block at least `ms` before `block`.
    public static func blockBefore(_ block: Int, ms: Int) -> Int {
        let fastSpan = max(0, block - last2sBlock) * fastMs
        if ms <= fastSpan { return block - dividedUp(ms, by: fastMs) }
        return max(0, min(block, last2sBlock) - dividedUp(ms - fastSpan, by: slowMs))
    }

    private static func dividedUp(_ value: Int, by divisor: Int) -> Int {
        (value + divisor - 1) / divisor
    }
}
