import Foundation
import KeyVault
import LocalAuthentication
import Observation
import os

/// How often a site has been told no, or asked and gone away.
private struct Refusals {
    var times: [Date] = []
    var cooldowns = 0
    var cooldownUntil: Date?
}

/// One thing a site wants, waiting in the app for an answer. Nothing outside the app's own window can answer it: the bridge's
/// wire protocol has no message for that, and pages only ever reach `handle`.
public struct SiteApproval: Identifiable, Equatable, Sendable {
    public enum Action: Equatable, Sendable {
        case connect
        case transaction(TransactionReview)
        case message(MessageReview)
    }

    public let id: UUID
    public let origin: String
    public let action: Action
    fileprivate let requester: Requester

    public var warnings: [SiteWarning] {
        switch action {
        case .connect: []
        case .transaction(let review): review.warnings
        case .message(let review): review.warnings
        }
    }

    public var needsAcknowledgment: Bool { warnings.contains(where: \.isStrong) }

    fileprivate var isTransaction: Bool {
        if case .transaction = action { true } else { false }
    }

    public var site: String { siteName(origin) }

    /// Signing asks for Touch ID too, like every other time money can leave. Connecting only shows an address.
    /// It names the site and what leaves, because macOS's own dialog shows this over the window that does.
    var presenceReason: String? {
        switch action {
        case .connect: nil
        case .transaction(let review): "\(review.promptWords) for \(site)"
        case .message(let review): "\(review.headline.lowercasedFirst) for \(site)"
        }
    }
}

/// Who to tell when a request goes away, so a closed tab takes its approval with it.
struct Requester: Equatable, Hashable, Sendable {
    let connection: UUID
    let id: String
}

/// One request, from when it arrives until it's answered. A tab can close at any point in that, including while a node is still working
/// out what a transaction costs, when there's no approval yet to take away.
@MainActor
private final class LiveRequest {
    let request: SiteRequest
    let requester: Requester
    var task: Task<RPCAnswer, Never>?
    var approvalID: UUID?
    /// Still at the node, on its way to the window, so it counts as waiting.
    var isBeingQuoted = false
    private(set) var isCancelled = false

    var origin: String { request.origin }
    var method: String { request.method }
    var parameters: JSONValue? { request.parameters }

    init(_ request: SiteRequest) {
        self.request = request
        requester = Requester(connection: request.connection, id: request.id)
    }

    func cancel() {
        isCancelled = true
        task?.cancel()
    }
}

/// Something approved that's on its way. The window stays open for it, so a failure has somewhere to appear.
public struct SiteWork: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let origin: String
    public let isTransaction: Bool
    /// What was approved, so the window can keep showing it.
    public let approval: SiteApproval
    fileprivate var approvalID: UUID { approval.id }
}

/// Why something approved didn't happen. A site's own message about it can say anything, so the app says what really went wrong.
public struct SiteFailure: Identifiable, Equatable, Sendable {
    public let id = UUID()
    public let origin: String
    public let isTransaction: Bool
    public let reason: String

    public var site: String { siteName(origin) }
}

/// A site as people read it: without https://, which is the only scheme a site can have here apart from this Mac's own.
public func siteName(_ origin: String) -> String {
    origin.hasPrefix("https://") ? String(origin.dropFirst(8)) : origin
}

public struct SiteRequest: Sendable {
    public let connection: UUID
    public let id: String
    public let origin: String
    public let method: String
    public let parameters: JSONValue?

    public init(connection: UUID, id: String, origin: String, method: String, parameters: JSONValue?) {
        self.connection = connection
        self.id = id
        self.origin = origin
        self.method = method
        self.parameters = parameters
    }
}

