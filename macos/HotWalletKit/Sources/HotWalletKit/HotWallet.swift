import Foundation
import KeyVault
import LocalAuthentication
import Observation
import PricetagKit

/// The hot wallet, kept to its rules for as long as the app runs: reads the chain, sweeps what's above the cap to savings, and
/// compares what happened onchain with what it signed. The vault does the signing, and this never sees a key.
@MainActor
@Observable
public final class HotWallet {
    public enum Availability: Equatable {
        case ready
        /// Watch-only still works, but this build can't hold a key. See `macos/run.sh`.
        case notProvisioned
        case unavailable(String)
    }

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

    public private(set) var availability: Availability = .ready
    public private(set) var settings: WalletSettings
    public private(set) var state: DeviceWalletState
    public private(set) var snapshot: ChainSnapshot?
    public private(set) var portfolio: Portfolio?
    public private(set) var plan: SweepPlan?
    public private(set) var isKeyMissing = false
    public private(set) var chainProblem: ChainError?
    public private(set) var ampProblem = false
    /// Why the last sweep didn't go out. Automatic sweeps wait a while before trying again.
    public private(set) var sweepProblem: String?
    public private(set) var isWorking = false
    /// What's keeping a rotation from deleting the old key. The user can still choose to leave it behind.
    public private(set) var rotationHold: RotationHold?
    public var onLinkedWalletsChange: (([String]) -> Void)?
    /// A key is gone, and this one took over from it, if any did. A rotation can finish with nothing open, so this isn't left to a view.
    public var onKeyRetired: ((EthereumAddress, EthereumAddress?) -> Void)?

    public var address: EthereumAddress? { state.active }
    public var alarm: StolenKeyAlarm? { state.alarm }
    public var rotation: Rotation? { state.rotation }
    public var records: [SignedRecord] { address.flatMap { state.records[$0] }?.reversed() ?? [] }
    public var unlisted: [UnlistedToken] { portfolio?.unlisted ?? [] }

    @ObservationIgnored private let signer: any Signer
    @ObservationIgnored private let settingsStore: any WalletSettingsStore
    @ObservationIgnored private let stateStore: any DeviceStateStore
    @ObservationIgnored private let presence: any UserPresence
    @ObservationIgnored private var lastAnswerAt: Date?
    @ObservationIgnored private let portfolioSource: @MainActor () -> any PortfolioSource
    @ObservationIgnored private let costMethod: @MainActor () -> CostMethod
    @ObservationIgnored private let mainCurrency: @MainActor () -> CurrencyCode
    @ObservationIgnored private let makeChain: @Sendable (URL) -> any ChainClient
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private let tickDelay: Duration
    @ObservationIgnored private let readDelay: Duration
    @ObservationIgnored private let readRetryDelay: Duration
    @ObservationIgnored private let receiptDelay: Duration
    @ObservationIgnored private var chain: any ChainClient
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var receiptTask: Task<Void, Never>?
    @ObservationIgnored private var missedReceipts: [String: Int] = [:]
    @ObservationIgnored private var nonceAheadTicks = 0
    @ObservationIgnored private var emptyReads = 0
    @ObservationIgnored private var catchUpReads = 0
    @ObservationIgnored private var pausedUntil: Date?
    @ObservationIgnored private var lastInLine: Task<Void, Never>?
    /// When the old key first read as empty in a rotation. History has to reach that block before it can say there's nothing else.
    @ObservationIgnored private var rotationEmptySince: (block: UInt64, date: Date)?

    /// How long a sweep that didn't work waits before trying again.
    static let pauseAfterFailure: TimeInterval = 300
    /// How long a transaction can go unseen before its nonce counts as free again.
    static let pendingTimeout: TimeInterval = 180
    /// History from further back than this says nothing about what the key holds now.
    static let historyFreshnessMs = 60_000
    /// How long a rotation can wait for current history before it says so. A first read can take this long.
    static let historyGrace: TimeInterval = 180
    /// Nodes behind a load balancer can disagree for a moment, so these have to hold for a few reads before they count.
    static let readsBeforeAlarm = 3
    static let patientReadRetries = 2
    /// A receipt can come back a second or so before a node's latest block includes it. A node further behind than this can wait for the next tick.
    static let readsToCatchUp = 5

    public init(
        signer: any Signer = KeyVault(),
        settingsStore: any WalletSettingsStore = UserDefaultsWalletSettingsStore(),
        stateStore: any DeviceStateStore = FileDeviceStateStore(),
        presence: any UserPresence = DeviceOwnerPresence(),
        portfolioSource: @escaping @MainActor () -> any PortfolioSource,
        costMethod: @escaping @MainActor () -> CostMethod = { .average },
        mainCurrency: @escaping @MainActor () -> CurrencyCode = { .USD },
        makeChain: @escaping @Sendable (URL) -> any ChainClient = { RPCChainClient(url: $0) },
        now: @escaping @Sendable () -> Date = { Date() },
        tickDelay: Duration = .seconds(15),
        readDelay: Duration = .seconds(20),
        readRetryDelay: Duration = .seconds(1),
        receiptDelay: Duration = .seconds(1)
    ) {
        self.signer = signer
        self.settingsStore = settingsStore
        self.stateStore = stateStore
        self.presence = presence
        self.portfolioSource = portfolioSource
        self.costMethod = costMethod
        self.mainCurrency = mainCurrency
        self.makeChain = makeChain
        self.now = now
        self.tickDelay = tickDelay
        self.readDelay = readDelay
        self.readRetryDelay = readRetryDelay
        self.receiptDelay = receiptDelay
        let settings = settingsStore.load()
        self.settings = settings
        self.chain = makeChain(settings.rpcURL)
        do {
            state = try stateStore.load()
        } catch {
            // Starting empty would forget what was signed, and call all of it stolen.
            state = DeviceWalletState()
            availability = .unavailable("Couldn't read this wallet's records: \(error.localizedDescription)")
        }
    }

    // MARK: - Running

