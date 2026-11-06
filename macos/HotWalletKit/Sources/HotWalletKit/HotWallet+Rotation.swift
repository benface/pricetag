import Foundation
import KeyVault
import PricetagKit

extension HotWallet {
    public enum RotationHold: Equatable, Sendable {
        case notEnoughGas
        /// Tokens that gas makes too costly to move right now. They move if that changes, and until then they're
        /// still the user's, so only the user can say to leave them.
        case notWorthTheGas([String])
        /// Tokens off the allowlist, which this app never calls, so they can't be moved from here.
        case otherTokens(Int)
        /// Amp is the only way to see those tokens, and it isn't answering.
        case cantCheckOtherTokens
    }

    /// What a rotation does after a look at the chain. This only decides: moving money and deleting the key are in `HotWallet.swift`, the only file that can reach the signer.
    enum RotationStep {
        case move(SweepPlan)
        case wait
        /// The old key is empty and has stayed that way, so it can go.
        case finish
    }

    func nextStep(in rotation: Rotation, snapshot: ChainSnapshot) -> RotationStep {
        let everything = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: rotation.destination)
        guard everything.transfers.isEmpty else {
            resetEmptyReads()
            rotationHold = everything.blockers.contains(.notEnoughGas) ? .notEnoughGas : everything.notWorthTheGas.isEmpty ? nil : .notWorthTheGas(everything.notWorthTheGas.map(\.symbol))
            return .move(everything)
        }
        guard !everything.blockers.contains(.notEnoughGas) else {
            resetEmptyReads()
            rotationHold = .notEnoughGas
            return .wait
        }
        guard everything.notWorthTheGas.isEmpty else {
            resetEmptyReads()
            rotationHold = .notWorthTheGas(everything.notWorthTheGas.map(\.symbol))
            return .wait
        }
        let emptySince = rotationEmptySince ?? (snapshot.blockNumber, now())
        rotationEmptySince = emptySince
        guard let tokens = otherTokens(on: rotation.from, emptySinceBlock: emptySince.block, snapshot: snapshot) else {
            // A normal rotation waits here for the next read of its history, so that's not worth a warning until it's been a while.
            emptyReads = 0
            rotationHold = ampProblem || now().timeIntervalSince(emptySince.date) > Self.historyGrace ? .cantCheckOtherTokens : nil
            return .wait
        }
        guard tokens == 0 else {
            emptyReads = 0
            rotationHold = .otherTokens(tokens)
            return .wait
        }
        rotationHold = nil
        // Deleting a key can't be undone, so one read saying it's empty isn't enough.
        emptyReads += 1
        return emptyReads >= Self.readsBeforeAlarm ? .finish : .wait
    }

    /// How many tokens off the allowlist this key holds, or nil when there's no answer that can be trusted to delete a key on.
    /// This app can't see them itself, so it has to be from history that reaches the block where the key first read as empty,
    /// and that's close to now. What a history read says stops being true as new blocks go by.
    private func otherTokens(on address: EthereumAddress, emptySinceBlock: UInt64, snapshot: ChainSnapshot) -> Int? {
        guard !ampProblem, let portfolio, portfolio.address == address.lowercased, portfolio.progress.started else { return nil }
        let reached = UInt64(max(portfolio.coverage.toBlock, 0))
        guard reached >= emptySinceBlock, reached >= BlockTime.blockBefore(Int(snapshot.blockNumber), ms: Self.historyFreshnessMs) else { return nil }
        return portfolio.unlisted.count
    }

    func resetEmptyReads() {
        emptyReads = 0
        rotationEmptySince = nil
    }

    /// Whether a rotation is waiting on the user. Without the old key it can't move anything, so that always is.
    public var canLeaveOldKeyBehind: Bool { rotation != nil && (rotationHold != nil || isKeyMissing) }
}
