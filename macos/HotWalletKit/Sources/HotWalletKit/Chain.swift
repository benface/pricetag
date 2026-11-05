import Foundation
import KeyVault

/// What the chain says about the wallet right now. It comes straight from an RPC rather than from Amp's history, which only
/// knows what moved in the blocks it read.
public struct ChainSnapshot: Equatable, Sendable {
    public var chainID: UInt64
    public var blockNumber: UInt64
    public var nonce: UInt64
    public var balances: [Token: UInt128]
    /// nil when the feed couldn't be read, is old, or says something implausible. It's never replaced with a guess.
    public var ethUsdMicros: UInt128?
    public var usdcUsdMicros: UInt128?
    /// The rest of the allowlist by asset, for tokens the wallet holds. The same rule: a price that's missing here is no price.
    public var otherUsdMicros: [String: UInt128]
    public var fees: FeeQuote

    public init(chainID: UInt64, blockNumber: UInt64, nonce: UInt64, balances: [Token: UInt128], ethUsdMicros: UInt128?, usdcUsdMicros: UInt128?, otherUsdMicros: [String: UInt128] = [:], fees: FeeQuote) {
        self.chainID = chainID
        self.blockNumber = blockNumber
        self.nonce = nonce
        self.balances = balances
        self.ethUsdMicros = ethUsdMicros
        self.usdcUsdMicros = usdcUsdMicros
        self.otherUsdMicros = otherUsdMicros
        self.fees = fees
    }
}

public struct FeeQuote: Equatable, Sendable {
    /// Plenty for what an allowlisted token's transfer uses. Only for planning: what's signed uses an estimate from the node.
    public static let tokenTransferGas: UInt128 = 100_000
    public static let ethTransferGas: UInt128 = 21000

    public var maxFeePerGas: UInt128
    public var maxPriorityFeePerGas: UInt128
    /// What the L1 data for one sweep costs, on top of gas. It moves with L1's gas price, so plans allow twice this.
    public var l1FeeWei: UInt128
    /// Base charges a tiny fraction of this. A node quoting more is wrong or lying, and signing would burn what's here as fees.
    public static let highestPlausibleFeePerGas: UInt128 = 100_000_000_000

    public var isPlausible: Bool {
        maxFeePerGas <= Self.highestPlausibleFeePerGas
    }

    public init(maxFeePerGas: UInt128, maxPriorityFeePerGas: UInt128, l1FeeWei: UInt128) {
        self.maxFeePerGas = maxFeePerGas
        self.maxPriorityFeePerGas = maxPriorityFeePerGas
        self.l1FeeWei = l1FeeWei
    }

    public func costWei(gas: UInt128) -> UInt128 {
        gas * maxFeePerGas + 2 * l1FeeWei
    }

    public func costWei(of token: Token) -> UInt128 {
        costWei(gas: token.isNative ? Self.ethTransferGas : Self.tokenTransferGas)
    }
}

public struct Receipt: Equatable, Sendable {
    public let succeeded: Bool
    /// Balances read from before this block don't reflect the transaction yet.
    public let blockNumber: UInt64

    public init(succeeded: Bool, blockNumber: UInt64) {
        self.succeeded = succeeded
        self.blockNumber = blockNumber
    }
}

public enum ChainError: Error, Equatable {
    /// The node couldn't be reached or sent nonsense. A transaction sent just now may or may not have got through.
    case unreachable
    /// The node looked at the request and refused it, so it's certain nothing happened.
    case rejected(String)
    case unreadable
    /// The node wouldn't look at the request, however long this waited, so it's certain nothing happened.
    case rateLimited

    /// Whether asking again could go differently. Only for reads and for what hasn't been signed.
    var isWorthRetrying: Bool {
        self == .unreachable || self == .unreadable || self == .rateLimited
    }
}

/// Holds calls back so they don't go over a node's limit. The public node allows 25 a second per IP, and counts each call in a batch.
/// One read of the wallet is about 20, so with a site's reads on top of that, some of them used to get refused.
actor NodePacer {
    /// At most 23 in any one second, which leaves a little for anything else on this network, like the server.
    static let publicNode = NodePacer(callsPerSecond: 15, burst: 8)

    /// The most calls to send at once. A bigger batch goes in pieces.
    nonisolated let burst: Int
    private let callsPerSecond: Int
    private var available: Double
    private var updated = ContinuousClock.now

    init(callsPerSecond: Int, burst: Int) {
        self.callsPerSecond = callsPerSecond
        self.burst = burst
        available = Double(burst)
    }

    /// Returns when these calls can go. Whoever asks first goes first, because what's short is owed by whoever comes next.
    func wait(forCalls count: Int) async throws {
        let now = ContinuousClock.now
        let elapsed = updated.duration(to: now) / .seconds(1)
        available = min(Double(burst), available + elapsed * Double(callsPerSecond))
        updated = now
        available -= Double(count)
        if available < 0 { try await Task.sleep(for: .seconds(-available / Double(callsPerSecond))) }
    }
}