/// All a site can ask of the hot wallet. It only ever sees the hot wallet: cold wallets aren't reachable from here at all.
@MainActor
@Observable
public final class SiteBridge {
    public private(set) var pending: [SiteApproval] = []
    /// Several can be on their way at once, because the window offers the next approval as soon as one is answered.
    private var allWork: [SiteWork] = []
    /// Each stays until it's been seen, since something approved that didn't happen has to be told.
    private var failures: [SiteFailure] = []
    /// Tells every tab on an origin something changed: `accountsChanged` with its accounts.
    @ObservationIgnored public var onAccountsChanged: ((_ origin: String, _ accounts: [String]) -> Void)?
    @ObservationIgnored public var onTopUp: (() -> Void)?
    @ObservationIgnored public var onReceive: (() -> Void)?

    public var current: SiteApproval? { pending.first }
    public var working: SiteWork? { allWork.first }
    public var failure: SiteFailure? { failures.first }
    /// The last thing to go through, for the window to say so before it closes. It doesn't keep the window open by itself.
    public private(set) var finished: SiteWork?

    /// What the window is showing, or nil when there's no reason for it to be open.
    public var windowID: UUID? { failure?.id ?? current?.id ?? working?.id }

    /// Only for what went wrong, never what was being sent: no calldata, no message and no key, and none of a node's own words, which can
    /// repeat what it was sent. Read it with
    /// `log show --predicate 'subsystem == "com.benface.pricetag" AND category == "sites"' --info`.
    nonisolated private static let log = Logger(subsystem: "com.benface.pricetag", category: "sites")

    private let wallet: HotWallet
    private let now: @Sendable () -> Date
    @ObservationIgnored private var waiting: [UUID: CheckedContinuation<Bool, Never>] = [:]
    @ObservationIgnored private var live: [LiveRequest] = []
    @ObservationIgnored private var refusals: [String: Refusals] = [:]
    @ObservationIgnored private var readsThisSecond: (second: Int, count: Int, byFamily: [String: Int]) = (0, 0, [:])
    @ObservationIgnored private var quotes: [String: [Date]] = [:]
    @ObservationIgnored private var lastKnownAddress: EthereumAddress?
    @ObservationIgnored private var lastKnownSites: [String] = []

    /// Only so that memory has a limit, since it takes a real domain to get anywhere near this.
    static let maxPending = 32
    /// All of these are per domain, as `family(of:)` counts them.
    static let maxPendingPerOrigin = 3
    /// Rejecting this many times in `rejectionWindow` stops a site asking for a while, so it can't wear someone down until they click yes.
    /// A page that asks and then goes away counts too, or reloading would be a way to take focus forever.
    static let rejectionsBeforeCooldown = 3
    static let rejectionWindow: TimeInterval = 60
    /// Each cooldown in a row is twice the last, up to about an hour, and an hour after the last one ends it starts over.
    static let longestCooldownDoubling = 6
    static let cooldownsForgottenAfter: TimeInterval = 3600
    /// Reads share the node with the wallet's own, and the public node allows 25 a second per IP. See `NodePacer`. This is for all sites
    /// together, and one site's limit is less, so a single tab can't use up what the others get.
    nonisolated static let readsPerSecond = 12
    nonisolated static let readsPerSecondPerFamily = 8
    /// Pricing a transaction takes a whole wallet read and more, so this is what keeps a connected site that sends one after another that
    /// can't be priced, which never reach the window, from taking the wallet's share of the node. Only connected sites get this far.
    static let quotesPerWindow = 10
    static let quoteWindow: TimeInterval = 60

    /// What a site can read from the node. Anything else that isn't handled here is refused, not passed along.
    static let reads: Set<String> = [
        "eth_blockNumber", "eth_call", "eth_estimateGas", "eth_feeHistory", "eth_gasPrice", "eth_getBalance", "eth_getBlockByHash",
        "eth_getBlockByNumber", "eth_getCode", "eth_getLogs", "eth_getStorageAt", "eth_getTransactionByHash", "eth_getTransactionCount",
        "eth_getTransactionReceipt", "eth_maxPriorityFeePerGas",
    ]

    static let baseChainHex = "0x2105"

    private static let signingMethods: Set<String> = ["eth_sendTransaction", "personal_sign", "eth_signTypedData_v4"]

