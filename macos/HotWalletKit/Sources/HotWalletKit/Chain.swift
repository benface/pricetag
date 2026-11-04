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
    public var fees: FeeQuote

    public init(chainID: UInt64, blockNumber: UInt64, nonce: UInt64, balances: [Token: UInt128], ethUsdMicros: UInt128?, usdcUsdMicros: UInt128?, fees: FeeQuote) {
        self.chainID = chainID
        self.blockNumber = blockNumber
        self.nonce = nonce
        self.balances = balances
        self.ethUsdMicros = ethUsdMicros
        self.usdcUsdMicros = usdcUsdMicros
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

    public init(succeeded: Bool) {
        self.succeeded = succeeded
    }
}

public enum ChainError: Error, Equatable {
    /// The node couldn't be reached or sent nonsense. A transaction sent just now may or may not have got through.
    case unreachable
    /// The node looked at the request and refused it, so it's certain nothing happened.
    case rejected(String)
    case unreadable
}

public protocol ChainClient: Sendable {
    func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot
    func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64
    func send(_ transaction: SignedTransaction) async throws
    func receipt(of hash: String) async throws -> Receipt?
}

/// A JSON-RPC node, and every read of one tick in a single batch. It can lie about what it tells us, but all it can get out of
/// that is wasted gas: what's signed only ever goes to the user's own wallets, on this chain.
public struct RPCChainClient: ChainClient {
    private let url: URL
    private let session: URLSession

    public init(url: URL) {
        self.url = url
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.timeoutIntervalForRequest = 15
        session = URLSession(configuration: configuration)
    }

    public func snapshot(of address: EthereumAddress) async throws -> ChainSnapshot {
        let tokens = Base.tokens.filter { !$0.isNative }
        var calls: [(String, [Any])] = [
            ("eth_chainId", []),
            ("eth_getBlockByNumber", ["latest", false]),
            ("eth_getTransactionCount", [address.lowercased, "latest"]),
            ("eth_getBalance", [address.lowercased, "latest"]),
            ("eth_maxPriorityFeePerGas", []),
            call(Base.ethUsdFeed, Calldata.latestRoundData),
            call(Base.usdcUsdFeed, Calldata.latestRoundData),
            call(Base.gasPriceOracle, Calldata.l1Fee(ofPayloadBytes: Calldata.typicalSweepBytes)),
        ]
        calls += tokens.map { call($0.contract!, Calldata.balanceOf(address)) }
        let answers = try await batch(calls)

        // A balance or fee that can't be read fails the whole read, so a failure can't look like an empty wallet.
        let chainID = try Self.quantity(answers[0].get())
        guard let block = try answers[1].get() as? [String: Any], let timestamp = block["timestamp"], let number = block["number"], let baseFee = block["baseFeePerGas"] else { throw ChainError.unreadable }
        let blockTime = try Self.quantity(timestamp)
        var balances: [Token: UInt128] = [Base.eth: try Self.quantity(answers[3].get())]
        for (index, token) in tokens.enumerated() {
            balances[token] = try Self.quantity(answers[8 + index].get())
        }
        let priority = try Self.quantity(answers[4].get())
        let base = try Self.quantity(baseFee)
        let fees = FeeQuote(maxFeePerGas: 2 * base + priority, maxPriorityFeePerGas: priority, l1FeeWei: try Self.quantity(answers[7].get()))
        return ChainSnapshot(
            chainID: UInt64(chainID),
            blockNumber: UInt64(try Self.quantity(number)),
            nonce: UInt64(try Self.quantity(answers[2].get())),
            balances: balances,
            ethUsdMicros: Oracle.price(try? answers[5].get() as? String, feed: .eth, blockTime: blockTime),
            usdcUsdMicros: Oracle.price(try? answers[6].get() as? String, feed: .usdc, blockTime: blockTime),
            fees: fees
        )
    }