public protocol ChainClient: Sendable {
    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64
    func send(_ transaction: SignedTransaction) async throws
    func receipt(of hash: String) async throws -> Receipt?
    /// Passes a read a site asked for on to the node, with the node's own answer, including why a call reverted.
    func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer
    /// What the chain would charge for this transaction's L1 data right now, on top of its gas.
    func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128
}

/// A JSON-RPC node, and every read of one tick in a single batch. It can lie about what it tells us, but all it can get out of
/// that is wasted gas: what's signed only ever goes to the user's own wallets, on this chain.
public struct RPCChainClient: ChainClient {
    private let url: URL
    private let session: URLSession
    private let pacer: NodePacer?
    private let retryDelays: [Duration]

    public init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        // A node someone chose has its own limits, which this hears about if it goes past them.
        self.init(url: url, session: URLSession(configuration: configuration), pacer: url == Base.publicRPC ? .publicNode : nil)
    }

    init(url: URL, session: URLSession, pacer: NodePacer?, retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(3), .seconds(4)]) {
        self.url = url
        self.session = session
        self.pacer = pacer
        self.retryDelays = retryDelays
    }

    public func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot {
        let tokens = Base.tokens.filter { !$0.isNative }
        guard let block = try await single("eth_getBlockByNumber", ["latest", false]) as? [String: Any], let timestamp = block["timestamp"], let number = block["number"] as? String, let baseFee = block["baseFeePerGas"] else { throw ChainError.unreadable }
        // Everything at this one block, so a balance can't be from before a transaction whose receipt is from after it.
        var calls: [(String, [Any])] = [
            ("eth_chainId", []),
            ("eth_blockNumber", []),
            ("eth_getTransactionCount", [address.lowercased, number]),
            ("eth_getBalance", [address.lowercased, number]),
            ("eth_maxPriorityFeePerGas", []),
            call(Base.ethUsdFeed, Calldata.latestRoundData, at: number),
            call(Base.usdcUsdFeed, Calldata.latestRoundData, at: number),
            call(Base.gasPriceOracle, Calldata.l1Fee(ofPayloadBytes: Calldata.typicalSweepBytes), at: number),
        ]
        calls += tokens.map { call($0.contract!, Calldata.balanceOf(address), at: number) }
        let answers = try await batch(calls)

        // A balance or fee that can't be read fails the whole read, so a failure can't look like an empty wallet.
        let chainID = try Self.quantity(answers[0].get())
        let blockTime = try Self.quantity(timestamp)
        var balances: [Token: UInt128] = [Base.eth: try Self.quantity(answers[3].get())]
        for (index, token) in tokens.enumerated() {
            balances[token] = try Self.quantity(answers[8 + index].get())
        }
        let priority = try Self.quantity(answers[4].get())
        let base = try Self.quantity(baseFee)
        let fees = FeeQuote(maxFeePerGas: 2 * base + priority, maxPriorityFeePerGas: priority, l1FeeWei: try Self.quantity(answers[7].get()))
        let ethUsdMicros = Oracle.price(try? answers[5].get() as? String, feed: .eth, blockTime: blockTime)

        // Only what's held, because the public node limits calls and most wallets hold few of these. Still at the same block.
        let held = Oracle.others.filter { asset, _ in tokens.contains { $0.asset == asset && balances[$0, default: 0] > 0 } }.sorted { $0.key < $1.key }
        var otherUsdMicros: [String: UInt128] = [:]
        if !held.isEmpty {
            let rounds = try await batch(held.map { call($0.value.address, Calldata.latestRoundData, at: number) })
            for (entry, round) in zip(held, rounds) {
                otherUsdMicros[entry.key] = Oracle.price(try? round.get() as? String, feed: entry.value, blockTime: blockTime, ethUsdMicros: ethUsdMicros)
            }
        }

        return ChainSnapshot(
            chainID: UInt64(chainID),
            blockNumber: UInt64(try Self.quantity(number)),
            nonce: UInt64(try Self.quantity(answers[2].get())),
            balances: balances,
            ethUsdMicros: ethUsdMicros,
            usdcUsdMicros: Oracle.price(try? answers[6].get() as? String, feed: .usdc, blockTime: blockTime),
            otherUsdMicros: otherUsdMicros,
            fees: fees
        )
    }

    public func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        let parameters: [String: Any] = ["from": from.lowercased, "to": to.lowercased, "value": "0x" + String(value, radix: 16), "data": "0x" + Hex.encode(data)]
        return UInt64(try Self.quantity(try await single("eth_estimateGas", [parameters])))
    }

    public func send(_ transaction: SignedTransaction) async throws {
        do {
            _ = try await single("eth_sendRawTransaction", [transaction.rawHex])
        } catch ChainError.unreadable {
            // It answered, but not about this. That says nothing about whether it took the transaction.
            throw ChainError.unreachable
        }
    }

    public func receipt(of hash: String) async throws -> Receipt? {
        guard let receipt = try await single("eth_getTransactionReceipt", [hash]) as? [String: Any] else { return nil }
        // A node can say a transaction is in a block without having a block number for it yet, which isn't settled.
        guard let status = receipt["status"], let block = receipt["blockNumber"], !(block is NSNull) else { return nil }
        return Receipt(succeeded: try Self.quantity(status) == 1, blockNumber: UInt64(try Self.quantity(block)))
    }

    public func l1Fee(ofPayload payload: [UInt8]) async throws -> UInt128 {
        let (method, parameters) = call(Base.gasPriceOracle, Calldata.l1Fee(ofPayload: payload), at: "latest")
        return try Self.quantity(try await single(method, parameters))
    }

    public func read(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer {
        let body = try JSONEncoder().encode(JSONValue.object(["jsonrpc": .string("2.0"), "id": .number(1), "method": .string(method), "params": parameters]))
        for attempt in 0...retryDelays.count {
            if attempt > 0 { try await Task.sleep(for: retryDelays[attempt - 1]) }
            try await pacer?.wait(forCalls: 1)
            let (data, status) = try await post(body)
            guard case .object(let answer)? = try? JSONDecoder().decode(JSONValue.self, from: data) else {
                if status == 429 { continue }
                throw ChainError.unreachable
            }
            if status == 429 || Self.isRateLimit(code: answer["code"]?.integer, message: answer["message"]?.string) { continue }
            if case .object(let error)? = answer["error"] {
                let code = error["code"]?.integer
                let message = error["message"]?.string
                if Self.isRateLimit(code: code, message: message) { continue }
                return .failure(SiteError(code: code ?? -32603, message: message ?? "The node refused this.", data: error["data"]))
            }
            guard let result = answer["result"] else { throw ChainError.unreachable }
            return .success(result)
        }
        throw ChainError.rateLimited
    }

    private func call(_ to: EthereumAddress, _ data: [UInt8], at block: String) -> (String, [Any]) {
        ("eth_call", [["to": to.lowercased, "data": "0x" + Hex.encode(data)], block])
    }

    private func single(_ method: String, _ parameters: [Any]) async throws -> Any? {
        try await batch([(method, parameters)])[0].get()
    }

    /// Asks again for whatever the node wouldn't answer yet, since it didn't look at those at all. Even a signed transaction is
    /// safe to send twice, because it's one transaction however many times it's sent.
    private func batch(_ calls: [(String, [Any])]) async throws -> [Result<Any?, ChainError>] {
        var results = [Result<Any?, ChainError>](repeating: .failure(.unreadable), count: calls.count)
        var remaining = Array(calls.indices)
        for attempt in 0...retryDelays.count {
            if attempt > 0 { try await Task.sleep(for: retryDelays[attempt - 1]) }
            let size = pacer?.burst ?? remaining.count
            var refused: [Int] = []
            for start in stride(from: 0, to: remaining.count, by: size) {
                let piece = Array(remaining[start..<min(start + size, remaining.count)])
                try await pacer?.wait(forCalls: piece.count)
                refused += try await ask(piece, of: calls, into: &results)
            }
            remaining = refused
            if remaining.isEmpty { break }
        }
        return results
    }

    /// Returns which of these the node wouldn't answer because of its rate limit. It can say so for the whole batch or for each call in it.
    private func ask(_ indices: [Int], of calls: [(String, [Any])], into results: inout [Result<Any?, ChainError>]) async throws -> [Int] {
        // An earlier refusal says nothing about this attempt. If this one gets no answer, that's all that's known.
        for index in indices { results[index] = .failure(.unreadable) }
        let body = indices.map { index in
            ["jsonrpc": "2.0", "id": index, "method": calls[index].0, "params": calls[index].1] as [String: Any]
        }
        let (data, status) = try await post(try JSONSerialization.data(withJSONObject: body))
        let parsed = try? JSONSerialization.jsonObject(with: data)
        guard status != 429, let answers = parsed as? [[String: Any]] else {
            let refusal = parsed as? [String: Any]
            guard status == 429 || Self.isRateLimit(code: refusal?["code"] as? Int, message: refusal?["message"] as? String) else { throw ChainError.unreachable }
            for index in indices { results[index] = .failure(.rateLimited) }
            return indices
        }
        var limited: [Int] = []
        for answer in answers {
            guard let id = answer["id"] as? Int, results.indices.contains(id) else { continue }
            if let error = answer["error"] as? [String: Any] {
                if Self.isRateLimit(code: error["code"] as? Int, message: error["message"] as? String) {
                    results[id] = .failure(.rateLimited)
                    limited.append(id)
                } else {
                    results[id] = .failure(.rejected(error["message"] as? String ?? "The node refused this."))
                }
            } else {
                let result = answer["result"]
                results[id] = .success(result is NSNull ? nil : result)
            }
        }
        return limited
    }

    private func post(_ body: Data) async throws -> (Data, Int) {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = body
        do {
            let (data, response) = try await session.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 200)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw ChainError.unreachable
        }
    }

    /// The public node says `-32007` and "25/second request limit reached", inside an HTTP 200 when it's about part of a batch.
    static func isRateLimit(code: Int?, message: String?) -> Bool {
        if code == -32007 || code == -32029 || code == 429 { return true }
        let text = message?.lowercased() ?? ""
        return text.contains("rate limit") || text.contains("request limit") || text.contains("too many requests")
    }

    /// A hex number, up to what a UInt128 holds. An allowlisted token's balance can't get near that, so more means something's wrong.
    static func quantity(_ value: Any?) throws -> UInt128 {
        guard let text = value as? String, text.hasPrefix("0x") else { throw ChainError.unreadable }
        let digits = text.dropFirst(2).drop { $0 == "0" }
        if digits.isEmpty { return 0 }
        guard let number = UInt128(digits, radix: 16) else { throw ChainError.unreadable }
        return number
    }
}