    public init(wallet: HotWallet, now: @escaping @Sendable () -> Date = { Date() }) {
        self.wallet = wallet
        self.now = now
        lastKnownAddress = wallet.address
        lastKnownSites = wallet.connectedSites
    }

    /// Answers one request. It can wait a long time, for as long as the user takes to decide.
    public func handle(_ request: SiteRequest) async -> RPCAnswer {
        await begin(request).value
    }

    /// The same, for a caller that has to know a later `cancel` will find this request. It's on record by the time this returns.
    public func begin(_ request: SiteRequest) -> Task<RPCAnswer, Never> {
        let request = LiveRequest(request)
        live.append(request)
        let task = Task {
            let answer = await answer(request)
            live.removeAll { $0 === request }
            finishWork(for: request, with: answer)
            return answer
        }
        request.task = task
        return task
    }

    private func answer(_ request: LiveRequest) async -> RPCAnswer {
        guard !request.isCancelled else { return .failure(.rejected) }
        guard Self.isAllowed(origin: request.origin) else { return .failure(.notConnected) }
        switch request.method {
        case "eth_chainId":
            return .success(.string(Self.baseChainHex))
        case "net_version":
            return .success(.string(String(Base.chainID)))
        case "eth_accounts":
            return .success(accounts(for: request.origin))
        case "eth_requestAccounts":
            return await connect(request).map { _ in accounts(for: request.origin) }
        case "wallet_requestPermissions":
            return await connect(request).map { _ in permissions(for: request.origin) }
        case "wallet_getPermissions":
            return .success(permissions(for: request.origin))
        case "wallet_revokePermissions":
            disconnect(request.origin)
            return .success(.null)
        case "wallet_switchEthereumChain":
            guard let chain = request.parameters?[0]?["chainId"]?.string, Self.isBase(chain) else { return .failure(.unknownChain) }
            return .success(.null)
        case "wallet_addEthereumChain":
            guard let chain = request.parameters?[0]?["chainId"]?.string, Self.isBase(chain) else { return .failure(.unknownChain) }
            return .success(.null)
        case "eth_sendTransaction":
            return await sendTransaction(request)
        case "personal_sign":
            return await signPersonal(request)
        case "eth_signTypedData_v4":
            return await signTyped(request)
        case _ where Self.reads.contains(request.method):
            return await read(request)
        default:
            // Including `eth_sign`, which signs a bare hash that could be anything at all, even a transaction.
            return .failure(.unsupported(request.method))
        }
    }

    // MARK: - Answers from the app's window

    /// Doesn't answer until a strong warning has been acknowledged and Touch ID says yes. A cancelled prompt leaves it waiting.
    /// With a prompt, Touch ID asks inside the window that's showing it.
    @discardableResult
    public func approve(_ id: UUID, acknowledged: Bool = false, in prompt: PresencePrompt? = nil) async -> ApprovalResult {
        guard let approval = pending.first(where: { $0.id == id }), !approval.needsAcknowledgment || acknowledged else { return .cancelled }
        if let reason = approval.presenceReason {
            do {
                try await wallet.confirmPresence(reason: reason, in: prompt)
            } catch let error as LAError where [.userCancel, .appCancel, .systemCancel].contains(error.code) {
                return .cancelled
            } catch {
                return .failed(HotWalletWording.touchIDDidNotConfirm)
            }
        }
        guard pending.contains(where: { $0.id == id }) else { return .cancelled }
        // Before it's taken off the list, so the window has something to show the whole way through.
        if approval.presenceReason != nil {
            allWork.append(SiteWork(origin: approval.origin, isTransaction: approval.isTransaction, approval: approval))
        }
        wallet.noteAnswer()
        finish(id, approved: true)
        return .done
    }

    public func dismissFinished() {
        finished = nil
    }

    /// The one on show. If there's another, it's next.
    public func dismissFailure() {
        if !failures.isEmpty { failures.removeFirst() }
    }

    public var nextPromptAt: Date? { wallet.nextPromptAt }

    /// In the main currency when there's a rate, like the rest of the wallet.
    public func money(_ usdMicros: UInt128) -> String {
        wallet.money(usdMicros)
    }

