import Foundation
import KeyVault
import PricetagKit

/// What happens to a one-use key after a look at the chain. This only decides: moving money and deleting the key are in `HotWallet.swift`,
/// the only file that can reach the signer.
extension HotWallet {
    public enum OneUseHold: Equatable, Sendable {
        /// Nothing's arrived yet.
        case waitingForPurchase
        /// What arrived is on its way to savings.
        case moving
        /// A token arrived without ETH beside it, and Spending Money can't send the fee right now.
        case needsGas
        /// Tokens that gas makes too costly to move right now. They move if that changes.
        case notWorthTheGas([String])
        /// Tokens off the allowlist, which this app never calls, so they can't be moved from here.
        case otherTokens(Int)
        /// Amp is the only way to see those tokens, and it isn't answering.
        case cantCheckOtherTokens
        /// The vault doesn't have it anymore, so nothing on it can move from here.
        case keyMissing
    }

    enum OneUseStep: Equatable {
        case move(SweepPlan)
        /// This much ETH from Spending Money, so what arrived can pay for its own move.
        case sendGas(UInt128)
        case wait
        /// It's been emptied, has stayed that way, and history shows nothing else on it.
        case finish
    }

    /// What a one-use key needs to finish, besides what's in `OneUseKey`. None of it's worth writing down: after a restart it's all read again.
    struct OneUseReads {
        var emptyReads = 0
        var emptySince: (block: UInt64, date: Date)?
        var nonceAheadTicks = 0
        var pausedUntil: Date?
        /// Its own history, read only once it's empty, to look for tokens off the allowlist and for anything it didn't sign.
        var portfolio: Portfolio?
        var ampProblem = false
    }

    /// Above this, a purchase goes to a one-use key, and all of it on to savings. Anything that wouldn't fit in Spending Money.
    public func buysThroughOneUseKey(usdMicros: UInt128) -> Bool {
        settings.sweepDestination != nil && usdMicros > topUpRoom
    }

    /// Where a one-use key's money goes: savings as they are now, or as they were when it was made if there are none anymore.
    func destination(of key: OneUseKey) -> EthereumAddress {
        settings.sweepDestination ?? key.destination
    }

    /// Every allowlisted token on a key, priced as Spending Money's are.
    func holdings(in snapshot: ChainSnapshot) -> [Holding] {
        Base.tokens.compactMap { token in
            let balance = snapshot.balances[token] ?? 0
            guard balance > 0 || token.isNative else { return nil }
            return Holding(token: token, balance: balance, priceUsdMicros: price(of: token, snapshot: snapshot))
        }
    }

    /// How long a key nothing ever arrived at is kept. A provider can deliver long after its page closed, so this is generous.
    static let unusedOneUseKeyLifetime: TimeInterval = 14 * 24 * 60 * 60
    /// How many times Spending Money pays a fee for one key. A purchase needs one, and a fee that rises in between a second.
    static let gasSendsPerKey = 3

    func nextStep(for key: OneUseKey, snapshot: ChainSnapshot) -> OneUseStep {
        let address = key.address
        let everything = SweepPlanner.everything(holdings: holdings(in: snapshot), fees: snapshot.fees, destination: destination(of: key))
        guard everything.transfers.isEmpty else {
            resetOneUseEmptyReads(address)
            oneUseHolds[address] = .moving
            return .move(everything)
        }
        if everything.blockers.contains(.notEnoughGas) {
            resetOneUseEmptyReads(address)
            if let wei = gasToSend(for: key, snapshot: snapshot) {
                oneUseHolds[address] = .moving
                return .sendGas(wei)
            }
            oneUseHolds[address] = .needsGas
            return .wait
        }
        guard everything.notWorthTheGas.isEmpty else {
            resetOneUseEmptyReads(address)
            oneUseHolds[address] = .notWorthTheGas(everything.notWorthTheGas.map(\.symbol))
            return .wait
        }
        // Nothing's arrived, and nothing's gone. A provider can still deliver, so it waits, up to a point.
        if snapshot.nonce == 0, now().timeIntervalSince(key.createdAt) < Self.unusedOneUseKeyLifetime {
            resetOneUseEmptyReads(address)
            oneUseHolds[address] = .waitingForPurchase
            return .wait
        }
        var reads = oneUseReads[address] ?? OneUseReads()
        let emptySince = reads.emptySince ?? (snapshot.blockNumber, now())
        reads.emptySince = emptySince
        oneUseReads[address] = reads
        guard let tokens = otherTokens(onOneUseKey: address, reads: reads, emptySinceBlock: emptySince.block, snapshot: snapshot) else {
            oneUseReads[address]?.emptyReads = 0
            oneUseHolds[address] = reads.ampProblem || now().timeIntervalSince(emptySince.date) > Self.historyGrace ? .cantCheckOtherTokens : .moving
            return .wait
        }
        guard tokens == 0 else {
            oneUseReads[address]?.emptyReads = 0
            oneUseHolds[address] = .otherTokens(tokens)
            return .wait
        }
        oneUseHolds[address] = .moving
        // Deleting a key can't be undone, so one read saying it's empty isn't enough.
        oneUseReads[address]?.emptyReads += 1
        return (oneUseReads[address]?.emptyReads ?? 0) >= Self.readsBeforeAlarm ? .finish : .wait
    }

