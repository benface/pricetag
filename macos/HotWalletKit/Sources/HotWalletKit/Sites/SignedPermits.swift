import Foundation
import KeyVault

/// A note of a permit this device signed for a site, and never the signature, which is all anyone would need to use it.
public struct SignedPermit: Codable, Equatable, Identifiable, Sendable {
    /// What a read of the chain said. Proof that one can't be used anymore isn't here, because then it's no longer kept.
    public enum Check: Equatable, Sendable {
        case notUsed, couldntCheck
    }

    public struct Terms: Codable, Equatable, Sendable {
        public let kind: PermitSummary.Kind
        public let token: EthereumAddress
        public let tokenSymbol: String?
        public let spender: EthereumAddress
        /// "Unlimited", or the amount to the last digit.
        public let amount: String
        /// The last moment it can be used, in seconds, or nil when that never comes.
        public let deadline: UInt64?
        /// As a 32-byte word in hex.
        let nonce: String

        /// For scenes. A real one comes from what the review read.
        public init(kind: PermitSummary.Kind, token: EthereumAddress, tokenSymbol: String?, spender: EthereumAddress, amount: String, deadline: UInt64?, nonce: UInt8 = 0) {
            self.kind = kind
            self.token = token
            self.tokenSymbol = tokenSymbol
            self.spender = spender
            self.amount = amount
            self.deadline = deadline
            self.nonce = Hex.encode(Array(repeating: 0, count: 31) + [nonce])
        }

        init(_ summary: PermitSummary) {
            kind = summary.kind
            token = summary.token
            tokenSymbol = summary.tokenSymbol
            spender = summary.spender
            amount = summary.amount
            deadline = summary.deadline
            nonce = Hex.encode(summary.nonce)
        }
    }

    /// The message's hash, so signing the same one twice is one permit.
    public let id: String
    /// The origin that asked for it.
    public let site: String
    public let signedAt: Date
    /// What it allows, or nil for what only looked like a permit, which is all that's known about those.
    public let terms: Terms?

    public init(id: String, site: String, signedAt: Date, terms: Terms?) {
        self.id = id
        self.site = site
        self.signedAt = signedAt
        self.terms = terms
    }

    /// Nil when it isn't one to keep: anything that doesn't let someone act for this wallet, or a permit for nothing, which can only
    /// ever take an allowance away.
    init?(_ review: MessageReview, site: String, signedAt: Date) {
        guard case .typedData(let domainSeparator, let structHash) = review.signable, review.permit != nil || review.isPermitLike, review.permit?.isZero != true else { return nil }
        self.init(id: Hex.encode(keccak256(domainSeparator + structHash)), site: site, signedAt: signedAt, terms: review.permit.map(Terms.init))
    }

    public func hasExpired(at time: Date) -> Bool {
        guard let deadline = terms?.deadline else { return false }
        return UInt64(max(time.timeIntervalSince1970, 0)) > deadline
    }
}

extension SignedPermit.Terms {
    private var nonceWord: [UInt8]? { Hex.decode(nonce).flatMap { $0.count == 32 ? $0 : nil } }

    /// The contract call that can show whether this is spent. Only Permit2 or a token on the allowlist is asked, because any other
    /// contract can answer whatever it likes, and that isn't proof of anything.
    func read(owner: EthereumAddress) -> (to: EthereumAddress, data: [UInt8])? {
        guard let nonceWord else { return nil }
        switch kind {
        case .allowance:
            guard Base.tokens.contains(where: { $0.contract == token }) else { return nil }
            return (token, Calldata.selector("nonces(address)") + Calldata.word(owner))
        case .permit2Allowance:
            return (Base.permit2, Calldata.selector("allowance(address,address,address)") + Calldata.word(owner) + Calldata.word(token) + Calldata.word(spender))
        case .permit2Transfer:
            // Permit2 keeps these as one bit each: the nonce's last byte is which bit, and the rest is which word.
            return (Base.permit2, Calldata.selector("nonceBitmap(address,uint256)") + Calldata.word(owner) + [0] + nonceWord.dropLast())
        }
    }

    /// What `read`'s answer says, or nil if it isn't an answer. A nonce that's moved past this one means it was used or replaced, and
    /// either way it can't be used now. Anything else doesn't prove that, so it isn't taken to.
    func isSpent(given answer: [UInt8]) -> Bool? {
        guard let nonceWord else { return nil }
        switch kind {
        case .allowance:
            return answer.count == 32 ? nonceWord.lexicographicallyPrecedes(answer) : nil
        case .permit2Allowance:
            // (amount, expiration, nonce)
            return answer.count == 96 ? nonceWord.lexicographicallyPrecedes(answer.suffix(32)) : nil
        case .permit2Transfer:
            guard answer.count == 32, let bit = nonceWord.last else { return nil }
            return answer[31 - Int(bit / 8)] & (1 << (bit % 8)) != 0
        }
    }

    /// Who could use it. Nothing here comes from what a site named things.
    public var who: String { SiteWording.who(spender) }

    /// How to stop this one, in a sentence. Nothing else can: it's already signed, and whoever has it decides when to use it.
    public var howToStop: String {
        let asset = tokenSymbol ?? "this token"
        return switch kind {
        case .allowance:
            "The only way to stop this is to move \(asset) to another of your wallets."
        case .permit2Allowance, .permit2Transfer:
            "To stop this, revoke Permit2's approval for \(asset) in \(HotWalletWording.title)'s Approvals. It only stays stopped while that's revoked: approving Permit2 again lets this work again."
        }
    }
}

extension RPCAnswer {
    var isBaseChainID: Bool {
        guard case .success(let answer) = self else { return false }
        return answer.string?.lowercased() == "0x" + String(Base.chainID, radix: 16)
    }
}