    public func reject(_ id: UUID) {
        guard let approval = pending.first(where: { $0.id == id }) else { return }
        noteRefusal(by: approval.origin)
        wallet.noteAnswer()
        finish(id, approved: false)
    }

    public func rejectAll() {
        for approval in pending { reject(approval.id) }
    }

    /// The site went away: its tab closed, or the browser quit.
    public func cancel(connection: UUID, id: String) {
        let requester = Requester(connection: connection, id: id)
        for request in live where request.requester == requester { request.cancel() }
        for approval in pending where approval.requester == requester {
            noteRefusal(by: approval.origin)
            finish(approval.id, approved: false)
        }
    }

    public func cancelAll(connection: UUID) {
        for request in live where request.requester.connection == connection { request.cancel() }
        for approval in pending where approval.requester.connection == connection {
            noteRefusal(by: approval.origin)
            finish(approval.id, approved: false)
        }
    }

    public func disconnect(_ origin: String) {
        wallet.disconnectSite(origin)
        onAccountsChanged?(origin, [])
    }

    /// The key changed, so sites connected to the old one are told they aren't anymore.
    public func walletChanged() {
        guard wallet.address != lastKnownAddress else { return }
        lastKnownAddress = wallet.address
        let sites = lastKnownSites
        lastKnownSites = wallet.connectedSites
        for origin in sites { onAccountsChanged?(origin, []) }
    }

    /// What the extension's own popup shows. Pages can't reach this: the extension only sends it from its popup.
    public func popupStatus() -> JSONValue {
        var status: [String: JSONValue] = ["appName": .string(SiteWording.appName), "canTopUp": .bool(wallet.canTopUp)]
        if let problem = wallet.siteProblem { status["problem"] = .string(problem.message) }
        if let address = wallet.address { status["address"] = .string(address.checksummed) }
        if let plan = wallet.plan {
            status["value"] = .string(wallet.money(plan.valueUsdMicros))
            status["share"] = .number(min(1, Double(plan.valueUsdMicros) / Double(max(wallet.settings.capUsdMicros, 1))))
            status["over"] = .bool(plan.excessUsdMicros > 0)
        }
        status["cap"] = .string(wallet.capText)
        status["sites"] = .number(Double(wallet.connectedSites.count))
        return .object(status)
    }

    public func requestTopUp() {
        onTopUp?()
    }

    public func requestReceive() {
        onReceive?()
    }

    // MARK: - Requests

    private func accounts(for origin: String) -> JSONValue {
        guard wallet.isConnected(origin), let address = wallet.address else { return .array([]) }
        return .array([.string(address.lowercased)])
    }

    private func permissions(for origin: String) -> JSONValue {
        guard wallet.isConnected(origin), let address = wallet.address else { return .array([]) }
        let restriction: JSONValue = .object(["type": .string("restrictReturnedAccounts"), "value": .array([.string(address.lowercased)])])
        return .array([.object(["parentCapability": .string("eth_accounts"), "invoker": .string(origin), "caveats": .array([restriction])])])
    }

    private func connect(_ request: LiveRequest) async -> RPCAnswer {
        if let problem = wallet.siteProblem { return .failure(problem) }
        if wallet.isConnected(request.origin) { return .success(.null) }
        switch await ask(request, .connect) {
        case .failure(let error): return .failure(error)
        case .success: break
        }
        // It may have been replaced or stopped while this was open.
        if let problem = wallet.siteProblem { return .failure(problem) }
        wallet.connectSite(request.origin)
        lastKnownSites = wallet.connectedSites
        onAccountsChanged?(request.origin, wallet.address.map { [$0.lowercased] } ?? [])
        return .success(.null)
    }

