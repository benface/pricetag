import Foundation
import KeyVault

/// What a contract call this app can't read would do to this wallet, if it ran right now. It's never a promise: the node is trusted for
/// the answer, and a contract can behave differently when it really runs. So it only ever adds to what's shown, and never takes away a
/// strong warning.
public struct CallPreview: Equatable, Sendable {
    public enum Asset: Equatable, Sendable {
        case known(ReviewAmount)
        /// Anything off the allowlist, which has no name, decimals or price anyone can trust. A scam token can call itself USDC.
        case unknown(contract: EthereumAddress)
    }

    /// Someone who'd be allowed to spend from this wallet afterward.
    public struct Allowance: Equatable, Sendable {
        public let spender: EthereumAddress
        /// As in "to spend all of your USDC".
        public let words: String
        /// What it's for when that's off the allowlist, which has no name to go by.
        public let unknownContract: EthereumAddress?
        public let isCollection: Bool
        /// As in "take all of your USDC", when it's unlimited.
        let asset: String
        let isUnlimited: Bool
    }

    public let gives: [Asset]
    public let gets: [Asset]
    public let allowances: [Allowance]

    var movesUnknownToken: Bool {
        (gives + gets).contains { if case .unknown = $0 { true } else { false } }
    }

    /// What this would do in words, when it's simple enough to say. It never goes further than the rows below it, and it says
    /// "about" because it's an estimate. nil when it isn't clear, including when it would also let someone spend, which the rows and
    /// warnings say on their own.
    var title: String? {
        guard allowances.isEmpty else { return nil }
        func words(_ asset: Asset) -> String? {
            if case .known(let amount) = asset { "\(amount.text) \(amount.symbol)" } else { nil }
        }
        guard gives.count <= 1, gets.count <= 1 else { return nil }
        let given = gives.first.map(words)
        let gotten = gets.first.map(words)
        switch (given, gotten) {
        case (.some(.some(let given)), .some(.some(let gotten))): return "Swap \(given) for about \(gotten)"
        case (.some(.some(let given)), nil): return "Send about \(given)"
        case (nil, .some(.some(let gotten))): return "Get about \(gotten)"
        default: return nil
        }
    }
}

/// What a node's `eth_simulateV1` says happened to one wallet. Anything it can't read means no answer at all, because leaving out what
/// leaves a wallet is worse than saying nothing. Only the contract that emitted a log decides what it's about, and that can't be faked.
struct CallSimulation {
    static let method = "eth_simulateV1"
    /// Where a node says plain ETH moved, as if it were a token. Nothing can emit a log from here.
    private static let ethTraces = EthereumAddress("0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee")!
    private static let weth = Base.tokens.first { $0.symbol == "WETH" }

    private static let transfer = topic("Transfer(address,address,uint256)")
    private static let transferSingle = topic("TransferSingle(address,address,address,uint256,uint256)")
    private static let transferBatch = topic("TransferBatch(address,address,address,uint256[],uint256[])")
    private static let approval = topic("Approval(address,address,uint256)")
    private static let approvalForAll = topic("ApprovalForAll(address,address,bool)")
    /// Wrapping and unwrapping say this instead of `Transfer`.
    private static let deposit = topic("Deposit(address,uint256)")
    private static let withdrawal = topic("Withdrawal(address,uint256)")

    private static func topic(_ signature: String) -> String {
        "0x" + Hex.encode(keccak256(Array(signature.utf8)))
    }

    /// The transaction that would be signed, with its real nonce and fees. Without fees a contract could see a gas price of zero, which only ever happens in a simulation.
    static func parameters(_ transaction: SiteTransaction, from: EthereumAddress, nonce: UInt64, gasLimit: UInt64, fees: FeeQuote) -> JSONValue {
        func quantity(_ value: UInt128) -> JSONValue { .string("0x" + String(value, radix: 16)) }
        let call: [String: JSONValue] = [
            "from": .string(from.lowercased),
            "to": .string(transaction.to.lowercased),
            "value": quantity(transaction.value),
            "data": .string("0x" + Hex.encode(transaction.data)),
            "nonce": quantity(UInt128(nonce)),
            "gas": quantity(UInt128(gasLimit)),
            "maxFeePerGas": quantity(fees.maxFeePerGas),
            "maxPriorityFeePerGas": quantity(fees.maxPriorityFeePerGas),
        ]
        let block: JSONValue = .object(["calls": .array([.object(call)])])
        return .array([.object(["blockStateCalls": .array([block]), "traceTransfers": .bool(true), "validation": .bool(true)]), .string("latest")])
    }

    private struct Grant {
        enum Kind: Equatable {
            /// nil if it doesn't fit, which means unlimited.
            case amount(UInt128?, Token?)
            /// An item has one approved spender at a time, whoever that was before.
            case item(id: String)
            case everyItem
        }

