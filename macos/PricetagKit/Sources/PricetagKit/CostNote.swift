// A cost someone publishes themselves: a zero-value transaction from a wallet to itself. `packages/sdk/src/notes.ts` is what reads
// it, and a test compares the two.

import Foundation

public enum CostNote {
    /// The calldata for a note, or nil for anything `parseNote` wouldn't read back, since that would spend gas on nothing.
    public static func calldata(txHash: String, asset: String, usdMicros: String) -> [UInt8]? {
        guard txHash.wholeMatch(of: /0x[0-9a-f]{64}/) != nil, asset.wholeMatch(of: /[A-Za-z0-9]{1,16}/) != nil, usdMicros.wholeMatch(of: /[0-9]{1,30}/) != nil else { return nil }
        return Array("patina:cost:1:\(txHash):\(asset):\(usdMicros)".utf8)
    }
}

/// One movement a note could be about. Only the wallet it arrived in can publish it, because the sender is the author.
public struct CostNoteDraft: Equatable, Identifiable, Sendable {
    public let wallet: String
    public let txHash: String
    public let asset: String
    public let decimals: Int
    public let units: String

    public var id: String { "\(wallet):\(txHash):\(asset)" }

    public init(wallet: String, txHash: String, asset: String, decimals: Int, units: String) {
        self.wallet = wallet
        self.txHash = txHash
        self.asset = asset
        self.decimals = decimals
        self.units = units
    }
}

extension Question {
    /// The server says when a note could answer this. One that covered less than what it names would replace the cost of the rest.
    public var noteDraft: CostNoteDraft? {
        guard let txHash = noteAbout, arrivals.count == 1, receipts.count == 1, let arrival = arrivals.first, let receipt = receipts.first else { return nil }
        guard CostNote.calldata(txHash: txHash, asset: arrival.asset, usdMicros: "0") != nil else { return nil }
        return CostNoteDraft(wallet: receipt.wallet, txHash: txHash, asset: arrival.asset, decimals: arrival.decimals, units: arrival.units)
    }
}

/// Whatever holds a key that can publish a note. Only the hot wallet does: a cold wallet's notes need its device, and this app has no device code, so those go to the web app.
@MainActor
public protocol CostNoteWriter: AnyObject {
    func canWriteNote(from wallet: String) -> Bool
    /// Whether this is a savings wallet, whose device can publish it through the web app.
    func canWriteNoteOnDevice(from wallet: String) -> Bool
    /// True once it's on its way. False if it didn't go out, with `noteProblem` saying why, or nil if they changed their mind.
    /// Only ever from `wallet`, because a note counts for whoever sent it. A wallet that's changed since it was offered gets nothing signed.
    func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool
    var noteProblem: String? { get }
}

extension CostNoteWriter {
    public func canWriteNoteOnDevice(from wallet: String) -> Bool { false }
}