/// Reads a Chainlink answer straight from the chain, so the safety loop doesn't need our server. ETH and USDC are the feeds the
/// dataset uses. The server reads the rest for current prices too.
enum Oracle {
    struct Feed: Sendable {
        /// Past each feed's heartbeat with room to spare. Older than this and the price is gone rather than old.
        static let shortHeartbeat: UInt128 = 3600
        static let dailyHeartbeat: UInt128 = 26 * 3600

        /// The same bounds as `sanity` in `src/core/tokens.ts`.
        enum Plausible: Equatable, Sendable {
            /// In micros.
            case usd(ClosedRange<UInt128>)
            /// In thousandths of an ETH.
            case eth(ClosedRange<UInt128>)
        }

        let address: EthereumAddress
        /// What `description()` says onchain, which `AnvilTests` checks.
        let description: String
        let decimals: Int
        /// The answer is in ETH rather than USD, so it's only as good as ETH's price.
        let answersInEth: Bool
        let maxAgeSeconds: UInt128
        let plausible: Plausible

        init(_ address: String, _ description: String, decimals: Int = 8, answersInEth: Bool = false, maxAgeSeconds: UInt128, plausible: Plausible) {
            self.address = EthereumAddress(address)!
            self.description = description
            self.decimals = decimals
            self.answersInEth = answersInEth
            self.maxAgeSeconds = maxAgeSeconds
            self.plausible = plausible
        }

