import Foundation

extension HotWallet {
    /// Everything worth telling the user right now, worst first. The alarm has its own banner.
    public var notices: [Notice] {
        guard address != nil, availability == .ready else { return [] }
        var notices: [Notice] = []
        if isKeyMissing { notices.append(.init(.warning, HotWalletWording.keyMissing, short: HotWalletWording.shortKeyMissing)) }
        if hasUnsavedRecords { notices.append(.init(.warning, HotWalletWording.cantSaveRecordsYet, short: HotWalletWording.shortCantSaveRecords)) }
        if cameBackWithSomethingOnIt { notices.append(.init(.info, HotWalletWording.keyCameBack)) }
        switch rotationHold {
        case .otherTokens(let count): notices.append(.init(.warning, HotWalletWording.rotationHeldByOtherTokens(count), short: HotWalletWording.shortOldKeyHolds))
        case .cantCheckOtherTokens: notices.append(.init(.warning, HotWalletWording.rotationCantCheck, short: HotWalletWording.shortOldKeyUnchecked))
        case .notWorthTheGas(let symbols): notices.append(.init(.warning, HotWalletWording.rotationHeldByGas(symbols), short: HotWalletWording.shortOldKeyHolds))
        case .notEnoughGas, nil:
            if rotation != nil, !isKeyMissing { notices.append(.init(.info, HotWalletWording.rotating)) }
        }
        if let chainProblem { notices.append(.init(.warning, chainProblem == .rateLimited ? HotWalletWording.networkBusy : HotWalletWording.cantReachChain, short: chainProblem == .rateLimited ? HotWalletWording.shortNetworkBusy : HotWalletWording.shortCantReachChain)) }
        if let snapshot, snapshot.chainID != Base.chainID { notices.append(.init(.warning, HotWalletWording.wrongChain, short: HotWalletWording.shortWrongChain)) }
        if let lastActionProblem { notices.append(.init(.warning, lastActionProblem, short: HotWalletWording.shortLastActionFailed)) }
        if let plan {
            if plan.blockers.contains(.notEnoughGas) || rotationHold == .notEnoughGas { notices.append(.init(.warning, HotWalletWording.noGas, short: HotWalletWording.shortNoGas)) }
            if plan.excessUsdMicros > 0, !plan.excessIsDust || plan.blockers.contains(.noDestination) {
                notices.append(.init(.warning, HotWalletWording.overCap(by: plan.excessUsdMicros, hasDestination: settings.sweepDestination != nil, in: display), short: HotWalletWording.shortOverCap(by: plan.excessUsdMicros, in: display), asksForSavings: settings.sweepDestination == nil))
            } else if plan.excessIsDust {
                notices.append(.init(.info, HotWalletWording.excessIsDust))
            }
        }
        if snapshot != nil, snapshot?.ethUsdMicros == nil { notices.append(.init(.warning, HotWalletWording.noEthPrice, short: HotWalletWording.shortNoEthPrice)) }
        if !unpricedSymbols.isEmpty { notices.append(.init(.warning, HotWalletWording.noPrice(unpricedSymbols), short: HotWalletWording.shortNoPrice(unpricedSymbols))) }
        // Being over the cap with nowhere to sweep already says to add one.
        if settings.coldWallets.isEmpty, plan?.excessUsdMicros ?? 0 == 0 { notices.append(.init(.warning, HotWalletWording.addSavings(in: display), short: HotWalletWording.shortNoSavings, asksForSavings: true)) }
        if ampProblem { notices.append(.init(.info, HotWalletWording.cantCheckAmp)) }
        return notices
    }

    /// Whether something needs the user, for places with room for only a triangle.
    public var needsAttention: Bool {
        alarm != nil || notices.contains { $0.kind == .warning }
    }

    public struct Notice: Equatable, Identifiable, Sendable {
        public enum Kind: Sendable {
            case info, warning
        }

        public let kind: Kind
        public let text: String
        /// A warning in a few words, for places with room for only that.
        public let short: String?
        /// Adding a savings wallet is what answers this one.
        public let asksForSavings: Bool
        public var id: String { text }

        init(_ kind: Kind, _ text: String, short: String? = nil, asksForSavings: Bool = false) {
            self.kind = kind
            self.text = text
            self.short = short
            self.asksForSavings = asksForSavings
        }
    }
}
