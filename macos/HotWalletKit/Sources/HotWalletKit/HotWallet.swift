import Foundation
import KeyVault
import LocalAuthentication
import Observation
import PricetagKit

/// The hot wallet, kept to its rules for as long as the app runs: reads the chain, sweeps what's above the cap to savings, and
/// compares what happened onchain with what it signed. The vault does the signing, and this never sees a key.
///
/// `signer` is private to this file, so everything that signs or touches a key is here, and the extensions in `HotWallet+*.swift` can't.
@MainActor
@Observable
public final class HotWallet {
    public enum Availability: Equatable {
        case ready
        /// Watch-only still works, but this build can't hold a key. See `macos/run.sh`.
        case notProvisioned
        case unavailable(String)
    }

    public private(set) var availability: Availability = .ready
    public private(set) var settings: WalletSettings
    public internal(set) var state: DeviceWalletState
    public private(set) var snapshot: ChainSnapshot?
    public private(set) var portfolio: Portfolio?
    public private(set) var plan: SweepPlan?
    public private(set) var isKeyMissing = false
    public private(set) var chainProblem: ChainError?
    public private(set) var ampProblem = false
    /// The address whose history Amp last answered for, with history in it. The alarm only compares once there's one.
    public private(set) var historyReadFor: EthereumAddress?
    /// Why the last thing this did didn't work, whether a sweep, a send, a note, a revoke or a site's transaction, or a setting that didn't get confirmed.
    /// After a sweep, automatic ones wait a while before trying again.
    public private(set) var lastActionProblem: String?
    /// What's on disk is behind what's here, which a restart would lose. See `persistOrSayWhy`.
    public private(set) var hasUnsavedRecords = false
    /// Every transaction the last send or sweep asked for put on its way, in order, a rebroadcast of one it had before included.
    /// What's shown about it follows these receipts and nothing else, so an earlier attempt or one made by itself can't stand in for it.
    public private(set) var lastSubmitted: [String] = []
    /// While a send or sweep is in its turn, what it's put on its way so far.
    private var submitting: [String]?

    /// What's become of these transactions, from their records. One this wallet has no record of yet hasn't landed.
    public func landing(of hashes: [String]) -> Landing {
        let records = self.records
        let tracked = Set(hashes).map { hash in records.first { $0.hash == hash } }
        return tracked.contains { $0 == nil } ? .onItsWay : Landing(tracked.compactMap(\.self))
    }
    public private(set) var isWorking = false
    /// What's keeping a rotation from deleting the old key. The user can still choose to leave it behind.
    public internal(set) var rotationHold: RotationHold?
    /// Where each one-use key has got to, from its last look.
    public internal(set) var oneUseHolds: [EthereumAddress: OneUseHold] = [:]
    @ObservationIgnored var oneUseReads: [EthereumAddress: OneUseReads] = [:]
    /// What the last check of `signedPermits` found. One it hasn't looked at has no answer here.
    public internal(set) var permitChecks: [String: SignedPermit.Check] = [:]
    public internal(set) var isCheckingPermits = false
    public var onLinkedWalletsChange: (([String]) -> Void)?
    /// A key is gone, and this one took over from it, if any did. A rotation can finish with nothing open, so this isn't left to a view.
    public var onKeyRetired: ((EthereumAddress, EthereumAddress?) -> Void)?
    /// What this wallet did, as it happens, for telling someone who isn't looking. Here and not in a view, because it happens with nothing open.
    public var onNews: ((HotWalletNews) -> Void)?

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
    @ObservationIgnored let portfolioSource: @MainActor () -> any PortfolioSource
    @ObservationIgnored let costMethod: @MainActor () -> CostMethod
    @ObservationIgnored private let moneyDisplay: @MainActor () -> MoneyDisplay
    @ObservationIgnored private let makeChain: @Sendable (URL) -> any ChainClient
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored private let tickDelay: Duration
    @ObservationIgnored private let readDelay: Duration
    @ObservationIgnored private let readRetryDelay: Duration
    @ObservationIgnored private let receiptDelay: Duration
    @ObservationIgnored private(set) var chain: any ChainClient
    @ObservationIgnored private var tickTask: Task<Void, Never>?
    @ObservationIgnored private var readTask: Task<Void, Never>?
    @ObservationIgnored private var receiptTask: Task<Void, Never>?
    @ObservationIgnored private var missedReceipts: [String: Int] = [:]
    @ObservationIgnored private var nonceAheadTicks = 0
    @ObservationIgnored var emptyReads = 0
    @ObservationIgnored private var catchUpReads = 0
    @ObservationIgnored private var pausedUntil: Date?
    @ObservationIgnored private var lastInLine: Task<Void, Never>?
    /// When the old key first read as empty in a rotation. History has to reach that block before it can say there's nothing else.
    @ObservationIgnored var rotationEmptySince: (block: UInt64, date: Date)?
    /// Whether the vault's been checked for keys already retired, since the last launch or the last time one failed to delete.
    @ObservationIgnored private var retiredKeysAreGone = false
    /// The active key is one this device still had, with something on it, after its wallet was deleted. Only said until the next restart.
    private(set) var cameBackWithSomethingOnIt = false