    private func sendTransaction(_ request: LiveRequest) async -> RPCAnswer {
        if let problem = walletProblem(for: request.origin) { return .failure(problem) }
        guard let address = wallet.address else { return .failure(.notConnected) }
        let transaction: SiteTransaction
        let quote: SiteQuote
        do throws(SiteError) {
            transaction = try SiteTransaction(request.parameters, from: address)
        } catch {
            return .failure(error)
        }
        // Before any of it goes to the node, so being turned away costs nothing.
        if let refusal = whyNotAdmitted(request) { return .failure(refusal) }
        guard noteQuote(by: request.origin) else { return .failure(.readLimit) }
        request.isBeingQuoted = true
        do {
            quote = try await wallet.quoteForSite(transaction)
            request.isBeingQuoted = false
        } catch {
            return .failure(Self.siteError(error))
        }
        let review = TransactionReview(transaction, quote: quote)
        if case .failure(let error) = await ask(request, .transaction(review)) { return .failure(error) }
        if let problem = walletProblem(for: request.origin) { return .failure(problem) }
        do {
            return .success(.string(try await wallet.sendForSite(transaction, quote: quote, review: review, origin: request.origin, isWanted: { !request.isCancelled })))
        } catch {
            return .failure(Self.siteError(error))
        }
    }

    private func signPersonal(_ request: LiveRequest) async -> RPCAnswer {
        if let problem = walletProblem(for: request.origin) { return .failure(problem) }
        guard let address = wallet.address else { return .failure(.notConnected) }
        guard let messageText = request.parameters?[0]?.string, let signer = request.parameters?[1]?.string else { return .failure(.invalid("personal_sign needs a message and an address.")) }
        guard EthereumAddress(signer) == address else { return .failure(.notConnected) }
        let bytes: [UInt8]
        if messageText.hasPrefix("0x") {
            guard let decoded = Hex.decode(messageText) else { return .failure(.invalid("That message isn't hex.")) }
            bytes = decoded
        } else {
            bytes = Array(messageText.utf8)
        }
        return await sign(request, MessageReview(personal: bytes, origin: request.origin))
    }

    private func signTyped(_ request: LiveRequest) async -> RPCAnswer {
        if let problem = walletProblem(for: request.origin) { return .failure(problem) }
        guard let address = wallet.address else { return .failure(.notConnected) }
        guard let signer = request.parameters?[0]?.string, let payload = request.parameters?[1] else { return .failure(.invalid("eth_signTypedData_v4 needs an address and data.")) }
        guard EthereumAddress(signer) == address else { return .failure(.notConnected) }
        do throws(TypedData.Failure) {
            let data = try TypedData(payload)
            if let chain = try data.chainID, chain != Base.chainID { return .failure(.wrongChain) }
            return await sign(request, try MessageReview(typed: data))
        } catch {
            guard case .malformed(let reason) = error else { return .failure(.invalid("That data can't be signed.")) }
            return .failure(.invalid(reason))
        }
    }

    private func sign(_ request: LiveRequest, _ review: MessageReview) async -> RPCAnswer {
        if case .failure(let error) = await ask(request, .message(review)) { return .failure(error) }
        if let problem = walletProblem(for: request.origin) { return .failure(problem) }
        do {
            return .success(.string(try await wallet.signForSite(review, origin: request.origin).hex))
        } catch {
            return .failure(Self.siteError(error))
        }
    }

    private func read(_ request: LiveRequest) async -> RPCAnswer {
        let second = Int(now().timeIntervalSince1970)
        if readsThisSecond.second != second { readsThisSecond = (second, 0, [:]) }
        let family = Self.family(of: request.origin)
        guard readsThisSecond.count < Self.readsPerSecond, readsThisSecond.byFamily[family, default: 0] < Self.readsPerSecondPerFamily else { return .failure(.readLimit) }
        readsThisSecond.count += 1
        readsThisSecond.byFamily[family, default: 0] += 1
        do {
            return try await wallet.readForSite(request.method, request.parameters ?? .array([]))
        } catch {
            return .failure(Self.siteError(error))
        }
    }