        static let eth = Feed(Base.ethUsdFeed.lowercased, "ETH / USD", maxAgeSeconds: shortHeartbeat, plausible: .usd(100 * Money.dollar...100_000 * Money.dollar))
        static let usdc = Feed(Base.usdcUsdFeed.lowercased, "USDC / USD", maxAgeSeconds: dailyHeartbeat, plausible: .usd(800_000...1_200_000))
    }

    /// Every other asset on the allowlist. It's `TOKEN_FEEDS` in `packages/sdk/src/tokens.ts`, and a test compares the two.
    static let others: [String: Feed] = [
        "USDT": Feed("0xf19d560eb8d2adf07bd6d13ed03e1d11215721f9", "USDT / USD", maxAgeSeconds: Feed.dailyHeartbeat, plausible: .usd(800_000...1_200_000)),
        "DAI": Feed("0x591e79239a7d679378ec8c847e5038150364c78f", "DAI / USD", maxAgeSeconds: Feed.dailyHeartbeat, plausible: .usd(800_000...1_200_000)),
        "cbETH": Feed("0xd7818272b9e248357d13057aab0b417af31e817d", "CBETH / USD", maxAgeSeconds: Feed.shortHeartbeat, plausible: .eth(800...1600)),
        // There's no USD feed for this one on Base.
        "wstETH": Feed("0x43a5c292a453a3bf3606fa856197f09d7b74251a", "WSTETH / ETH", decimals: 18, answersInEth: true, maxAgeSeconds: Feed.dailyHeartbeat, plausible: .eth(800...1600)),
        "cbBTC": Feed("0x07da0e54543a844a80abe69c8a12f22b3aa59f9d", "cbBTC / USD", maxAgeSeconds: Feed.shortHeartbeat, plausible: .eth(5000...200_000)),
        "AERO": Feed("0x4ec5970fc728c5f65ba413992cd5ff6fd70fcff0", "AERO / USD", maxAgeSeconds: Feed.dailyHeartbeat, plausible: .usd(1000...1000 * Money.dollar)),
        "VIRTUAL": Feed("0xeaf310161c9ef7c813a14f8fef6fb271434019f7", "VIRTUAL / USD", maxAgeSeconds: Feed.dailyHeartbeat, plausible: .usd(1000...1000 * Money.dollar)),
        "DEGEN": Feed("0xe62bce5d7cb9d16ab8b4d622538bc0a50a5799c2", "DEGEN / USD", maxAgeSeconds: Feed.dailyHeartbeat, plausible: .usd(10...100 * Money.dollar)),
    ]