    /// Enough ETH for every token on it to move, twice over, since what a fee will be is only an estimate. What's left after is under
    /// what `SweepPlanner` counts, so the key still reads as empty. Nil when it's had all it gets.
    private func gasToSend(for key: OneUseKey, snapshot: ChainSnapshot) -> UInt128? {
        guard key.gasSends < Self.gasSendsPerKey else { return nil }
        let needed = holdings(in: snapshot).filter { !$0.token.isNative && $0.balance > 0 }.reduce(UInt128(0)) { $0 + snapshot.fees.costWei(of: $1.token) }
        let wanted = (2 * needed).subtractingClamped(snapshot.balances[Base.eth] ?? 0)
        return wanted > 0 ? wanted : nil
    }

    /// Like a rotation's check for an old key, from this key's own history, which has to reach the block where it first read as empty, and be recent.
    private func otherTokens(onOneUseKey address: EthereumAddress, reads: OneUseReads, emptySinceBlock: UInt64, snapshot: ChainSnapshot) -> Int? {
        guard !reads.ampProblem, let portfolio = reads.portfolio, portfolio.address == address.lowercased, portfolio.progress.started else { return nil }
        let reached = UInt64(max(portfolio.coverage.toBlock, 0))
        guard reached >= emptySinceBlock, reached >= BlockTime.blockBefore(Int(snapshot.blockNumber), ms: Self.historyFreshnessMs) else { return nil }
        return portfolio.unlisted.count
    }

    func resetOneUseEmptyReads(_ address: EthereumAddress) {
        oneUseReads[address]?.emptyReads = 0
        oneUseReads[address]?.emptySince = nil
    }

    /// Whether this key's history is worth reading: only once it's empty and waiting to be retired.
    func wantsHistory(_ address: EthereumAddress) -> Bool {
        oneUseReads[address]?.emptySince != nil
    }

    /// Reads one-use keys' history from Amp, only for those about to be retired. Anything it shows that this app didn't sign raises the alarm.
    public func readOneUseHistory() async {
        for key in oneUseKeys where wantsHistory(key.address) {
            do {
                let portfolio = try await portfolioSource().portfolio(ReadContext(address: key.address.lowercased, method: costMethod(), currency: .USD, rule: nil, linked: [], book: Book()), timeout: .seconds(180))
                guard !Task.isCancelled, oneUseKeys.contains(where: { $0.address == key.address }) else { continue }
                oneUseReads[key.address, default: OneUseReads()].portfolio = portfolio
                oneUseReads[key.address]?.ampProblem = false
                if portfolio.progress.started, !AlarmCheck.findings(outgoingTxs: portfolio.outgoingTxs, records: state.records[key.address] ?? []).isEmpty {
                    raiseForOneUseKey(key.address)
                }
            } catch is CancellationError {
                return
            } catch {
                oneUseReads[key.address, default: OneUseReads()].ampProblem = true
            }
        }
    }

    /// One-use keys still in use, and every one there's been, for finding their purchases.
    public var oneUseKeys: [OneUseKey] { state.oneUseKeys ?? [] }
    public var purchaseKeys: [EthereumAddress] { state.purchaseKeys ?? [] }

    /// What needs the user about one-use keys. The rest of the time they're on their way, and the purchase's row says so.
    public var oneUseNotices: [Notice] {
        var notices: [Notice] = []
        for key in oneUseKeys {
            switch oneUseHolds[key.address] {
            case .needsGas: notices.append(.init(.warning, HotWalletWording.purchaseNeedsGas, short: HotWalletWording.shortPurchaseHeld))
            case .notWorthTheGas(let symbols): notices.append(.init(.warning, HotWalletWording.purchaseHeldByGas(symbols), short: HotWalletWording.shortPurchaseHeld))
            case .otherTokens(let count): notices.append(.init(.warning, HotWalletWording.purchaseKeyHoldsOtherTokens(count), short: HotWalletWording.shortPurchaseHeld))
            case .cantCheckOtherTokens: notices.append(.init(.info, HotWalletWording.purchaseKeyCantCheck))
            case .keyMissing: notices.append(.init(.warning, HotWalletWording.purchaseKeyMissing, short: HotWalletWording.shortPurchaseHeld))
            case .waitingForPurchase, .moving, nil: break
            }
        }
        // Two purchases held the same way say it once.
        var seen = Set<String>()
        return notices.filter { seen.insert($0.text).inserted }
    }
}