    /// What really happened, for the site and for the window. Only a network that can't be reached says it can't be reached.
    private static func siteError(_ error: any Error) -> SiteError {
        switch error {
        case is CancellationError: .rejected
        case ChainError.rejected(let message): SiteError(code: -32000, message: message)
        case ChainError.rateLimited: SiteError(code: -32005, message: HotWalletWording.networkBusy)
        case ChainError.unreachable: SiteError(code: 4900, message: HotWalletWording.cantReachChain)
        case ChainError.unreadable: SiteError(code: 4900, message: HotWalletWording.unreadableAnswer)
        default: SiteError(code: -32603, message: "\(couldntSign): \(HotWalletWording.problem(error))")
        }
    }

    /// Anything a site asked to send or sign that didn't happen goes in the log, and in the window if the user had approved it.
    private func finishWork(for request: LiveRequest, with answer: RPCAnswer) {
        let index = allWork.firstIndex { $0.approvalID == request.approvalID }
        let work = index.map { allWork.remove(at: $0) }
        guard Self.signingMethods.contains(request.method) else { return }
        switch answer {
        case .success:
            Self.log.notice("\(request.method, privacy: .public) for \(request.origin, privacy: .public) went through")
            if let work { finished = work }
        case .failure(let error):
            let stage = work == nil ? "before approval" : "after approval"
            Self.log.error("\(request.method, privacy: .public) for \(request.origin, privacy: .public) failed \(stage, privacy: .public): \(error.code, privacy: .public) \(Self.loggableReason(error), privacy: .public)")
            if let work, !request.isCancelled {
                failures.append(SiteFailure(origin: work.origin, isTransaction: work.isTransaction, reason: error.message))
            }
        }
    }

    /// What can go in a log that anyone on this Mac can read. This app's own sentences can, and of what a node said, only which of the
    /// usual refusals it was. A node can repeat a transaction's data in its refusal, or a contract's revert text.
    static func loggableReason(_ error: SiteError) -> String {
        if ownSentences.contains(error.message) { return error.message }
        if error.message.hasPrefix(couldntSign) { return "couldn't sign" }
        let text = error.message.lowercased()
        let prefix = error.message.hasPrefix(HotWalletWording.wouldFail) ? "would fail, " : ""
        if let refusal = usualRefusals.first(where: text.contains) { return "\(prefix)the node said \"\(refusal)\"" }
        return "\(prefix)no details logged"
    }

    private static let couldntSign = "This wallet couldn't sign this"

    private static let ownSentences: Set<String> = [
        HotWalletWording.wrongChain, HotWalletWording.feesLookWrong, HotWalletWording.feesRoseAfterApproval, HotWalletWording.cantReachChain,
        HotWalletWording.unreadableAnswer, HotWalletWording.networkBusy, HotWalletWording.changedWhileWaiting, HotWalletWording.lastOneStillShowingUp,
        HotWalletWording.keyMissing, SiteError.rejected.message, SiteError.notConnected.message, SiteError.wrongChain.message,
    ]

    private static let usualRefusals = [
        "execution reverted", "nonce too low", "nonce too high", "insufficient funds", "underpriced", "already known", "intrinsic gas", "gas limit", "max fee per gas",
    ]

    private func walletProblem(for origin: String) -> SiteError? {
        wallet.siteProblem ?? (wallet.isConnected(origin) ? nil : .notConnected)
    }

    private func ask(_ request: LiveRequest, _ action: SiteApproval.Action) async -> RPCAnswer {
        // Working out what to show takes a while, and the site may be gone by now.
        guard !request.isCancelled else { return .failure(.rejected) }
        if let refusal = whyNotAdmitted(request) { return .failure(refusal) }
        if action == .connect, pending.contains(where: { $0.origin == request.origin && $0.action == .connect }) { return .failure(.tooManyRequests) }

        let approval = SiteApproval(id: UUID(), origin: request.origin, action: action, requester: request.requester)
        request.approvalID = approval.id
        finished = nil
        pending.append(approval)
        let approved = await withCheckedContinuation { waiting[approval.id] = $0 }
        return approved && !request.isCancelled ? .success(.null) : .failure(.rejected)
    }