        let contract: EthereumAddress
        let spender: EthereumAddress
        let kind: Kind

        /// Whether this is the same permission as `other`, which a later log takes the place of.
        func isSamePermission(as other: Grant) -> Bool {
            guard contract == other.contract else { return false }
            switch (kind, other.kind) {
            case (.item(let id), .item(let otherID)): return id == otherID
            case (.amount, .amount), (.everyItem, .everyItem): return spender == other.spender
            default: return false
            }
        }
    }

    let blockTime: UInt128?
    private var gained: [Token: UInt128] = [:]
    private var spent: [Token: UInt128] = [:]
    private var unknownGiven: [EthereumAddress] = []
    private var unknownGotten: [EthereumAddress] = []
    private var grants: [Grant] = []

    /// nil if the call failed or the answer isn't clear. `value` is what the transaction sends, which a node that honors `traceTransfers` always reports.
    init?(_ result: JSONValue, wallet: EthereumAddress, value: UInt128) {
        guard let calls = result[0]?["calls"]?.array, calls.count == 1, let call = calls.first, (try? RPCChainClient.quantity(call["status"]?.string)) == 1, let logs = call["logs"]?.array else { return nil }
        blockTime = try? RPCChainClient.quantity(result[0]?["timestamp"]?.string)
        for log in logs {
            guard read(log, wallet: wallet) else { return nil }
        }
        // Otherwise it isn't reporting ETH at all, and what it says about the rest would be half the story.
        if value > 0, spent[Base.eth, default: 0] < value { return nil }
    }

    /// False if this is a kind of log that matters, and it doesn't say what it should.
    private mutating func read(_ log: JSONValue, wallet: EthereumAddress) -> Bool {
        guard let addressText = log["address"]?.string, let contract = EthereumAddress(addressText.lowercased()), let topicValues = log["topics"]?.array, let dataText = log["data"]?.string, let data = Hex.decode(dataText) else { return false }
        let topics = topicValues.compactMap { $0.string?.lowercased() }
        guard topics.count == topicValues.count else { return false }
        guard let kind = topics.first else { return true }
        let token = contract == Self.ethTraces ? Base.eth : Base.tokens.first { $0.contract == contract }

        switch kind {
        case Self.transfer:
            guard topics.count == 3 || (topics.count == 4 && token == nil), let from = Self.address(topics[1]), let to = Self.address(topics[2]) else { return false }
            guard topics.count == 3 else {
                // Moving an item ends what was approved for it, and not every collection logs that.
                grants.removeAll { $0.contract == contract && $0.kind == .item(id: topics[3]) }
                return moveUnknown(contract, from: from, to: to, wallet: wallet)
            }
            guard data.count == 32 else { return false }
            if let token {
                guard let amount = Self.amount(data) else { return false }
                return move(token, amount, from: from, to: to, wallet: wallet)
            }
            // Dust that says it came from a wallet, which is how addresses get poisoned. Nothing moved.
            return data.allSatisfy { $0 == 0 } || moveUnknown(contract, from: from, to: to, wallet: wallet)
        case Self.transferSingle, Self.transferBatch:
            guard topics.count == 4, token == nil, let from = Self.address(topics[2]), let to = Self.address(topics[3]) else { return false }
            return moveUnknown(contract, from: from, to: to, wallet: wallet)
        case Self.deposit, Self.withdrawal:
            guard contract == Self.weth?.contract, let token, topics.count == 2, let account = Self.address(topics[1]), account == wallet, data.count == 32 else { return true }
            guard let amount = Self.amount(data) else { return false }
            return kind == Self.deposit ? add(amount, to: &gained, token) : add(amount, to: &spent, token)
        case Self.approval:
            guard topics.count == 3 || (topics.count == 4 && token == nil), let owner = Self.address(topics[1]), let spender = Self.address(topics[2]) else { return false }
            guard owner == wallet else { return true }
            if topics.count == 4 {
                note(Grant(contract: contract, spender: spender, kind: .item(id: topics[3])), isCleared: spender == .zero)
                return true
            }
            guard data.count == 32 else { return false }
            note(Grant(contract: contract, spender: spender, kind: .amount(Self.amount(data), token)), isCleared: data.allSatisfy { $0 == 0 })
            return true
        case Self.approvalForAll:
            guard topics.count == 3, token == nil, let owner = Self.address(topics[1]), let spender = Self.address(topics[2]), data.count == 32 else { return false }
            guard owner == wallet else { return true }
            note(Grant(contract: contract, spender: spender, kind: .everyItem), isCleared: data.allSatisfy { $0 == 0 })
            return true
        default:
            return true
        }
    }

