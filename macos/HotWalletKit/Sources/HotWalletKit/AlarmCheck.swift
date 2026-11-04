import Foundation

/// Compares what the chain says this wallet did with what this device signed.
public enum AlarmCheck {
    /// Against Amp's history: anything that took from this wallet or paid gas from it, that this device didn't sign.
    public static func findings(outgoingTxs: [String], records: [SignedRecord]) -> [StolenKeyAlarm.Finding] {
        let signed = Set(records.map { $0.hash.lowercased() })
        return outgoingTxs.filter { !signed.contains($0.lowercased()) }.map { .unknownTransaction(hash: $0.lowercased()) }
    }

    /// Against the node: the number of transactions this key has sent, which a thief can't help but increase.
    public static func findings(onchainNonce: UInt64, records: [SignedRecord]) -> [StolenKeyAlarm.Finding] {
        let expected = nextNonce(records: records, onchainNonce: 0)
        return onchainNonce > expected ? [.nonceAhead(signed: expected, onchain: onchainNonce)] : []
    }

    /// One past the last nonce signed that's still in play. A dropped transaction's nonce gets used again.
    public static func nextNonce(records: [SignedRecord], onchainNonce: UInt64) -> UInt64 {
        let signed = records.filter { $0.status != .dropped }.map { $0.nonce + 1 }.max() ?? 0
        return max(signed, onchainNonce)
    }
}