    public func start() {
        guard availability == .ready else { return }
        publishLinkedWallets()
        tickTask?.cancel()
        readTask?.cancel()
        receiptTask?.cancel()
        tickTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.tick()
                guard let delay = self?.tickDelay else { return }
                try? await Task.sleep(for: delay)
            }
        }
        readTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.readHistory()
                guard let delay = self?.readDelay else { return }
                try? await Task.sleep(for: delay)
            }
        }
        receiptTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let delay = self?.receiptDelay, (try? await Task.sleep(for: delay)) != nil else { return }
                await self?.lookBetweenTicks()
            }
        }
    }

    public func stop() {
        tickTask?.cancel()
        readTask?.cancel()
        receiptTask?.cancel()
    }

    /// Runs after everything that's already waiting. Whatever signs goes through here, because two at once would use the same nonce.
    private func inTurn(_ body: @escaping @MainActor () async -> Void) async {
        let previous = lastInLine
        let task = Task {
            await previous?.value
            await body()
        }
        lastInLine = task
        await task.value
    }

    /// One look at the chain, and whatever follows from it.
    public func tick() async {
        await inTurn { [self] in await lookAtChain() }
    }

    private func lookAtChain() async {
        guard availability == .ready, let address else {
            await reconcileKeys()
            return
        }
        do {
            let snapshot = try await chain.snapshot(of: address)
            guard address == self.address else { return }
            self.snapshot = snapshot
            chainProblem = nil
            guard snapshot.chainID == Base.chainID else { return }
            isKeyMissing = try await !signer.hasKey(address)
            try await settlePending(address: address, snapshot: snapshot)
            checkNonce(address: address, snapshot: snapshot)
            refreshPlan(snapshot: snapshot, address: address)
            guard snapshot.blockNumber >= state.settledThroughBlock ?? 0 else { return }
            try await act(address: address, snapshot: snapshot)
        } catch is CancellationError {
        } catch let error as ChainError {
            chainProblem = error
        } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
            availability = .notProvisioned
        } catch {
            sweepProblem = error.localizedDescription
        }
    }

    /// Whether there's a landing to look for. A tick that couldn't read the chain, or read the wrong one, has to clear that first.
    private var isWaitingToLand: Bool {
        guard availability == .ready, chainProblem == nil, let address, let snapshot, snapshot.chainID == Base.chainID else { return false }
        return catchUpReads > 0 && snapshot.blockNumber < state.settledThroughBlock ?? 0 || (state.records[address] ?? []).contains { $0.status == .pending }
    }

    /// Shows a transaction landing soon after it does, and reads nothing unless one is on its way. This only ever settles a receipt and
    /// updates what's shown. Signing, giving up on a transaction and the counts behind alarms and deleting a key all assume a tick's pace, so they wait for one.
    func lookBetweenTicks() async {
        guard isWaitingToLand else { return }
        await inTurn { [self] in
            guard isWaitingToLand, let address else { return }
            do {
                let records = state.records[address] ?? []
                for record in records where record.status == .pending {
                    // An earlier one in this loop landed with the same nonce, so this one can't.
                    guard state.records[address]?.first(where: { $0.hash == record.hash })?.status == .pending else { continue }
                    if let receipt = try await chain.receipt(of: record.hash) {
                        try settle(record, with: receipt, among: records, address: address)
                    }
                }
                guard catchUpReads > 0, let snapshot, snapshot.blockNumber < state.settledThroughBlock ?? 0 else { return }
                catchUpReads -= 1
                let newer = try await chain.snapshot(of: address)
                self.snapshot = newer
                guard newer.chainID == Base.chainID else { return }
                refreshPlan(snapshot: newer, address: address)
            } catch is CancellationError {
            } catch is ChainError {
                // The next tick says so if it's more than a moment.
            } catch {
                sweepProblem = error.localizedDescription
            }
        }
    }

    /// One read of this wallet's history from Amp, through the server.
    public func readHistory() async {
        guard let address else { return }
        let linked = linkedWallets.filter { $0 != address.lowercased }
        do {
            // Always USD, like the cap and the balances it's compared with. No answers: what someone said about a cost shouldn't move money by itself. `pendingGain` keeps estimates out too.
            // Always by the default pricing rule. A rule picked to compare numbers must never decide what money moves.
            let portfolio = try await portfolioSource().portfolio(address: address.lowercased, method: costMethod(), currency: .USD, rule: nil, linked: linked, book: Book(), timeout: .seconds(180))
            guard !Task.isCancelled, address == self.address else { return }
            self.portfolio = portfolio
            ampProblem = false
            let findings = AlarmCheck.findings(outgoingTxs: portfolio.outgoingTxs, records: state.records[address] ?? [])
            if !findings.isEmpty { raise(findings, address: address) }
            if let snapshot { refreshPlan(snapshot: snapshot, address: address) }
        } catch is CancellationError {
        } catch {
            guard address == self.address else { return }
            ampProblem = true
        }
    }

    private func reconcileKeys() async {
        guard availability == .ready else { return }
        do {
            // The records were lost but the key wasn't: there's still only one hot wallet per device.
            if let existing = try await signer.addresses().first {
                state.active = existing
                try persist()
                publishLinkedWallets()
            }
        } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
            availability = .notProvisioned
        } catch {}
    }

    private func refreshPlan(snapshot: ChainSnapshot, address: EthereumAddress) {
        plan = SweepPlanner.automatic(
            holdings: holdings,
            capUsdMicros: settings.capUsdMicros,
            fees: snapshot.fees,
            destination: settings.sweepDestination,
            pendingGainUsdMicros: settings.sweepsRealizedGains ? pendingGain(address: address) : 0
        )
    }

    private func act(address: EthereumAddress, snapshot: ChainSnapshot) async throws {
        if (state.records[address] ?? []).contains(where: { $0.status == .pending }) { return }
        if let rotation = state.rotation, rotation.from == address {
            let everything = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: rotation.destination)
            guard everything.transfers.isEmpty else {
                resetEmptyReads()
                rotationHold = everything.blockers.contains(.notEnoughGas) ? .notEnoughGas : everything.notWorthTheGas.isEmpty ? nil : .notWorthTheGas(everything.notWorthTheGas.map(\.symbol))
                try await execute(everything, from: address, to: rotation.destination, reason: .rotation, snapshot: snapshot)
                return
            }
            guard !everything.blockers.contains(.notEnoughGas) else {
                resetEmptyReads()
                rotationHold = .notEnoughGas
                return
            }
            guard everything.notWorthTheGas.isEmpty else {
                resetEmptyReads()
                rotationHold = .notWorthTheGas(everything.notWorthTheGas.map(\.symbol))
                return
            }
            let emptySince = rotationEmptySince ?? (snapshot.blockNumber, now())
            rotationEmptySince = emptySince
            guard let tokens = otherTokens(on: address, emptySinceBlock: emptySince.block, snapshot: snapshot) else {
                // A normal rotation waits here for the next read of its history, so that's not worth a warning until it's been a while.
                emptyReads = 0
                rotationHold = ampProblem || now().timeIntervalSince(emptySince.date) > Self.historyGrace ? .cantCheckOtherTokens : nil
                return
            }
            guard tokens == 0 else {
                emptyReads = 0
                rotationHold = .otherTokens(tokens)
                return
            }
            rotationHold = nil
            // Deleting a key can't be undone, so one read saying it's empty isn't enough.
            emptyReads += 1
            if emptyReads >= Self.readsBeforeAlarm { try await finishRotation(rotation) }
            return
        }
        if let pausedUntil, now() < pausedUntil { return }
        guard !isKeyMissing, let plan, !plan.transfers.isEmpty, let destination = settings.sweepDestination else { return }
        try await execute(plan, from: address, to: destination, reason: .aboveCap, snapshot: snapshot)
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

    private func resetEmptyReads() {
        emptyReads = 0
        rotationEmptySince = nil
    }

    // MARK: - What's here

    /// Every allowlisted token held, with a price only when there's a trusted one. ETH always appears, because it pays for everything.
    public var holdings: [Holding] {
        guard let snapshot else { return [] }
        return Base.tokens.compactMap { token in
            let balance = snapshot.balances[token] ?? 0
            guard balance > 0 || token.isNative else { return nil }
            return Holding(token: token, balance: balance, priceUsdMicros: price(of: token, snapshot: snapshot))
        }
    }

    private func price(of token: Token, snapshot: ChainSnapshot) -> UInt128? {
        switch token.asset {
        case "ETH": return snapshot.ethUsdMicros
        case "USDC": return snapshot.usdcUsdMicros
        default: return snapshot.otherUsdMicros[token.asset]
        }
    }

    /// What Top Up can add without going over the cap.
    public var topUpRoom: UInt128 {
        settings.capUsdMicros.subtractingClamped(plan?.valueUsdMicros ?? 0)
    }

    public var canTopUp: Bool { alarm == nil && rotation == nil && address != nil && !isKeyMissing }

    /// Whether the person using this can have it sign something. A key that may be stolen, or that's being replaced, only moves to safety.
    public var canSend: Bool { availability == .ready && canTopUp }

    /// Holdings it can't value, which the cap can't see.
    public var unpricedSymbols: [String] {
        holdings.filter { $0.priceUsdMicros == nil && !$0.token.isNative }.map(\.token.symbol)
    }

    public var linkedWallets: [String] {
        var wallets: [String] = []
        if let address { wallets.append(address.lowercased) }
        if let rotation { wallets.append(rotation.to.lowercased) }
        wallets += state.retired.map(\.lowercased)
        wallets += settings.coldWallets.map(\.address.lowercased)
        wallets += settings.deviceAccounts.map(\.lowercased)
        return wallets
    }

    private func publishLinkedWallets() {
        onLinkedWalletsChange?(linkedWallets)
    }

    /// Only a gain that's all there and all fact gets swept by itself: never one that rests on an estimate, or on a wallet that couldn't be read.
    private func pendingGain(address: EthereumAddress) -> UInt128 {
        guard let portfolio, portfolio.linkedReading.isEmpty, portfolio.linkedFailed.isEmpty else { return 0 }
        let totals = portfolio.totals
        guard totals.coverage.realized.missing == 0, !totals.estimated.realized, let text = totals.realizedMicros, let realized = UInt128(text) else { return 0 }
        return realized.subtractingClamped(state.sweptGains[address].flatMap { UInt128($0) } ?? 0)
    }

    /// Everything worth telling the user right now, worst first. The alarm has its own banner.
    public var notices: [Notice] {
        guard address != nil, availability == .ready else { return [] }
        var notices: [Notice] = []
        if isKeyMissing { notices.append(.init(.warning, HotWalletWording.keyMissing, short: HotWalletWording.shortKeyMissing)) }
        switch rotationHold {
        case .otherTokens(let count): notices.append(.init(.warning, HotWalletWording.rotationHeldByOtherTokens(count), short: HotWalletWording.shortOldKeyHolds))
        case .cantCheckOtherTokens: notices.append(.init(.warning, HotWalletWording.rotationCantCheck, short: HotWalletWording.shortOldKeyUnchecked))
        case .notWorthTheGas(let symbols): notices.append(.init(.warning, HotWalletWording.rotationHeldByGas(symbols), short: HotWalletWording.shortOldKeyHolds))
        case .notEnoughGas, nil:
            if rotation != nil { notices.append(.init(.info, HotWalletWording.rotating)) }
        }
        if let chainProblem { notices.append(.init(.warning, chainProblem == .rateLimited ? HotWalletWording.networkBusy : HotWalletWording.cantReachChain, short: chainProblem == .rateLimited ? HotWalletWording.shortNetworkBusy : HotWalletWording.shortCantReachChain)) }
        if let snapshot, snapshot.chainID != Base.chainID { notices.append(.init(.warning, HotWalletWording.wrongChain, short: HotWalletWording.shortWrongChain)) }
        if let sweepProblem { notices.append(.init(.warning, sweepProblem, short: HotWalletWording.shortLastActionFailed)) }
        if let plan {
            if plan.blockers.contains(.notEnoughGas) || rotationHold == .notEnoughGas { notices.append(.init(.warning, HotWalletWording.noGas, short: HotWalletWording.shortNoGas)) }
            if plan.excessUsdMicros > 0, !plan.excessIsDust || plan.blockers.contains(.noDestination) {
                notices.append(.init(.warning, HotWalletWording.overCap(by: plan.excessUsdMicros, hasDestination: settings.sweepDestination != nil, beside: mainCurrency()), short: HotWalletWording.shortOverCap(by: plan.excessUsdMicros, beside: mainCurrency())))
            } else if plan.excessIsDust {
                notices.append(.init(.info, HotWalletWording.excessIsDust))
            }
        }
        if snapshot != nil, snapshot?.ethUsdMicros == nil { notices.append(.init(.warning, HotWalletWording.noEthPrice, short: HotWalletWording.shortNoEthPrice)) }
        if !unpricedSymbols.isEmpty { notices.append(.init(.warning, HotWalletWording.noPrice(unpricedSymbols), short: HotWalletWording.shortNoPrice(unpricedSymbols))) }
        // Being over the cap with nowhere to sweep already says to add one.
        if settings.coldWallets.isEmpty, plan?.excessUsdMicros ?? 0 == 0 { notices.append(.init(.warning, HotWalletWording.addSavings(beside: mainCurrency()), short: HotWalletWording.shortNoSavings)) }
        if ampProblem { notices.append(.init(.info, HotWalletWording.cantCheckAmp)) }
        return notices
    }

    /// An amount of this wallet's, as the user should read it. See `HotWalletWording.usd`.
    public func usd(_ micros: UInt128) -> String {
        HotWalletWording.usd(micros, beside: mainCurrency())
    }

    public func usd(dollars: Int) -> String {
        HotWalletWording.usd(dollars: dollars, beside: mainCurrency())
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
        public var id: String { text }

        init(_ kind: Kind, _ text: String, short: String? = nil) {
            self.kind = kind
            self.text = text
            self.short = short
        }
    }

    // MARK: - Settings

    public func setCap(dollars: Int) {
        updateSettings { $0.setCap(dollars: dollars) }
    }

    public func setSweepsRealizedGains(_ value: Bool) {
        updateSettings { $0.sweepsRealizedGains = value }
    }

    public func setSweepDestination(_ address: EthereumAddress) {
        updateSettings { $0.setSweepDestination(address) }
    }

    public func setRPC(_ url: URL) {
        guard url != settings.rpcURL else { return }
        updateSettings { $0.rpcURL = url }
        chain = makeChain(url)
        snapshot = nil
        plan = nil
        Task { await tick() }
    }

    public enum ColdWalletProblem: Error, Equatable {
        case notAnAddress, isThisHotWallet, isARetiredKey, isZero
    }

    /// The address has to be what the user read on the device's screen. Nothing here can check that, so the sheet makes them say so.
    public func addColdWallet(address text: String, name: String) throws(ColdWalletProblem) {
        guard let address = EthereumAddress(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw .notAnAddress }
        guard address != .zero else { throw .isZero }
        guard address != self.address else { throw .isThisHotWallet }
        guard !state.retired.contains(address) else { throw .isARetiredKey }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        updateSettings { $0.add(ColdWallet(address: address, name: cleanName.isEmpty ? "Savings" : cleanName, confirmedOnDeviceAt: now())) }
    }

    /// Other accounts on a device, which go in the book as the user's from here on. This can't tell whose they are, so the caller has to have asked. They only link costs.
    public func linkDeviceAccounts(_ addresses: [String]) {
        let accounts = addresses.compactMap(EthereumAddress.init).filter { $0 != .zero && $0 != address && !state.retired.contains($0) }
        guard !accounts.isEmpty else { return }
        updateSettings { $0.addDeviceAccounts(accounts) }
    }

    public func removeColdWallet(_ address: EthereumAddress) {
        updateSettings { $0.removeColdWallet(address) }
    }

    private func updateSettings(_ change: (inout WalletSettings) -> Void) {
        change(&settings)
        settingsStore.save(settings)
        publishLinkedWallets()
        if let snapshot, let address { refreshPlan(snapshot: snapshot, address: address) }
    }

    // MARK: - Actions

    /// Makes this device's one hot wallet. `SecRandomCopyBytes` makes the key, inside the vault.
    public func createWallet() async {
        guard address == nil else { return }
        await work { [self] in
            let address = try await signer.createKey()
            state.active = address
            try persist()
            publishLinkedWallets()
            start()
        }
    }

    /// Everything on the allowlist, to the chosen savings wallet, after asking the person at the device.
    /// What sweeping everything would move right now, for showing. It's worked out again from a fresh read before anything's signed.
    public var sweepPreview: SweepPreview? {
        guard let snapshot, let destination = settings.sweepDestination else { return nil }
        let transfers = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: destination).transfers
        let feeWei = transfers.reduce(UInt128(0)) { $0 + snapshot.fees.costWei(of: $1.token) }
        return SweepPreview(transfers: transfers, feeWei: feeWei, feeUsdMicros: snapshot.ethUsdMicros.map { Money.usdMicros(of: feeWei, priceMicros: $0, decimals: 18) })
    }

    /// True once it's on its way.
    @discardableResult
    public func sweepEverything(in prompt: PresencePrompt? = nil) async -> Bool {
        guard let address, let destination = settings.sweepDestination else { return false }
        var isOnItsWay = false
        let name = settings.coldWallets.first { $0.address == destination }?.name ?? "your savings"
        await work(confirming: "sweep everything to \(name)", in: prompt) { [self] in
            let snapshot = try await patientSnapshot(of: address)
            self.snapshot = snapshot
            guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
            guard snapshot.blockNumber >= state.settledThroughBlock ?? 0 else { throw ChainError.rejected("The last sweep is still showing up. Try again in a moment.") }
            guard !(state.records[address] ?? []).contains(where: { $0.status == .pending }) else { throw ChainError.rejected("A sweep is still on its way. Try again in a moment.") }
            let everything = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: destination)
            if everything.blockers.contains(.notEnoughGas), everything.transfers.isEmpty { throw ChainError.rejected(HotWalletWording.noGas) }
            pausedUntil = nil
            try await execute(everything, from: address, to: destination, reason: .manual, snapshot: snapshot)
            isOnItsWay = true
        }
        return isOnItsWay
    }

    /// A new key, with everything moved off the old one, which is deleted once it's empty. After an alarm, what's left goes
    /// to savings when there is one, because that's further from whoever has the old key.
    public func replaceKey() async {
        guard let address, rotation == nil else { return }
        await work(confirming: "replace this wallet's key") { [self] in
            let next = try await signer.createKey()
            let destination = alarm != nil ? settings.sweepDestination ?? next : next
            state.rotation = Rotation(from: address, to: next, destination: destination)
            try persist()
            publishLinkedWallets()
            Task { await tick() }
        }
    }

    /// Only when something can't be moved, like tokens with no ETH for gas or that gas makes too costly to move, and the user has said to leave it behind.
    public func finishRotationLeavingFundsBehind() async {
        guard let rotation else { return }
        await work(confirming: "delete the old key and leave what's on it behind") { [self] in
            try await finishRotation(rotation)
        }
    }

    private func finishRotation(_ rotation: Rotation) async throws {
        retire(rotation.from, activating: rotation.to)
        try persist()
        try await signer.deleteKey(rotation.from)
        publishLinkedWallets()
    }

    /// Deletes the key for good. What's still on it is lost, so the view offers a sweep first.
    public func deleteWallet() async {
        guard let address else { return }
        await work(confirming: "delete this wallet's key, which can't be undone") { [self] in
            try await signer.deleteKey(address)
            retire(address, activating: nil)
            try persist()
            publishLinkedWallets()
        }
    }

    private func retire(_ key: EthereumAddress, activating next: EthereumAddress?) {
        state.retired.append(key)
        state.active = next
        forgetTheOldKeysState()
        onKeyRetired?(key, next)
    }

    /// Everything that was about one key, whose alarms, dismissals, block numbers and reads say nothing about the next one.
    private func forgetTheOldKeysState() {
        state.connectedSites = nil
        state.rotation = nil
        state.alarm = nil
        state.acknowledged = []
        state.acknowledgedThroughNonce = nil
        state.settledThroughBlock = nil
        snapshot = nil
        plan = nil
        portfolio = nil
        rotationHold = nil
        sweepProblem = nil
        pausedUntil = nil
        nonceAheadTicks = 0
        catchUpReads = 0
        missedReceipts = [:]
        resetEmptyReads()
    }

    /// When the user knows better, say after restoring this device's records from an older copy.
    public func dismissAlarm() {
        guard let alarm else { return }
        state.acknowledged += alarm.findings
        for case .nonceAhead(_, let onchain) in alarm.findings {
            state.acknowledgedThroughNonce = max(state.acknowledgedThroughNonce ?? 0, onchain)
        }
        state.alarm = nil
        nonceAheadTicks = 0
        try? persist()
    }

    /// The prompt comes first and waits outside the line, so an open prompt doesn't hold up automatic sweeps.
    private func work(confirming reason: String? = nil, in prompt: PresencePrompt? = nil, _ body: @escaping @MainActor () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            sweepProblem = nil
            if let reason { try await confirmPresence(reason: reason, in: prompt) }
            var failure: (any Error)?
            await inTurn {
                do {
                    try await body()
                } catch {
                    failure = error
                }
            }
            if let failure { throw failure }
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            // They changed their mind, which isn't a problem to report.
        } catch is LAError {
            sweepProblem = HotWalletWording.touchIDDidNotConfirm
        } catch let error as ChainError {
            switch error {
            case .rejected(let message): sweepProblem = message
            case .rateLimited: sweepProblem = HotWalletWording.networkBusy
            case .unreachable, .unreadable: sweepProblem = HotWalletWording.cantReachChain
            }
        } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
            availability = .notProvisioned
        } catch {
            sweepProblem = error.localizedDescription
        }
    }

    // MARK: - Sites

    /// Why a site can't use this wallet right now, if it can't. Reads don't need any of this.
    public var siteProblem: SiteError? {
        guard availability == .ready else { return .stopped("This build of \(SiteWording.appName) can't hold a key.") }
        guard address != nil else { return .stopped("Set up \(HotWalletWording.title) in \(SiteWording.appName) first.") }
        if alarm != nil { return .stopped("\(SiteWording.appName) has stopped this wallet, because its key may be stolen.") }
        if rotation != nil { return .stopped("\(SiteWording.appName) is replacing this wallet's key. Try again once that's done.") }
        if isKeyMissing { return .stopped(HotWalletWording.keyMissing) }
        return nil
    }

    public var connectedSites: [String] { state.connectedSites ?? [] }

    func isConnected(_ origin: String) -> Bool {
        connectedSites.contains(origin)
    }

    func connectSite(_ origin: String) {
        guard !isConnected(origin) else { return }
        state.connectedSites = connectedSites + [origin]
        try? persist()
    }

    func disconnectSite(_ origin: String) {
        state.connectedSites?.removeAll { $0 == origin }
        try? persist()
    }

    func confirmPresence(reason: String, in prompt: PresencePrompt? = nil) async throws {
        if let prompt {
            try await presence.confirm(reason: reason, in: prompt)
            // They backed out as the touch landed. Backing out wins, because it's what's on screen.
            if prompt.isCancelled { throw LAError(.appCancel) }
            prompt.markConfirmed()
        } else {
            try await presence.confirm(reason: reason)
        }
        noteAnswer()
    }

    /// The user just answered something, so whatever's next waits a moment. A touch that's still on the sensor can't count for it.
    func noteAnswer() {
        lastAnswerAt = now()
    }

    /// Asking again before this could catch a second touch meant for what's just gone.
    public var nextPromptAt: Date? { lastAnswerAt?.addingTimeInterval(Self.pauseBetweenPrompts) }

    static let pauseBetweenPrompts: TimeInterval = 2

    func readForSite(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer {
        // A node on another chain would tell a site things that aren't true of Base.
        if let snapshot, snapshot.chainID != Base.chainID { return .failure(.wrongChain) }
        return try await chain.read(method, parameters)
    }

    /// What a transaction would cost. What's signed later keeps to this gas and fee per gas. Its L1 data fee goes by its real size,
    /// which a site's data can make far bigger than a sweep.
    func quoteForSite(_ transaction: SiteTransaction) async throws -> SiteQuote {
        guard let address else { throw ChainError.unreadable }
        let snapshot = try await patientSnapshot(of: address)
        guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
        guard snapshot.fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        let estimate: UInt64
        do {
            estimate = try await chain.estimateGas(from: address, to: transaction.to, value: transaction.value, data: transaction.data)
        } catch ChainError.rejected(let message) {
            // The node worked out what it would do, and it fails. Nothing good comes of signing that.
            throw ChainError.rejected(HotWalletWording.wouldFail + message)
        }
        // A plain send to a plain address uses exactly what it's quoted.
        let gasLimit = transaction.data.isEmpty && estimate == 21000 ? estimate : estimate + estimate / 4
        let unsigned = UnsignedTransaction(
            chainID: Base.chainID,
            nonce: snapshot.nonce,
            maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas,
            maxFeePerGas: snapshot.fees.maxFeePerGas,
            gasLimit: gasLimit,
            to: transaction.to,
            value: transaction.value,
            data: transaction.data
        )
        let l1Fee = try await chain.l1Fee(ofPayload: unsigned.signingPayload)
        let fees = FeeQuote(maxFeePerGas: snapshot.fees.maxFeePerGas, maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas, l1FeeWei: l1Fee)
        return SiteQuote(
            gasLimit: gasLimit,
            maxFeePerGas: snapshot.fees.maxFeePerGas,
            feeWei: fees.costWei(gas: UInt128(gasLimit)),
            ethUsdMicros: snapshot.ethUsdMicros,
            ethBalance: snapshot.balances[Base.eth] ?? 0,
            tokenUsdMicros: Base.tokens.first { $0.contract == transaction.to }.flatMap { price(of: $0, snapshot: snapshot) }
        )
    }

    /// Only after the user approved exactly this in the app. It's in line with sweeps, since two at once would use the same nonce.
    /// `isWanted` says the site hasn't gone away, which can happen at any point while this waits.
    func sendForSite(_ transaction: SiteTransaction, quote: SiteQuote, review: TransactionReview, origin: String, isWanted: @escaping @MainActor () -> Bool) async throws -> String {
        guard let address else { throw ChainError.unreadable }
        var result: Result<String, any Error> = .failure(ChainError.unreadable)
        await inTurn { [self] in
            do {
                result = .success(try await signAndSendForSite(transaction, from: address, quote: quote, review: review, origin: origin, isWanted: isWanted))
            } catch {
                result = .failure(error)
            }
        }
        return try result.get()
    }

    private func signAndSendForSite(_ transaction: SiteTransaction, from address: EthereumAddress, quote: SiteQuote, review: TransactionReview, origin: String, isWanted: @MainActor () -> Bool) async throws -> String {
        guard isWanted() else { throw CancellationError() }
        guard address == self.address, siteProblem == nil else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
        let snapshot = try await patientSnapshot(of: address)
        self.snapshot = snapshot
        guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
        guard snapshot.blockNumber >= state.settledThroughBlock ?? 0 else { throw ChainError.rejected(HotWalletWording.lastOneStillShowingUp) }
        guard snapshot.fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        // What was approved is a limit, so a rise doesn't change what's signed. It has room to land anyway, since a quote allows twice the
        // base fee. Only the base fee can stop it landing: the tip is whatever the node suggests just now, and it gets what's left.
        let baseFee = (snapshot.fees.maxFeePerGas - min(snapshot.fees.maxPriorityFeePerGas, snapshot.fees.maxFeePerGas)) / 2
        guard baseFee < quote.maxFeePerGas else { throw ChainError.rejected(HotWalletWording.feesRoseAfterApproval) }
        let maxFeePerGas = min(snapshot.fees.maxFeePerGas, quote.maxFeePerGas)
        let nonce = AlarmCheck.nextNonce(records: state.records[address] ?? [], onchainNonce: snapshot.nonce)
        let unsigned = UnsignedTransaction(
            chainID: Base.chainID,
            nonce: nonce,
            maxPriorityFeePerGas: min(snapshot.fees.maxPriorityFeePerGas, maxFeePerGas - min(baseFee, maxFeePerGas)),
            maxFeePerGas: maxFeePerGas,
            gasLimit: quote.gasLimit,
            to: transaction.to,
            value: transaction.value,
            data: transaction.data
        )
        // History is read outside the line, so an alarm can arrive during any wait, and that stops this as much as it would have before.
        guard isWanted() else { throw CancellationError() }
        guard siteProblem == nil else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
        let signed = try await signer.sign(unsigned, from: address)
        guard siteProblem == nil else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
        do {
            try await recordAndSend(signed, from: address, record: SignedRecord(
                hash: signed.hash, nonce: nonce, to: transaction.to, symbol: review.symbol, decimals: review.decimals,
                amount: review.amount, usdMicros: review.usdMicros, gainUsdMicros: "0",
                reason: .site, createdAt: now(), status: .pending, site: origin
            ))
        } catch ChainError.unreachable {
            // It may have got through, and the site can watch for its hash either way.
        }
        return signed.hash
    }

    /// Only after the user approved exactly this in the app. A message never spends by itself, but what it permits can.
    func signForSite(_ message: SignableMessage) async throws -> MessageSignature {
        guard let address else { throw ChainError.unreadable }
        return try await signer.sign(message, from: address)
    }

    // MARK: - Sending

    /// The most of a token that can be sent right now.
    public func maximumSend(of token: Token) -> UInt128 {
        snapshot.map { SendPlanner.maximum(of: token, snapshot: $0) } ?? 0
    }

    /// Why nothing can go to this address, if nothing can.
    public func problem(sendingTo recipient: EthereumAddress) -> SendProblem? {
        guard let address else { return nil }
        return SendPlanner.problem(sendingTo: recipient, from: address, retired: state.retired)
    }

    /// Asks the person at the device, then signs exactly this, and checks it again against a fresh read. True once it's on its way.
    @discardableResult
    public func send(_ request: SendRequest, in prompt: PresencePrompt? = nil) async -> Bool {
        guard let address, canSend else { return false }
        var isOnItsWay = false
        await work(confirming: "send \(Money.text(ofUnits: request.amount, decimals: request.token.decimals)) \(request.token.symbol) to \(request.to.checksummed)", in: prompt) { [self] in
            let snapshot = try await readToSign(address)
            if let problem = self.problem(sendingTo: request.to) ?? SendPlanner.problem(with: request, snapshot: snapshot) { throw ChainError.rejected(problem.message) }
            let price = self.price(of: request.token, snapshot: snapshot)
            try await signAndSend(
                to: request.token.contract ?? request.to,
                value: request.token.isNative ? request.amount : 0,
                data: request.token.isNative ? [] : Calldata.transfer(to: request.to, amount: request.amount),
                from: address,
                snapshot: snapshot
            ) { hash, nonce in
                SignedRecord(
                    hash: hash, nonce: nonce, to: request.to, symbol: request.token.symbol, decimals: request.token.decimals,
                    amount: String(request.amount), usdMicros: price.map { String(Money.usdMicros(of: request.amount, priceMicros: $0, decimals: request.token.decimals)) }, gainUsdMicros: "0",
                    reason: .sent, createdAt: now(), status: .pending
                )
            }
            isOnItsWay = true
        }
        return isOnItsWay
    }

    /// A transaction asked for by hand, with everything before it settled, because it's checked against what this read says.
    private func readToSign(_ address: EthereumAddress) async throws -> ChainSnapshot {
        try checkStillAllowed(address)
        let snapshot = try await patientSnapshot(of: address)
        self.snapshot = snapshot
        guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
        guard snapshot.fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        try await settlePending(address: address, snapshot: snapshot)
        try checkStillAllowed(address)
        guard snapshot.blockNumber >= state.settledThroughBlock ?? 0 else { throw ChainError.rejected(HotWalletWording.lastOneStillShowingUp) }
        guard !(state.records[address] ?? []).contains(where: { $0.status == .pending }) else { throw ChainError.rejected(HotWalletWording.lastOneOnItsWay) }
        return snapshot
    }

    /// For what someone is waiting on, usually having just approved it with Touch ID. Nothing's been signed, so a read that fails can be
    /// asked again, and failing the whole thing over one bad moment on the network would make them start over.
    private func patientSnapshot(of address: EthereumAddress) async throws -> ChainSnapshot {
        for _ in 0..<Self.patientReadRetries {
            do {
                return try await chain.snapshot(of: address)
            } catch let error as ChainError where error.isWorthRetrying {
                try await Task.sleep(for: readRetryDelay)
            }
        }
        return try await chain.snapshot(of: address)
    }

    private func checkStillAllowed(_ address: EthereumAddress) throws {
        guard address == self.address, canSend else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
    }

    private func signAndSend(to: EthereumAddress, value: UInt128, data: [UInt8], from address: EthereumAddress, snapshot: ChainSnapshot, record: (String, UInt64) -> SignedRecord) async throws {
        let estimate = try await chain.estimateGas(from: address, to: to, value: value, data: data)
        // A plain send to a plain address uses exactly what it's quoted.
        let gasLimit = data.isEmpty && estimate == 21000 ? estimate : estimate + estimate / 4
        guard snapshot.balances[Base.eth] ?? 0 >= value + snapshot.fees.costWei(gas: UInt128(gasLimit)) else { throw ChainError.rejected(HotWalletWording.noGasToSend) }
        // History is read outside the line, so an alarm can arrive during any wait, and that stops this as much as it would have before.
        try checkStillAllowed(address)
        let nonce = AlarmCheck.nextNonce(records: state.records[address] ?? [], onchainNonce: snapshot.nonce)
        let transaction = UnsignedTransaction(
            chainID: Base.chainID,
            nonce: nonce,
            maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas,
            maxFeePerGas: snapshot.fees.maxFeePerGas,
            gasLimit: gasLimit,
            to: to,
            value: value,
            data: data
        )
        let signed = try await signer.sign(transaction, from: address)
        try checkStillAllowed(address)
        do {
            try await recordAndSend(signed, from: address, record: record(signed.hash, nonce))
        } catch ChainError.unreachable {
            // It may have got through, so it counts as on its way, and the receipt check settles it.
        }
    }

    // MARK: - Signing

    private func execute(_ plan: SweepPlan, from address: EthereumAddress, to destination: EthereumAddress, reason: SignedRecord.Reason, snapshot: ChainSnapshot) async throws {
        guard snapshot.fees.isPlausible else {
            sweepProblem = HotWalletWording.feesLookWrong
            pausedUntil = now().addingTimeInterval(Self.pauseAfterFailure)
            return
        }
        var nonce = AlarmCheck.nextNonce(records: state.records[address] ?? [], onchainNonce: snapshot.nonce)
        for transfer in plan.transfers {
            let contract = transfer.token.contract ?? destination
            let value = transfer.token.isNative ? transfer.amount : 0
            let data = transfer.token.isNative ? [] : Calldata.transfer(to: destination, amount: transfer.amount)
            do {
                let estimate = try await chain.estimateGas(from: address, to: contract, value: value, data: data)
                let transaction = UnsignedTransaction(
                    chainID: Base.chainID,
                    nonce: nonce,
                    maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas,
                    maxFeePerGas: snapshot.fees.maxFeePerGas,
                    // A plain send to a plain address uses exactly what it's quoted.
                    gasLimit: transfer.token.isNative && estimate == 21000 ? estimate : estimate + estimate / 4,
                    to: contract,
                    value: value,
                    data: data
                )
                let signed = try await signer.sign(transaction, from: address)
                try await recordAndSend(signed, from: address, record: SignedRecord(
                    hash: signed.hash, nonce: nonce, to: destination, symbol: transfer.token.symbol, decimals: transfer.token.decimals,
                    amount: String(transfer.amount), usdMicros: transfer.usdMicros.map { String($0) }, gainUsdMicros: String(transfer.gainUsdMicros),
                    reason: reason, createdAt: now(), status: .pending
                ))
                nonce += 1
                sweepProblem = nil
            } catch let ChainError.rejected(message) {
                sweepProblem = "A sweep of \(transfer.token.symbol) didn't go out: \(message)"
                pausedUntil = now().addingTimeInterval(Self.pauseAfterFailure)
                return
            }
        }
    }

    /// On disk before it leaves, so a crash in between can't make this look like someone else's transaction.
    private func recordAndSend(_ signed: SignedTransaction, from address: EthereumAddress, record: SignedRecord) async throws {
        // Signing the same thing again gives the same hash, and that's one transaction, however many times it's sent.
        if let index = state.records[address]?.firstIndex(where: { $0.hash == record.hash }) {
            state.records[address]?[index] = record
        } else {
            state.records[address, default: []].append(record)
        }
        try persist()
        do {
            try await chain.send(signed)
        } catch ChainError.rejected(let message) {
            updateRecord(hash: signed.hash, address: address) { $0.status = .dropped }
            try persist()
            throw ChainError.rejected(message)
        } catch ChainError.rateLimited {
            updateRecord(hash: signed.hash, address: address) { $0.status = .dropped }
            try persist()
            throw ChainError.rateLimited
        } catch {
            // It's only certain nothing happened when the node says so. Anything else may have got through, so it stays pending, and
            // the receipt check settles it. Sending it again by a new signature could send the money twice.
            throw ChainError.unreachable
        }
    }

    private func settlePending(address: EthereumAddress, snapshot: ChainSnapshot) async throws {
        let records = state.records[address] ?? []
        for record in records where record.status == .pending || wasDroppedButMayHaveLanded(record, among: records, snapshot: snapshot) {
            // An earlier one in this loop landed with the same nonce, so this one can't.
            guard state.records[address]?.first(where: { $0.hash == record.hash })?.status == record.status else { continue }
            if let receipt = try await chain.receipt(of: record.hash) {
                try settle(record, with: receipt, among: records, address: address)
            } else if record.status == .dropped {
                continue
            } else if snapshot.nonce > record.nonce {
                // Its nonce is used, but not by this transaction, or the node just hasn't found the receipt yet.
                let misses = (missedReceipts[record.hash] ?? 0) + 1
                missedReceipts[record.hash] = misses
                if misses >= Self.readsBeforeAlarm {
                    updateRecord(hash: record.hash, address: address) { $0.status = .dropped }
                    raise([.nonceTaken(nonce: record.nonce, ours: record.hash)], address: address)
                    try persist()
                }
            } else if now().timeIntervalSince(record.createdAt) > Self.pendingTimeout {
                updateRecord(hash: record.hash, address: address) { $0.status = .dropped }
                try persist()
            }
        }
    }

    private func settle(_ record: SignedRecord, with receipt: Receipt, among records: [SignedRecord], address: EthereumAddress) throws {
        for other in records where other.nonce == record.nonce && other.hash != record.hash {
            updateRecord(hash: other.hash, address: address) { $0.status = .dropped }
        }
        updateRecord(hash: record.hash, address: address) { $0.status = receipt.succeeded ? .confirmed : .failed }
        missedReceipts[record.hash] = nil
        state.settledThroughBlock = max(state.settledThroughBlock ?? 0, receipt.blockNumber)
        catchUpReads = Self.readsToCatchUp
        if receipt.succeeded, let gain = UInt128(record.gainUsdMicros), gain > 0 {
            let swept = state.sweptGains[address].flatMap { UInt128($0) } ?? 0
            state.sweptGains[address] = String(swept + gain)
        }
        if !receipt.succeeded {
            switch record.reason {
            case .aboveCap, .manual, .rotation:
                sweepProblem = "A sweep of \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
                pausedUntil = now().addingTimeInterval(Self.pauseAfterFailure)
            case .sent, .note:
                sweepProblem = HotWalletWording.failedOnchain(record)
            case .site:
                // The site's to answer for, so it doesn't hold up sweeps.
                sweepProblem = "A transaction for \(record.site ?? "a site") failed onchain. Nothing moved, but its gas was spent."
            }
        }
        try persist()
    }

    /// Given up on, but something has used its nonce, and nothing this app signed is known to be what did. It may have landed late,
    /// even after a replacement with a different fee was sent.
    private func wasDroppedButMayHaveLanded(_ record: SignedRecord, among records: [SignedRecord], snapshot: ChainSnapshot) -> Bool {
        record.status == .dropped && snapshot.nonce > record.nonce && !records.contains { $0.nonce == record.nonce && ($0.status == .confirmed || $0.status == .failed) }
    }

    private func checkNonce(address: EthereumAddress, snapshot: ChainSnapshot) {
        let findings = AlarmCheck.findings(onchainNonce: snapshot.nonce, records: state.records[address] ?? [], acknowledgedThrough: state.acknowledgedThroughNonce)
        guard !findings.isEmpty else {
            nonceAheadTicks = 0
            return
        }
        nonceAheadTicks += 1
        if nonceAheadTicks >= Self.readsBeforeAlarm { raise(findings, address: address) }
    }

    private func raise(_ findings: [StolenKeyAlarm.Finding], address: EthereumAddress) {
        let new = findings.filter { !state.acknowledged.contains($0) && !(state.alarm?.findings.contains($0) ?? false) }
        guard !new.isEmpty else { return }
        if var alarm = state.alarm {
            // The count is one fact that changes, so the newest replaces the last rather than adding a line.
            if new.contains(where: \.isNonceCount) { alarm.findings.removeAll(where: \.isNonceCount) }
            alarm.findings += new
            state.alarm = alarm
        } else {
            state.alarm = StolenKeyAlarm(address: address, findings: new, raisedAt: now())
        }
        try? persist()
    }

    private func updateRecord(hash: String, address: EthereumAddress, _ change: (inout SignedRecord) -> Void) {
        guard let index = state.records[address]?.firstIndex(where: { $0.hash == hash }) else { return }
        change(&state.records[address]![index])
    }

    private func persist() throws {
        try stateStore.save(state)
    }
}

extension HotWallet: CostNoteWriter {
    public func canWriteNoteOnDevice(from wallet: String) -> Bool {
        settings.coldWallets.contains { $0.address.lowercased == wallet.lowercased() }
    }

    public var noteProblem: String? { sweepProblem }

    public func canWriteNote(from wallet: String) -> Bool {
        canSend && wallet.lowercased() == address?.lowercased
    }

    /// From this wallet to itself, with no value, so all it does is say this in public. Only ever from this app's own screens.
    public func writeNote(_ calldata: [UInt8], asset: String, from wallet: String) async -> Bool {
        guard let address, canWriteNote(from: wallet) else { return false }
        var isOnItsWay = false
        await work(confirming: "publish what you paid for \(asset), which anyone can read") { [self] in
            let snapshot = try await readToSign(address)
            try await signAndSend(to: address, value: 0, data: calldata, from: address, snapshot: snapshot) { hash, nonce in
                SignedRecord(hash: hash, nonce: nonce, to: address, symbol: asset, decimals: 18, amount: "0", usdMicros: nil, gainUsdMicros: "0", reason: .note, createdAt: now(), status: .pending)
            }
            isOnItsWay = true
        }
        return isOnItsWay
    }
}