    /// How long a sweep that didn't work waits before trying again.
    static let pauseAfterFailure: TimeInterval = 300
    /// How long a transaction can go unseen before its nonce counts as free again.
    nonisolated static let pendingTimeout: TimeInterval = 180
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
        signer: any Signer = defaultSigner(),
        settingsStore: any WalletSettingsStore = UserDefaultsWalletSettingsStore(),
        stateStore: any DeviceStateStore = FileDeviceStateStore(),
        presence: any UserPresence = DeviceOwnerPresence(),
        portfolioSource: @escaping @MainActor () -> any PortfolioSource,
        costMethod: @escaping @MainActor () -> CostMethod = { .average },
        moneyDisplay: @escaping @MainActor () -> MoneyDisplay = { MoneyDisplay(main: .USD) },
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
        self.moneyDisplay = moneyDisplay
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
            availability = .unavailable(HotWalletWording.cantReadRecords)
        }
        // From the start, so nothing that can make a key is ever offered, even for a moment.
        if Build.isWatchOnly || signer is WatchOnlySigner { availability = .notProvisioned }
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
                await self?.readOneUseHistory()
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
        await deleteRetiredKeys()
        await lookAtActiveKey()
        // After Spending Money's own turn, so a fee it sends is from a read that's already settled.
        await lookAtOneUseKeys()
    }

    private func lookAtActiveKey() async {
        guard availability == .ready, let address else {
            await reconcileKeys()
            return
        }
        if hasUnsavedRecords { persistOrSayWhy() }
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
            lastActionProblem = HotWalletWording.problem(error)
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
                lastActionProblem = HotWalletWording.problem(error)
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
            let portfolio = try await portfolioSource().portfolio(ReadContext(address: address.lowercased, method: costMethod(), currency: .USD, rule: nil, linked: linked, book: Book()), timeout: .seconds(180))
            guard !Task.isCancelled, address == self.address else { return }
            self.portfolio = portfolio
            ampProblem = false
            // A dataset that hasn't started has no history to compare with yet, however well the read went.
            historyReadFor = portfolio.progress.started ? address : nil
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
            // A one-use key has its own way out, and is never Spending Money.
            let oneUse = Set(oneUseKeys.map(\.address))
            let keys = try await signer.addresses().filter { !state.retired.contains($0) && !oneUse.contains($0) }
            // The records were lost but the key wasn't: there's still only one hot wallet per device.
            if state.retired.isEmpty {
                if let existing = keys.first { try activate(existing) }
                return
            }
            // A wallet's been deleted here, so this is a key left behind, usually by a replacement that was cut short, and it mustn't undo that.
            // It may also be the newest key, if these records are from an older copy, so one with something on it comes back. One without
            // stays in the vault and out of the way, because this only sees the allowlist, and a key can't be got back.
            for key in keys {
                let snapshot = try await chain.snapshot(of: key)
                guard snapshot.chainID == Base.chainID else { return }
                if snapshot.nonce > 0 || snapshot.balances.values.contains(where: { $0 > 0 }) {
                    try activate(key)
                    cameBackWithSomethingOnIt = true
                    return
                }
            }
        } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
            availability = .notProvisioned
        } catch {}
    }

    private func activate(_ key: EthereumAddress) throws {
        try save { $0.active = key }
        publishLinkedWallets()
    }

    /// A retired key has been emptied, or the user chose to leave what's on it, so nothing should be left of it. Deleting one can fail or
    /// be cut short by a quit, and this catches that, on the first look after a launch and then until it works.
    private func deleteRetiredKeys() async {
        guard availability == .ready, !retiredKeysAreGone else { return }
        do {
            for key in try await signer.addresses() where state.retired.contains(key) && key != state.active && key != state.rotation?.to {
                try await signer.deleteKey(key)
            }
            retiredKeysAreGone = true
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
            switch nextStep(in: rotation, snapshot: snapshot) {
            case .move(let everything): try await execute(everything, from: address, to: rotation.destination, reason: .rotation, snapshot: snapshot)
            case .wait: break
            case .finish: try await retire(rotation.from, activating: rotation.to)
            }
            return
        }
        if let pausedUntil, now() < pausedUntil { return }
        guard !isKeyMissing, let plan, !plan.transfers.isEmpty, let destination = settings.sweepDestination else { return }
        try await execute(plan, from: address, to: destination, reason: .aboveCap, snapshot: snapshot)
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

    func price(of token: Token, snapshot: ChainSnapshot) -> UInt128? {
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

    /// Not during a rotation. What's been moved may already be on the new key, which would take over on the next tick anyway.
    public var canDelete: Bool { address != nil && rotation == nil }

    /// Holdings it can't value, which the cap can't see.
    public var unpricedSymbols: [String] {
        holdings.filter { $0.priceUsdMicros == nil && !$0.token.isNative }.map(\.token.symbol)
    }

    /// Spending keys that have been replaced. Costs keep following them, and sends to them are refused.
    public var replacedKeys: [String] { state.retired.filter { !purchaseKeys.contains($0) }.map(\.lowercased) }

    public var linkedWallets: [String] {
        var wallets: [String] = []
        if let address { wallets.append(address.lowercased) }
        if let rotation { wallets.append(rotation.to.lowercased) }
        // What's bought through a one-use key carries its cost on to savings, the way a rotation's does.
        wallets += oneUseKeys.map(\.address.lowercased)
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

    /// How this wallet's amounts read. They're all USD in here, and this is the only place they stop being: see `MoneyDisplay`.
    public var display: MoneyDisplay { moneyDisplay() }

    public func money(_ usdMicros: UInt128) -> String {
        display.money(usdMicros)
    }

    /// For the whole dollars a slider moves in.
    public func money(dollars: Int) -> String {
        display.whole(dollars: dollars)
    }

    public var capText: String { display.cap(settings.capUsdMicros) }

    /// What everything priced here is worth, ETH kept for gas included, so it reads the same as this wallet's numbers anywhere else.
    /// The cap counts the plan's value, which leaves that ETH out. Nil until the first read.
    public var valueUsdMicros: UInt128? {
        plan.map { _ in holdings.reduce(0) { $0 + ($1.valueUsdMicros ?? 0) } }
    }

    // MARK: - Settings

    /// Lowering it can send money to savings at the next look, so that asks. Raising it moves nothing, so that doesn't.
    public func setCap(dollars: Int) async {
        var next = settings
        next.setCap(dollars: dollars)
        if next.capUsdMicros < settings.capUsdMicros {
            guard await confirmingSetting("lower this wallet's cap to \(money(dollars: next.capInDollars)), which can move what's above it to your savings") else { return }
        }
        updateSettings { $0.setCap(dollars: dollars) }
    }

    public func setSweepsRealizedGains(_ value: Bool) {
        updateSettings { $0.sweepsRealizedGains = value }
    }

    public func setSweepDestination(_ address: EthereumAddress) async {
        guard address != settings.sweepDestination, let wallet = settings.coldWallets.first(where: { $0.address == address }) else { return }
        guard await confirmingSetting("send sweeps to \(wallet.name) (\(address.checksummed))") else { return }
        updateSettings { $0.setSweepDestination(address) }
    }

    public func setRPC(_ url: URL) async {
        guard url != settings.rpcURL else { return }
        guard await confirmingSetting("change this wallet's network address to \(url.host() ?? url.absoluteString)") else { return }
        // Two can ask at once, and only the first has anything left to do.
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

    /// Why this can't be a savings wallet, whatever the device shows.
    public func problem(addingColdWallet address: EthereumAddress) -> ColdWalletProblem? {
        if address == .zero { return .isZero }
        if address == self.address { return .isThisHotWallet }
        return state.retired.contains(address) || purchaseKeys.contains(address) ? .isARetiredKey : nil
    }

    /// The address has to be what the user read on the device's screen. Nothing here can check that, so the sheet makes them say so.
    /// True if it was added. `isWanted` is asked after the prompt, since what's on screen can change while it's open.
    @discardableResult
    public func addColdWallet(address text: String, name: String, isWanted: () -> Bool = { true }) async throws(ColdWalletProblem) -> Bool {
        guard let address = EthereumAddress(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { throw .notAnAddress }
        if let problem = problem(addingColdWallet: address) { throw problem }
        let what = settings.sweepDestination == nil ? "add \(address.checksummed) as your savings wallet, where money above your cap will go" : "add \(address.checksummed) as a savings wallet"
        guard await confirmingSetting(what), isWanted() else { return false }
        // A rotation can start or finish while the prompt's open.
        if let problem = problem(addingColdWallet: address) { throw problem }
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        updateSettings { $0.add(ColdWallet(address: address, name: cleanName.isEmpty ? "Savings" : cleanName, confirmedOnDeviceAt: now())) }
        return true
    }

    /// Other accounts on a device, which go in the book as the user's from here on. This can't tell whose they are, so the caller has to have asked. They only link costs.
    public func linkDeviceAccounts(_ addresses: [String]) {
        let accounts = addresses.compactMap(EthereumAddress.init).filter { $0 != .zero && $0 != address && !state.retired.contains($0) }
        guard !accounts.isEmpty else { return }
        updateSettings { $0.addDeviceAccounts(accounts) }
    }

    /// One the user no longer says is theirs. Nothing but costs ever depended on it.
    public func unlinkDeviceAccount(_ address: EthereumAddress) {
        guard settings.deviceAccounts.contains(address) else { return }
        updateSettings { $0.removeDeviceAccount(address) }
    }

    public func removeColdWallet(_ address: EthereumAddress) {
        updateSettings { $0.removeColdWallet(address) }
    }

    /// A savings wallet always has a name, because it's how the sweep says where the money went.
    public func renameColdWallet(_ address: EthereumAddress, to name: String) {
        let cleanName = name.trimmingCharacters(in: .whitespacesAndNewlines)
        updateSettings { $0.renameColdWallet(address, to: cleanName.isEmpty ? "Savings" : cleanName) }
    }

    /// For a setting that decides what the next sweep does, since a sweep then runs with nobody asked. It doesn't wait its turn like `work`,
    /// because nothing here signs, and a node that's stuck is a reason to change the RPC.
    private func confirmingSetting(_ reason: String) async -> Bool {
        isWorking = true
        defer { isWorking = false }
        lastActionProblem = nil
        do {
            try await confirmPresence(reason: reason)
            return true
        } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
            return false
        } catch {
            lastActionProblem = HotWalletWording.touchIDDidNotConfirm
            return false
        }
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
            // A look at the chain can bring a wallet back while this waits its turn, and a new key would hide what's on it.
            guard self.address == nil else { return }
            let address = try await signer.createKey()
            try await keepingKey(address) { $0.active = address }
            publishLinkedWallets()
            start()
        }
    }

    // MARK: - One-use keys

    /// A key for one purchase, made like Spending Money's. It's on disk before its address goes anywhere, so a quit can't lose it
    /// with money on the way, and it's only for when there's savings for what arrives to go on to.
    public func createOneUseKey() async -> EthereumAddress? {
        guard canTopUp, let destination = settings.sweepDestination else { return nil }
        var made: EthereumAddress?
        await work { [self] in
            // An alarm or a replacement can start while this waits its turn.
            guard canTopUp else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
            let key = try await signer.createKey()
            try await keepingKey(key) {
                $0.oneUseKeys = ($0.oneUseKeys ?? []) + [OneUseKey(address: key, destination: destination, createdAt: now())]
                $0.purchaseKeys = ($0.purchaseKeys ?? []) + [key]
            }
            oneUseHolds[key] = .waitingForPurchase
            publishLinkedWallets()
            made = key
        }
        return made
    }

    private func lookAtOneUseKeys() async {
        guard availability == .ready else { return }
        for key in oneUseKeys {
            do {
                try await lookAt(key.address)
            } catch is CancellationError {
                return
            } catch is ChainError {
                // The next tick tries again, and Spending Money's own read says so if the node's down.
            } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
                availability = .notProvisioned
                return
            } catch {
                lastActionProblem = HotWalletWording.problem(error)
            }
        }
    }

    /// Like Spending Money's turn: settle what's on its way, check nothing else has used the key, then move what's there, or retire it.
    private func lookAt(_ address: EthereumAddress) async throws {
        let snapshot = try await chain.snapshot(of: address)
        guard snapshot.chainID == Base.chainID else { return }
        guard try await signer.hasKey(address) else {
            oneUseHolds[address] = .keyMissing
            return
        }
        try await settlePending(address: address, snapshot: snapshot)
        checkOneUseNonce(address, snapshot: snapshot)
        guard let key = oneUseKeys.first(where: { $0.address == address }), snapshot.blockNumber >= key.settledThroughBlock ?? 0 else { return }
        if (state.records[address] ?? []).contains(where: { $0.status == .pending }) {
            oneUseHolds[address] = .moving
            return
        }
        if let until = oneUseReads[address]?.pausedUntil, now() < until { return }
        switch nextStep(for: key, snapshot: snapshot) {
        case .move(let plan): try await execute(plan, from: address, to: destination(of: key), reason: .purchase, snapshot: snapshot)
        case .sendGas(let wei): try await sendGas(wei, to: key, keyRead: snapshot)
        case .wait: break
        case .finish: try await retireOneUseKey(address)
        }
    }

    private func checkOneUseNonce(_ address: EthereumAddress, snapshot: ChainSnapshot) {
        guard !AlarmCheck.findings(onchainNonce: snapshot.nonce, records: state.records[address] ?? []).isEmpty else {
            oneUseReads[address]?.nonceAheadTicks = 0
            return
        }
        oneUseReads[address, default: OneUseReads()].nonceAheadTicks += 1
        if oneUseReads[address]?.nonceAheadTicks ?? 0 >= Self.readsBeforeAlarm { raiseForOneUseKey(address) }
    }

    /// ETH from Spending Money for the fee to move a token that arrived without any. Only from a read of Spending Money that's settled,
    /// with nothing of its own on the way, so it can't reuse a nonce or count ETH that's already gone.
    private func sendGas(_ wei: UInt128, to key: OneUseKey, keyRead: ChainSnapshot) async throws {
        // The last one is still on its way, so this is only waiting for it.
        if let from = address, (state.records[from] ?? []).contains(where: { $0.status == .pending && $0.reason == .purchaseGas && $0.to == key.address }) { return }
        // What the key holds has to be from after Spending Money's last transaction, which may be the fee it sent last time.
        guard keyRead.blockNumber >= state.settledThroughBlock ?? 0 else { return }
        guard let from = address, canSend, !isKeyMissing, let snapshot, snapshot.chainID == Base.chainID, snapshot.fees.isPlausible,
              snapshot.blockNumber >= state.settledThroughBlock ?? 0, pausedUntil.map({ now() >= $0 }) ?? true,
              !(state.records[from] ?? []).contains(where: { $0.status == .pending }),
              snapshot.balances[Base.eth] ?? 0 >= wei + snapshot.fees.costWei(of: Base.eth)
        else {
            oneUseHolds[key.address] = .needsGas
            return
        }
        // Counted before it's signed, so a crash in between can't let it go over.
        try save { state in
            guard let index = state.oneUseKeys?.firstIndex(where: { $0.address == key.address }) else { return }
            state.oneUseKeys?[index].gasSends += 1
        }
        do {
            try await signAndSend(to: key.address, value: wei, data: [], from: from, snapshot: snapshot) { hash, nonce in
                SignedRecord(
                    hash: hash, nonce: nonce, to: key.address, symbol: Base.eth.symbol, decimals: 18, amount: String(wei),
                    usdMicros: snapshot.ethUsdMicros.map { String(Money.usdMicros(of: wei, priceMicros: $0, decimals: 18)) }, gainUsdMicros: "0",
                    reason: .purchaseGas, createdAt: now(), status: .pending
                )
            }
        } catch let ChainError.rejected(message) {
            sweptOnItsOwnFailed(message, reason: .purchaseGas)
            pause(key.address)
        }
    }

    /// Like a rotation's last step: on disk first, then the key goes. If it won't delete or the app quits first, the next look deletes it.
    private func retireOneUseKey(_ key: EthereumAddress) async throws {
        try save {
            $0.oneUseKeys?.removeAll { $0.address == key }
            $0.retired.append(key)
        }
        oneUseHolds[key] = nil
        oneUseReads[key] = nil
        publishLinkedWallets()
        retiredKeysAreGone = false
        await deleteRetiredKeys()
    }

    /// What sweeping everything would move right now, for showing. It's worked out again from a fresh read before anything's signed.
    public var sweepPreview: SweepPreview? {
        guard let snapshot, let destination = settings.sweepDestination else { return nil }
        let plan = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: destination)
        let transfers = plan.transfers
        let feeWei = transfers.reduce(UInt128(0)) { $0 + snapshot.fees.costWei(of: $1.token) }
        return SweepPreview(transfers: transfers, feeWei: feeWei, feeUsdMicros: snapshot.ethUsdMicros.map { Money.usdMicros(of: feeWei, priceMicros: $0, decimals: 18) }, whyNothing: HotWalletWording.whyNothingSweeps(plan))
    }

    /// Everything on the allowlist, to the chosen savings wallet, after asking the person at the device.
    /// True once all of it's on its way. Otherwise `lastActionProblem` says what stopped it, and what went anyway.
    @discardableResult
    public func sweepEverything(in prompt: PresencePrompt? = nil) async -> Bool {
        guard let address, let destination = settings.sweepDestination else { return false }
        // Touch ID is for approving something, and as of the last read there's nothing to approve, or it couldn't go yet. A read that does find something still asks, and then reads again.
        if let whyNot = whySweepHasToWait(for: address, lastRead: snapshot) ?? sweepPreview?.whyNothing {
            lastActionProblem = whyNot
            return false
        }
        var isOnItsWay = false
        let name = settings.coldWallets.first { $0.address == destination }?.name ?? "your savings"
        lastSubmitted = []
        await work(confirming: "sweep everything to \(name)", in: prompt) { [self] in try await keepingSubmitted {
            // Not `canSend`: a key that may be stolen, or that's being replaced, can still move to safety. See "Reading before acting".
            guard self.address == address else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
            let snapshot = try await readInTurn(address)
            if let wait = whySweepHasToWait(for: address, lastRead: snapshot) { throw ChainError.rejected(wait) }
            let everything = SweepPlanner.everything(holdings: holdings, fees: snapshot.fees, destination: destination)
            if let whyNothing = HotWalletWording.whyNothingSweeps(everything) { throw ChainError.rejected(whyNothing) }
            pausedUntil = nil
            var stoppedBy: ChainError?
            do {
                try await execute(everything, from: address, to: destination, reason: .manual, snapshot: snapshot)
            } catch let error as ChainError {
                stoppedBy = error
            }
            // Nothing was pending before this, so what's pending now is how far down the plan it got. Like a send, that counts a broadcast that may have got through.
            let sent = (state.records[address] ?? []).filter { $0.status == .pending }.count
            let left = everything.transfers.dropFirst(sent)
            guard !left.isEmpty else {
                isOnItsWay = true
                return
            }
            guard sent > 0 else {
                // Nothing went, and either this says why or `execute` already has.
                if let stoppedBy { throw stoppedBy }
                return
            }
            throw ChainError.rejected(HotWalletWording.sweptOnlySome(
                onItsWay: everything.transfers.prefix(sent).map(\.token.symbol),
                left: left.map(\.token.symbol),
                because: stoppedBy.map(HotWalletWording.whatStoppedASweep) ?? lastActionProblem ?? ""
            ))
        } }
        return isOnItsWay
    }

    /// What's already gone has to land and show up first, so a sweep can't reuse its nonce or move it twice.
    private func whySweepHasToWait(for address: EthereumAddress, lastRead: ChainSnapshot?) -> String? {
        if let lastRead, lastRead.blockNumber < state.settledThroughBlock ?? 0 { return HotWalletWording.lastOneStillShowingUp }
        if (state.records[address] ?? []).contains(where: { $0.status == .pending }) { return HotWalletWording.lastOneOnItsWay }
        return nil
    }

    /// What the confirmation asks for, in its own terms. Only all of it being on its way is done, because done closes the sheet.
    public func sweepConfirmed(in prompt: PresencePrompt) async -> ApprovalResult {
        if await sweepEverything(in: prompt) { return .done }
        return lastActionProblem.map(ApprovalResult.failed) ?? .cancelled
    }

    /// A new key, with everything moved off the old one, which is deleted once it's empty. After an alarm, what's left goes
    /// to savings when there is one, because that's further from whoever has the old key.
    public func replaceKey() async {
        guard let address, rotation == nil else { return }
        await work(confirming: "replace this wallet's key") { [self] in
            // The wallet can be deleted or replaced while the prompt's open, and then this isn't its key anymore.
            guard self.address == address, rotation == nil else { return }
            let next = try await signer.createKey()
            let destination = alarm != nil ? settings.sweepDestination ?? next : next
            // A rotation that isn't on disk mustn't move anything to the new key.
            try await keepingKey(next) { $0.rotation = Rotation(from: address, to: next, destination: destination) }
            publishLinkedWallets()
            Task { await tick() }
        }
    }

    /// Only when something can't be moved, like tokens with no ETH for gas or that gas makes too costly to move, and the user has said to leave it behind.
    public func finishRotationLeavingFundsBehind() async {
        guard let rotation else { return }
        await work(confirming: "delete the old key and leave what's on it behind") { [self] in
            // The rotation can finish while the prompt's open, and the new key can be deleted after that. This mustn't undo either.
            guard state.rotation == rotation, self.address == rotation.from else { return }
            try await retire(rotation.from, activating: rotation.to)
        }
    }

    /// Deletes the key for good. What's still on it is lost, so the view offers a sweep first.
    public func deleteWallet() async {
        guard canDelete, let address else { return }
        await work(confirming: "delete this wallet's key, which can't be undone") { [self] in
            // A rotation can start or finish while the prompt's open, and then this key isn't all there is.
            guard self.address == address else { throw ChainError.rejected(HotWalletWording.changedWhileWaiting) }
            guard canDelete else { throw ChainError.rejected(HotWalletWording.deleteWaitsForRotation) }
            try await retire(address, activating: nil)
            await reconcileKeys()
        }
    }

    /// The key only goes once its retirement is on disk. If that can't be written the wallet carries on as it was, and if the key
    /// won't delete or the app quits first, the next look deletes it. The other way round, a restart would find a wallet with no key.
    private func retire(_ key: EthereumAddress, activating next: EthereumAddress?) async throws {
        try save {
            $0.retired.append(key)
            $0.active = next
            // Its alarms, dismissals and block numbers say nothing about the next key.
            $0.connectedSites = nil
            $0.rotation = nil
            $0.alarm = nil
            $0.acknowledged = []
            $0.acknowledgedThroughNonce = nil
            $0.settledThroughBlock = nil
        }
        forgetTheOldKeysReads()
        onKeyRetired?(key, next)
        publishLinkedWallets()
        retiredKeysAreGone = false
        await deleteRetiredKeys()
    }

    /// Everything else that was about one key, and that's not worth writing down.
    private func forgetTheOldKeysReads() {
        permitChecks = [:]
        snapshot = nil
        plan = nil
        portfolio = nil
        rotationHold = nil
        lastActionProblem = nil
        cameBackWithSomethingOnIt = false
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
        persistOrSayWhy()
    }

    /// The prompt comes first and waits outside the line, so an open prompt doesn't hold up automatic sweeps.
    private func work(confirming reason: String? = nil, in prompt: PresencePrompt? = nil, _ body: @escaping @MainActor () async throws -> Void) async {
        isWorking = true
        defer { isWorking = false }
        do {
            lastActionProblem = nil
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
            lastActionProblem = HotWalletWording.touchIDDidNotConfirm
        } catch let error as ChainError {
            switch error {
            case .rejected(let message): lastActionProblem = message
            case .rateLimited: lastActionProblem = HotWalletWording.networkBusy
            case .unreachable, .unreadable: lastActionProblem = HotWalletWording.cantReachChain
            }
        } catch let error as KeychainSealedKeyStore.Failure where error == .notProvisioned {
            availability = .notProvisioned
        } catch {
            lastActionProblem = HotWalletWording.problem(error)
        }
    }

    // MARK: - Asking the person at the device

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

    // MARK: - Signing for sites

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
        let snapshot = try await readInTurn(address)
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

    /// Only after the user approved exactly this in the app. A message never spends by itself, but what it permits can, so a permit
    /// is written down before the site gets it. If that fails, the site doesn't get it.
    func signForSite(_ review: MessageReview, origin: String) async throws -> MessageSignature {
        guard let address else { throw ChainError.unreadable }
        let signature = try await signer.sign(review.signable, from: address)
        if let permit = SignedPermit(review, site: origin, signedAt: now()), state.signedPermits?[address]?.contains(where: { $0.id == permit.id }) != true {
            let before = state.signedPermits
            state.signedPermits = (before ?? [:]).merging([address: [permit]]) { $0 + $1 }
            do {
                try persist()
            } catch {
                state.signedPermits = before
                throw error
            }
        }
        return signature
    }

    // MARK: - Sending

    /// The most of a token that can be sent right now.
    public func maximumSend(of token: Token) -> UInt128 {
        snapshot.map { SendPlanner.maximum(of: token, snapshot: $0) } ?? 0
    }

    /// Why nothing can go to this address, if nothing can.
    public func problem(sendingTo recipient: EthereumAddress) -> SendProblem? {
        guard let address else { return nil }
        return SendPlanner.problem(sendingTo: recipient, from: address, retired: state.retired + oneUseKeys.map(\.address))
    }

    /// Asks the person at the device, then signs exactly this, and checks it again against a fresh read. True once it's on its way.
    @discardableResult
    public func send(_ request: SendRequest, in prompt: PresencePrompt? = nil) async -> Bool {
        guard let address, canSend else { return false }
        var isOnItsWay = false
        lastSubmitted = []
        await work(confirming: "send \(Money.text(ofUnits: request.amount, decimals: request.token.decimals)) \(request.token.symbol) to \(request.to.checksummed)", in: prompt) { [self] in try await keepingSubmitted {
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
        } }
        return isOnItsWay
    }

    // MARK: - Revoking

    /// What revoking these would cost right now, to show before Touch ID asks. Nil when the node can't say, or says one would fail.
    public func quoteRevocations(_ revocations: [Revocation]) async -> RevocationQuote? {
        guard let address, !revocations.isEmpty, revocations.count <= RevocationPlanner.maximum, revocations.allSatisfy(\.isAllowed) else { return nil }
        let transactions = RevocationPlanner.transactions(for: revocations)
        do {
            let snapshot = try await readToQuote(address)
            var feeWei: UInt128 = 0
            for transaction in transactions {
                let gas = FeeQuote.gasLimit(estimate: try await chain.estimateGas(from: address, to: transaction.to, value: 0, data: transaction.data), isPlainSend: false)
                let unsigned = UnsignedTransaction(chainID: Base.chainID, nonce: snapshot.nonce, maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas, maxFeePerGas: snapshot.fees.maxFeePerGas, gasLimit: gas, to: transaction.to, value: 0, data: transaction.data)
                let fees = FeeQuote(maxFeePerGas: snapshot.fees.maxFeePerGas, maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas, l1FeeWei: try await chain.l1Fee(ofPayload: unsigned.signingPayload))
                guard fees.isPlausible else { return nil }
                feeWei += fees.costWei(gas: UInt128(gas))
            }
            return RevocationQuote(feeWei: feeWei, feeUsdMicros: snapshot.ethUsdMicros.map { Money.usdMicros(of: feeWei, priceMicros: $0, decimals: 18) }, transactions: transactions.count)
        } catch {
            return nil
        }
    }

    /// Asks the person at the device once, then signs one transaction for each token, and one for Permit2. Each only
    /// sets an allowance to nothing. True once they're all on their way. One that fails stops the rest, and says why.
    @discardableResult
    public func revoke(_ revocations: [Revocation], in prompt: PresencePrompt? = nil) async -> Bool {
        guard let address, canSend, !revocations.isEmpty, revocations.count <= RevocationPlanner.maximum, revocations.allSatisfy(\.isAllowed) else { return false }
        let transactions = RevocationPlanner.transactions(for: revocations)
        var isOnItsWay = false
        lastSubmitted = []
        let what = revocations.count == 1 ? "an approval for \(revocations[0].label)" : "\(revocations.count) approvals"
        await work(confirming: "revoke \(what)", in: prompt) { [self] in try await keepingSubmitted {
            let snapshot = try await readToSign(address)
            for transaction in transactions {
                let first = transaction.revocations[0]
                try await signAndSend(to: transaction.to, value: 0, data: transaction.data, from: address, snapshot: snapshot) { hash, nonce in
                    SignedRecord(
                        hash: hash, nonce: nonce, to: transaction.revocations.count == 1 ? first.spender : Base.permit2,
                        symbol: transaction.revocations.map(\.label).joined(separator: ", "), decimals: 0, amount: "0", usdMicros: nil, gainUsdMicros: "0",
                        reason: .revoke, createdAt: now(), status: .pending
                    )
                }
            }
            isOnItsWay = true
        } }
        return isOnItsWay
    }

    /// What the confirmation asks for, in its own terms.
    public func revokeConfirmed(_ revocations: [Revocation], in prompt: PresencePrompt) async -> ApprovalResult {
        if await revoke(revocations, in: prompt) { return .done }
        return lastActionProblem.map(ApprovalResult.failed) ?? .cancelled
    }

    // MARK: - Reading before acting

    // Each of these reads the chain before something that costs money, and they ask for different things on purpose. Don't merge them further without keeping these:
    // - Send, note and revoke (`readToSign`): checked against the balances this read shows, so it settles what's pending first and refuses to go until nothing is. `canSend` has to hold before and after, because alarms arrive during the wait.
    // - Sweep (`sweepEverything`): `canSend` doesn't apply, because a key that may be stolen or that's being replaced still moves to safety. It moves everything, so it waits for what's pending too, which would otherwise go twice, but leaves settling to the tick. Fees are `execute`'s to check, since that's where an automatic sweep pauses over them.
    // - Site's transaction (`signAndSendForSite`): `siteProblem` in place of `canSend`, which says the same with a site's wording. What's signed is what the user approved, not worked out from balances, so it only needs a nonce that's right: it doesn't settle or wait for what's pending, which `AlarmCheck.nextNonce` counts, so a site can send one right after another. A read that's behind what's settled could still reuse a nonce, so it refuses that.
    // - Quotes (`quoteForSite`, `quoteRevocations`): nothing's signed and they run outside the line, so they don't settle anything or keep this read, which a turn in progress could be working from. A revocation's quote only says nil instead of why, because the sheet goes on without a fee.

    /// For whatever has waited its turn in the line. What's read is what's shown from here on, and what the rest of the turn goes by.
    private func readInTurn(_ address: EthereumAddress) async throws -> ChainSnapshot {
        let snapshot = try await patientSnapshot(of: address)
        self.snapshot = snapshot
        guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
        return snapshot
    }

    /// For showing what something would cost, outside the line.
    func readToQuote(_ address: EthereumAddress) async throws -> ChainSnapshot {
        let snapshot = try await patientSnapshot(of: address)
        guard snapshot.chainID == Base.chainID else { throw ChainError.rejected(HotWalletWording.wrongChain) }
        guard snapshot.fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        return snapshot
    }

    /// A transaction asked for by hand, with everything before it settled, because it's checked against what this read says.
    private func readToSign(_ address: EthereumAddress) async throws -> ChainSnapshot {
        try checkStillAllowed(address)
        let snapshot = try await readInTurn(address)
        guard snapshot.fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        try await settlePending(address: address, snapshot: snapshot)
        try checkStillAllowed(address)
        guard snapshot.blockNumber >= state.settledThroughBlock ?? 0 else { throw ChainError.rejected(HotWalletWording.lastOneStillShowingUp) }
        guard !(state.records[address] ?? []).contains(where: { $0.status == .pending }) else { throw ChainError.rejected(HotWalletWording.lastOneOnItsWay) }
        return snapshot
    }

    /// For what someone is waiting on, usually having just approved it with Touch ID. Nothing's been signed, so a read that fails can be
    /// asked again, and failing the whole thing over one bad moment on the network would make them start over.
    func patientSnapshot(of address: EthereumAddress) async throws -> ChainSnapshot {
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

    /// `lastSubmitted` is what `body` put on its way, however it ends.
    private func keepingSubmitted(_ body: () async throws -> Void) async throws {
        submitting = []
        defer {
            lastSubmitted = submitting ?? []
            submitting = nil
        }
        try await body()
    }

    private func signAndSend(to: EthereumAddress, value: UInt128, data: [UInt8], from address: EthereumAddress, snapshot: ChainSnapshot, record: (String, UInt64) -> SignedRecord) async throws {
        let estimate: UInt64
        do {
            estimate = try await chain.estimateGas(from: address, to: to, value: value, data: data)
        } catch ChainError.rejected(let message) {
            throw ChainError.rejected(HotWalletWording.notSent(message))
        }
        let gasLimit = FeeQuote.gasLimit(estimate: estimate, isPlainSend: data.isEmpty)
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
        } catch ChainError.rejected(let message) {
            throw ChainError.rejected(HotWalletWording.notSent(message))
        }
    }

    // MARK: - Signing

    private func execute(_ plan: SweepPlan, from address: EthereumAddress, to destination: EthereumAddress, reason: SignedRecord.Reason, snapshot: ChainSnapshot) async throws {
        guard snapshot.fees.isPlausible else {
            sweptOnItsOwnFailed(HotWalletWording.feesLookWrong, reason: reason)
            pause(address)
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
                    gasLimit: FeeQuote.gasLimit(estimate: estimate, isPlainSend: transfer.token.isNative),
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
                lastActionProblem = nil
            } catch let ChainError.rejected(message) {
                sweptOnItsOwnFailed("A sweep of \(transfer.token.symbol) didn't go out. \(HotWalletWording.refusal(message))", reason: reason)
                pause(address)
                return
            }
        }
    }

    /// Automatic moves from this key wait a while. Spending Money and each one-use key wait on their own, so one stuck doesn't hold up the others.
    private func pause(_ address: EthereumAddress) {
        let until = now().addingTimeInterval(Self.pauseAfterFailure)
        if oneUseKeys.contains(where: { $0.address == address }) {
            oneUseReads[address, default: OneUseReads()].pausedUntil = until
        } else {
            pausedUntil = until
        }
    }

    /// Says so once, and not again each time it tries and fails the same way. One by hand is said in front of the person.
    private func sweptOnItsOwnFailed(_ problem: String, reason: SignedRecord.Reason) {
        if reason != .manual, problem != lastActionProblem { onNews?(.sweepDidntGoOut(problem)) }
        lastActionProblem = problem
    }

    /// On disk before it leaves, so a crash in between can't make this look like someone else's transaction.
    private func recordAndSend(_ signed: SignedTransaction, from address: EthereumAddress, record: SignedRecord) async throws {
        submitting?.append(record.hash)
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
                    if oneUseKeys.contains(where: { $0.address == address }) {
                        raiseForOneUseKey(address)
                    } else {
                        raise([.nonceTaken(nonce: record.nonce, ours: record.hash)], address: address)
                    }
                    try persist()
                }
            } else if now().timeIntervalSince(record.createdAt) > Self.pendingTimeout {
                updateRecord(hash: record.hash, address: address) { $0.status = .dropped }
                try persist()
                if let dropped = state.records[address]?.first(where: { $0.hash == record.hash }) { onNews?(.unconfirmed(dropped)) }
            }
        }
    }

    private func settle(_ record: SignedRecord, with receipt: Receipt, among records: [SignedRecord], address: EthereumAddress) throws {
        for other in records where other.nonce == record.nonce && other.hash != record.hash {
            updateRecord(hash: other.hash, address: address) { $0.status = .dropped }
        }
        updateRecord(hash: record.hash, address: address) { $0.status = receipt.succeeded ? .confirmed : .failed }
        missedReceipts[record.hash] = nil
        if let index = state.oneUseKeys?.firstIndex(where: { $0.address == address }) {
            let settled = max(state.oneUseKeys?[index].settledThroughBlock ?? 0, receipt.blockNumber)
            state.oneUseKeys?[index].settledThroughBlock = settled
        } else {
            state.settledThroughBlock = max(state.settledThroughBlock ?? 0, receipt.blockNumber)
            catchUpReads = Self.readsToCatchUp
        }
        if receipt.succeeded, let gain = UInt128(record.gainUsdMicros), gain > 0 {
            let swept = state.sweptGains[address].flatMap { UInt128($0) } ?? 0
            state.sweptGains[address] = String(swept + gain)
        }
        if !receipt.succeeded {
            switch record.reason {
            case .aboveCap, .manual, .rotation, .purchase, .purchaseGas:
                lastActionProblem = "A sweep of \(record.symbol) failed onchain. Nothing moved, but its gas was spent."
                pause(address)
            case .sent, .note, .revoke:
                lastActionProblem = HotWalletWording.failedOnchain(record)
            case .site:
                // The site's to answer for, so it doesn't hold up sweeps.
                lastActionProblem = "A transaction for \(record.site.map(siteName) ?? "a site") failed onchain. Nothing moved, but its gas was spent."
            }
        }
        try persist()
        if let settled = state.records[address]?.first(where: { $0.hash == record.hash }) {
            // Given up on, and it landed after all. A failure is a failure either way.
            onNews?(record.status == .dropped && receipt.succeeded ? .landedLate(settled) : .settled(settled))
        }
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
            // The alarm is about this Mac's keys, and it's Spending Money that it stops. A one-use key only makes it louder.
            state.alarm = StolenKeyAlarm(address: oneUseKeys.contains { $0.address == address } ? self.address ?? address : address, findings: new, raisedAt: now())
        }
        persistOrSayWhy()
    }

    /// A one-use key's key never left this Mac, so anything it did that this app didn't sign means this Mac's keys can't be trusted.
    /// What's on it keeps moving to savings, which is the safest place for it either way.
    func raiseForOneUseKey(_ address: EthereumAddress) {
        raise([.oneUseKeySpent(address: address)], address: address)
    }

    private func updateRecord(hash: String, address: EthereumAddress, _ change: (inout SignedRecord) -> Void) {
        guard let index = state.records[address]?.firstIndex(where: { $0.hash == hash }) else { return }
        change(&state.records[address]![index])
    }

    private func persist() throws {
        do {
            try stateStore.save(state)
            hasUnsavedRecords = false
        } catch {
            hasUnsavedRecords = true
            throw RecordsNotSaved()
        }
    }

    /// For a change that's already true here and can't be undone by failing to write it, like an alarm. A restart would lose it, so
    /// the wallet says so, and each tick tries again until it's on disk.
    func persistOrSayWhy() {
        try? persist()
    }

    /// For a change that decides which keys count. It only takes effect once it's on disk, so nothing acts on what a restart wouldn't know.
    private func save(_ change: (inout DeviceWalletState) -> Void) throws {
        var changed = state
        change(&changed)
        do {
            try stateStore.save(changed)
        } catch {
            throw RecordsNotSaved()
        }
        state = changed
        hasUnsavedRecords = false
    }

    /// For a change about a key just made. Nothing's on it and nobody's seen its address, so it goes if the change can't be written.
    private func keepingKey(_ key: EthereumAddress, _ change: (inout DeviceWalletState) -> Void) async throws {
        do {
            try save(change)
        } catch {
            try? await signer.deleteKey(key)
            throw error
        }
    }
}

extension HotWallet: CostNoteWriter {
    public func canWriteNoteOnDevice(from wallet: String) -> Bool {
        settings.coldWallets.contains { $0.address.lowercased == wallet.lowercased() }
    }

    public var noteProblem: String? { lastActionProblem }

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