    private mutating func move(_ token: Token, _ amount: UInt128, from: EthereumAddress, to: EthereumAddress, wallet: EthereumAddress) -> Bool {
        if from == to { return true }
        if from == wallet { return add(amount, to: &spent, token) }
        if to == wallet { return add(amount, to: &gained, token) }
        return true
    }

    private mutating func moveUnknown(_ contract: EthereumAddress, from: EthereumAddress, to: EthereumAddress, wallet: EthereumAddress) -> Bool {
        if from == to { return true }
        if from == wallet, !unknownGiven.contains(contract) { unknownGiven.append(contract) }
        if to == wallet, !unknownGotten.contains(contract) { unknownGotten.append(contract) }
        return true
    }

    private func add(_ amount: UInt128, to totals: inout [Token: UInt128], _ token: Token) -> Bool {
        let (total, overflowed) = totals[token, default: 0].addingReportingOverflow(amount)
        totals[token] = total
        return !overflowed
    }

    /// The latest one is what's left when it's all over.
    private mutating func note(_ grant: Grant, isCleared: Bool) {
        grants.removeAll { $0.isSamePermission(as: grant) }
        if !isCleared { grants.append(grant) }
    }

    /// Allowlisted tokens this moves, whatever direction, so their prices can be found.
    var tokens: [Token] {
        Base.tokens.filter { gained[$0] != nil || spent[$0] != nil }
    }

    func preview(price: (Token) -> UInt128?) -> CallPreview {
        func amount(_ units: UInt128, _ token: Token) -> CallPreview.Asset {
            .known(ReviewAmount(text: Money.text(ofUnits: units, decimals: token.decimals), symbol: token.symbol, usdMicros: price(token).map { Money.usdMicros(of: units, priceMicros: $0, decimals: token.decimals) }))
        }
        var gives: [CallPreview.Asset] = []
        var gets: [CallPreview.Asset] = []
        for token in tokens {
            let gained = gained[token, default: 0]
            let spent = spent[token, default: 0]
            if spent > gained { gives.append(amount(spent - gained, token)) }
            if gained > spent { gets.append(amount(gained - spent, token)) }
        }
        return CallPreview(
            gives: gives + unknownGiven.map { .unknown(contract: $0) },
            gets: gets + unknownGotten.map { .unknown(contract: $0) },
            allowances: allowances
        )
    }

    private var allowances: [CallPreview.Allowance] {
        var result: [CallPreview.Allowance] = []
        var countedItems: Set<[EthereumAddress]> = []
        for grant in grants {
            let contractText = SiteWording.address(grant.contract)
            switch grant.kind {
            case .everyItem:
                result.append(CallPreview.Allowance(spender: grant.spender, words: "every item you hold in this collection", unknownContract: grant.contract, isCollection: true, asset: "items in the collection at \(contractText)", isUnlimited: true))
            case .item:
                // Items in one collection for one spender go together, however many.
                guard countedItems.insert([grant.contract, grant.spender]).inserted else { continue }
                let count = grants.count { other in
                    if case .item = other.kind { other.contract == grant.contract && other.spender == grant.spender } else { false }
                }
                result.append(CallPreview.Allowance(spender: grant.spender, words: count == 1 ? "one item you hold" : "\(count) items you hold", unknownContract: grant.contract, isCollection: true, asset: "items in the collection at \(contractText)", isUnlimited: false))
            case .amount(let amount, let token):
                let name = token?.symbol ?? "a token this app doesn't know"
                let asset = token?.symbol ?? "tokens at \(contractText)"
                let isUnlimited = TransactionReview.isUnlimited(amount, of: token)
                let words: String
                if isUnlimited {
                    words = token == nil ? "all of \(name)" : "all of your \(name)"
                } else if let token, let amount {
                    words = "up to \(Money.text(ofUnits: amount, decimals: token.decimals)) \(token.symbol)"
                } else {
                    words = "some of \(name)"
                }
                result.append(CallPreview.Allowance(spender: grant.spender, words: words, unknownContract: token == nil ? grant.contract : nil, isCollection: false, asset: asset, isUnlimited: isUnlimited))
            }
        }
        return result
    }

    private static func address(_ topic: String) -> EthereumAddress? {
        guard let bytes = Hex.decode(topic), bytes.count == 32, bytes.prefix(12).allSatisfy({ $0 == 0 }) else { return nil }
        return EthereumAddress("0x" + Hex.encode(bytes.suffix(20)))
    }

    /// nil if it doesn't fit, which for an allowlisted token means something's wrong, and for an allowance means unlimited.
    private static func amount(_ word: [UInt8]) -> UInt128? {
        word.count == 32 ? word.uint128 : nil
    }
}