    /// Why a site can't ask for anything just now, if it can't. Transactions still being priced hold their place, or a site could have any
    /// number of them at the node.
    private func whyNotAdmitted(_ request: LiveRequest) -> SiteError? {
        let family = Self.family(of: request.origin)
        if let until = refusals[family]?.cooldownUntil, until > now() { return .rejected }
        let waiting = pending.map(\.origin) + live.filter(\.isBeingQuoted).map(\.origin)
        guard waiting.count < Self.maxPending, waiting.filter({ Self.family(of: $0) == family }).count < Self.maxPendingPerOrigin else { return .tooManyRequests }
        return nil
    }

    /// False if this site has had all the transactions priced it can for now.
    private func noteQuote(by origin: String) -> Bool {
        let time = now()
        let family = Self.family(of: origin)
        let recent = quotes[family, default: []].filter { $0 > time.addingTimeInterval(-Self.quoteWindow) }
        guard recent.count < Self.quotesPerWindow else {
            quotes[family] = recent
            return false
        }
        quotes[family] = recent + [time]
        return true
    }

    private func noteRefusal(by origin: String) {
        let time = now()
        let family = Self.family(of: origin)
        var record = refusals[family, default: Refusals()]
        record.times = record.times.filter { $0 >= time.addingTimeInterval(-Self.rejectionWindow) } + [time]
        if record.times.count >= Self.rejectionsBeforeCooldown {
            if let until = record.cooldownUntil, until.addingTimeInterval(Self.cooldownsForgottenAfter) < time { record.cooldowns = 0 }
            let doublings = min(record.cooldowns, Self.longestCooldownDoubling)
            record.cooldownUntil = time.addingTimeInterval(Self.rejectionWindow * Double(1 << doublings))
            record.cooldowns += 1
            record.times = []
        }
        refusals[family] = record
    }

    /// What a site's limits count against: its domain, since subdomains cost nothing to make and would each get their own. Without the
    /// whole public suffix list this only knows the usual suffixes below, so anything else counts as one domain. That means `a.net.de` and
    /// `b.net.de`, and sites on one shared host like `vercel.app`, count as one, which is the safe way to be wrong.
    static func family(of origin: String) -> String {
        guard let host = URLComponents(string: origin)?.host?.lowercased() else { return origin }
        let labels = host.split(separator: ".")
        guard labels.count > 2, let last = labels.last, last.contains(where: \.isLetter) else { return host }
        let isPublicSuffix = publicSecondLevels[String(last)]?.contains(String(labels[labels.count - 2])) == true
        return labels.suffix(isPublicSuffix ? 3 : 2).joined(separator: ".")
    }

    /// Each one is in the ICANN part of the public suffix list, as of version 2026-11-04. A name that isn't can be one person's domain,
    /// who then gets a family per subdomain, so only add what's there.
    private static let publicSecondLevels: [String: Set<String>] = [
        "ar": ["com", "edu", "gob", "gov", "int", "mil", "net", "org"],
        "au": ["asn", "com", "edu", "gov", "id", "net", "org"],
        "br": ["com", "edu", "gov", "mil", "net", "org"],
        "cn": ["ac", "com", "edu", "gov", "mil", "net", "org"],
        "hk": ["com", "edu", "gov", "idv", "net", "org"],
        "id": ["ac", "biz", "co", "go", "mil", "my", "net", "or", "sch", "web"],
        "il": ["ac", "co", "gov", "k12", "muni", "net", "org"],
        "in": ["ac", "co", "com", "edu", "gov", "me", "mil", "net", "org", "res"],
        "jp": ["ac", "ad", "co", "ed", "go", "gr", "lg", "ne", "or"],
        "kr": ["ac", "co", "go", "me", "mil", "ne", "or"],
        "mx": ["com", "edu", "gob", "net", "org"],
        "my": ["biz", "com", "edu", "gov", "mil", "name", "net", "org"],
        "nz": ["ac", "co", "geek", "gen", "govt", "iwi", "kiwi", "maori", "mil", "net", "org", "school"],
        "sg": ["com", "edu", "gov", "net", "org"],
        "th": ["ac", "co", "go", "in", "mi", "net", "or"],
        "tr": ["biz", "com", "edu", "gen", "gov", "info", "k12", "mil", "name", "net", "org", "tv", "web"],
        "tw": ["club", "com", "ebiz", "edu", "game", "gov", "idv", "mil", "net", "org"],
        "uk": ["ac", "co", "gov", "ltd", "me", "net", "nhs", "org", "plc", "police"],
        "za": ["ac", "co", "edu", "gov", "law", "mil", "net", "ngo", "nom", "org", "school", "web"],
    ]