    /// `latestRoundData()`: (roundId, answer, startedAt, updatedAt, answeredInRound). A feed whose answer or bounds are in ETH has no price without ETH's.
    static func price(_ result: String?, feed: Feed, blockTime: UInt128, ethUsdMicros: UInt128? = nil) -> UInt128? {
        guard let result, let bytes = Hex.decode(result), bytes.count == 160 else { return nil }
        let word: (Int) -> UInt128? = { index in
            let slice = bytes[(index * 32)..<((index + 1) * 32)]
            guard slice.prefix(16).allSatisfy({ $0 == 0 }) else { return nil }
            return slice.suffix(16).reduce(UInt128(0)) { $0 << 8 | UInt128($1) }
        }
        guard let answer = word(1), let updatedAt = word(3), updatedAt <= blockTime, blockTime - updatedAt <= feed.maxAgeSeconds else { return nil }
        guard let unit = feed.answersInEth ? ethUsdMicros : Money.dollar else { return nil }
        let micros = Money.usdMicros(of: answer, priceMicros: unit, decimals: feed.decimals)
        switch feed.plausible {
        case let .usd(range):
            return range.contains(micros) ? micros : nil
        case let .eth(thousandths):
            guard let ethUsdMicros else { return nil }
            let lowest = Money.usdMicros(of: thousandths.lowerBound, priceMicros: ethUsdMicros, decimals: 3)
            let highest = Money.usdMicros(of: thousandths.upperBound, priceMicros: ethUsdMicros, decimals: 3)
            return (lowest...highest).contains(micros) ? micros : nil
        }
    }
}

public enum Calldata {
    static func selector(_ signature: String) -> [UInt8] {
        Array(keccak256(Array(signature.utf8)).prefix(4))
    }

    private static func word(_ value: UInt128) -> [UInt8] {
        var bytes = [UInt8](repeating: 0, count: 32)
        for index in 0..<16 {
            bytes[31 - index] = UInt8(truncatingIfNeeded: value >> UInt128(index * 8))
        }
        return bytes
    }

    private static func word(_ address: EthereumAddress) -> [UInt8] {
        [UInt8](repeating: 0, count: 12) + address.bytes
    }

    public static func transfer(to: EthereumAddress, amount: UInt128) -> [UInt8] {
        selector("transfer(address,uint256)") + word(to) + word(amount)
    }

    static func balanceOf(_ owner: EthereumAddress) -> [UInt8] {
        selector("balanceOf(address)") + word(owner)
    }

    static let latestRoundData = selector("latestRoundData()")

    /// About a signed transfer of a token. Any bytes do, since the fee only depends on how many there are and how they compress.
    static let typicalSweepBytes = 180

    static func l1Fee(ofPayloadBytes count: Int) -> [UInt8] {
        // Non-zero and varied, so this doesn't compress better than a real transaction would.
        l1Fee(ofPayload: (0..<count).map { UInt8(truncatingIfNeeded: $0 &* 167 &+ 1) | 1 })
    }

    static func l1Fee(ofPayload payload: [UInt8]) -> [UInt8] {
        let padding = (32 - payload.count % 32) % 32
        return selector("getL1Fee(bytes)") + word(32) + word(UInt128(payload.count)) + payload + [UInt8](repeating: 0, count: padding)
    }
}