    public func estimateGas(from: EthereumAddress, to: EthereumAddress, value: UInt128, data: [UInt8]) async throws -> UInt64 {
        let parameters: [String: Any] = ["from": from.lowercased, "to": to.lowercased, "value": "0x" + String(value, radix: 16), "data": "0x" + Hex.encode(data)]
        return UInt64(try Self.quantity(try await single("eth_estimateGas", [parameters])))
    }

    public func send(_ transaction: SignedTransaction) async throws {
        _ = try await single("eth_sendRawTransaction", [transaction.rawHex])
    }

    public func receipt(of hash: String) async throws -> Receipt? {
        guard let receipt = try await single("eth_getTransactionReceipt", [hash]) as? [String: Any] else { return nil }
        guard let status = receipt["status"] else { throw ChainError.unreadable }
        return Receipt(succeeded: try Self.quantity(status) == 1)
    }

    private func call(_ to: EthereumAddress, _ data: [UInt8]) -> (String, [Any]) {
        ("eth_call", [["to": to.lowercased, "data": "0x" + Hex.encode(data)], "latest"])
    }

    private func single(_ method: String, _ parameters: [Any]) async throws -> Any? {
        try await batch([(method, parameters)])[0].get()
    }

    private func batch(_ calls: [(String, [Any])]) async throws -> [Result<Any?, ChainError>] {
        let body = calls.enumerated().map { index, call in
            ["jsonrpc": "2.0", "id": index, "method": call.0, "params": call.1] as [String: Any]
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let data: Data
        do {
            (data, _) = try await session.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch {
            throw ChainError.unreachable
        }
        guard let answers = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { throw ChainError.unreachable }
        var results = [Result<Any?, ChainError>](repeating: .failure(.unreadable), count: calls.count)
        for answer in answers {
            guard let id = answer["id"] as? Int, results.indices.contains(id) else { continue }
            if let error = answer["error"] as? [String: Any] {
                results[id] = .failure(.rejected(error["message"] as? String ?? "The node refused this."))
            } else {
                let result = answer["result"]
                results[id] = .success(result is NSNull ? nil : result)
            }
        }
        return results
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

/// Reads a Chainlink answer. This is the same pair of feeds the dataset uses, read directly, so the safety loop doesn't need our server.
enum Oracle {
    enum Feed {
        case eth, usdc

        /// Past each feed's heartbeat with room to spare. Older than this and the price is gone rather than old.
        var maxAgeSeconds: UInt128 {
            switch self {
            case .eth: 3600
            case .usdc: 26 * 3600
            }
        }

        /// The same bounds as `sanity` in `src/core/tokens.ts`.
        var plausibleUsd: ClosedRange<UInt128> {
            switch self {
            case .eth: 100 * Money.dollar...100_000 * Money.dollar
            case .usdc: 800_000...1_200_000
            }
        }
    }

    /// `latestRoundData()`: (roundId, answer, startedAt, updatedAt, answeredInRound), with answers in 1e8 USD.
    static func price(_ result: String?, feed: Feed, blockTime: UInt128) -> UInt128? {
        guard let result, let bytes = Hex.decode(result), bytes.count == 160 else { return nil }
        let word: (Int) -> UInt128? = { index in
            let slice = bytes[(index * 32)..<((index + 1) * 32)]
            guard slice.prefix(16).allSatisfy({ $0 == 0 }) else { return nil }
            return slice.suffix(16).reduce(UInt128(0)) { $0 << 8 | UInt128($1) }
        }
        guard let answer = word(1), let updatedAt = word(3), updatedAt <= blockTime, blockTime - updatedAt <= feed.maxAgeSeconds else { return nil }
        let micros = answer / 100
        return feed.plausibleUsd.contains(micros) ? micros : nil
    }
}

public enum Calldata {
    private static func selector(_ signature: String) -> [UInt8] {
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
        let padded = (count + 31) / 32 * 32
        // Non-zero and varied, so this doesn't compress better than a real transaction would.
        let payload = (0..<padded).map { UInt8(truncatingIfNeeded: $0 &* 167 &+ 1) | 1 }
        return selector("getL1Fee(bytes)") + word(32) + word(UInt128(count)) + payload
    }
}