    private func finish(_ id: UUID, approved: Bool) {
        pending.removeAll { $0.id == id }
        waiting.removeValue(forKey: id)?.resume(returning: approved)
    }

    /// `sender.origin` from the browser, never from the page. Plain HTTP can be changed by anyone on the network, so only this Mac may use it.
    static func isAllowed(origin: String) -> Bool {
        guard let parts = URLComponents(string: origin), let host = parts.host, !host.isEmpty, parts.path.isEmpty, parts.query == nil, parts.fragment == nil, parts.user == nil, parts.password == nil else { return false }
        switch parts.scheme {
        case "https": return true
        case "http": return host == "localhost" || host == "127.0.0.1"
        default: return false
        }
    }

    private static func isBase(_ chain: String) -> Bool {
        chain.lowercased() == baseChainHex
    }
}

#if DEBUG
extension SiteWork {
    public init(origin: String, isTransaction: Bool, sceneApproval approval: SiteApproval) {
        self.init(origin: origin, isTransaction: isTransaction, approval: approval)
    }
}

extension SiteFailure {
    public init(sceneOrigin origin: String, isTransaction: Bool, reason: String) {
        self.init(origin: origin, isTransaction: isTransaction, reason: reason)
    }
}

extension SiteApproval {
    /// For `macos/shot.sh`. Nothing answers these: the scene's buttons do nothing, and they never reach the bridge or a key.
    /// What a real request becomes, through the same code that reads one.
    public static func sceneTransaction(origin: String, to: EthereumAddress, value: UInt128 = 0, data: [UInt8] = []) -> SiteApproval {
        let quote = SiteQuote(gasLimit: 60000, maxFeePerGas: 10_000_000, feeWei: 3_000_000_000_000, ethUsdMicros: 2_640_000_000, ethBalance: 5_000_000_000_000_000, tokenUsdMicros: 999_800)
        let review = TransactionReview(SiteTransaction(to: to, value: value, data: data), quote: quote)
        return SiteApproval(id: UUID(), origin: origin, action: .transaction(review), requester: Requester(connection: UUID(), id: "scene"))
    }

    public static func sceneMessage(origin: String, text: String) -> SiteApproval {
        SiteApproval(id: UUID(), origin: origin, action: .message(MessageReview(personal: Array(text.utf8), origin: origin)), requester: Requester(connection: UUID(), id: "scene"))
    }

    public static func sceneUnreadableMessage(origin: String) -> SiteApproval {
        SiteApproval(id: UUID(), origin: origin, action: .message(MessageReview(personal: [0xFF, 0x00, 0xDE, 0xAD, 0xBE, 0xEF], origin: origin)), requester: Requester(connection: UUID(), id: "scene"))
    }

    public static func sceneUnlimitedApproval(origin: String, token: EthereumAddress, spender: EthereumAddress) -> SiteApproval {
        let review = TransactionReview(
            headline: "Lets \(SiteWording.address(spender)) spend your USDC, with no limit",
            to: token, toName: "USDC", value: 0, valueUsdMicros: 0, data: [0x09, 0x5e, 0xa7, 0xb3], feeWei: 3_000_000_000_000, feeUsdMicros: 8_000,
            warnings: [SiteWarning(SiteWording.unlimited(spender: SiteWording.address(spender), asset: "USDC"), isStrong: true)],
            symbol: "USDC", decimals: 6, amount: "0", usdMicros: nil, spender: spender
        )
        return SiteApproval(id: UUID(), origin: origin, action: .transaction(review), requester: Requester(connection: UUID(), id: "scene"))
    }
}
#endif
