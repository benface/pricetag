import Foundation

/// Compares what the chain says this wallet did with what this device signed.
public enum AlarmCheck {
    /// Against Amp's history: anything that took from this wallet or paid gas from it, that this device didn't sign.
    public static func findings(outgoingTxs: [String], records: [SignedRecord]) -> [StolenKeyAlarm.Finding] {
        let signed = Set(records.map { $0.hash.lowercased() })
        return outgoingTxs.filter { !signed.contains($0.lowercased()) }.map { .unknownTransaction(hash: $0.lowercased()) }
    }

    /// Against the node: every transaction a key sends uses up the next nonce, starting at 0, so each nonce the chain has used
    /// has to be one this device signed. A gap stays a gap however many transactions come after it, including this app's own.
    public static func findings(onchainNonce: UInt64, records: [SignedRecord], acknowledgedThrough: UInt64? = nil) -> [StolenKeyAlarm.Finding] {
        let start = min(acknowledgedThrough ?? 0, onchainNonce)
        let signed = Set(records.filter { $0.status != .dropped && $0.nonce >= start && $0.nonce < onchainNonce }.map(\.nonce))
        let unexplained = onchainNonce - start - UInt64(signed.count)
        return unexplained > 0 ? [.nonceAhead(signed: onchainNonce - unexplained, onchain: onchainNonce)] : []
    }

    /// One past the last nonce signed that's still in play. A dropped transaction's nonce gets used again.
    public static func nextNonce(records: [SignedRecord], onchainNonce: UInt64) -> UInt64 {
        let signed = records.filter { $0.status != .dropped }.map { $0.nonce + 1 }.max() ?? 0
        return max(signed, onchainNonce)
    }
}
