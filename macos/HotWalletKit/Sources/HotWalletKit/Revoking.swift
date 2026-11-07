import Foundation
import KeyVault
import PricetagKit

/// Taking back one approval this wallet gave. Each only ever sets what's allowed to nothing, so it can't give anything away.
public struct Revocation: Equatable, Hashable, Sendable, Identifiable {
    public enum Kind: Sendable {
        /// `approve(spender, 0)` on the token.
        case token
        /// Permit2's `lockdown`, which sets its own allowance to nothing.
        case permit2
    }

    public let kind: Kind
    /// The token.
    public let token: EthereumAddress
    public let spender: EthereumAddress
    /// What it's about, for the review and the record: a tracked token's symbol, or a short address.
    public let label: String
    /// Whose contract the spender is, when the server knows. It's only shown beside the address, because a name proves nothing.
    public let spenderName: String?

    public init(kind: Kind, token: EthereumAddress, spender: EthereumAddress, label: String, spenderName: String? = nil) {
        self.kind = kind
        self.token = token
        self.spender = spender
        self.label = label
        self.spenderName = spenderName
    }

    public var id: String { "\(kind):\(token.lowercased):\(spender.lowercased)" }

    /// Only a token on the allowlist, or Permit2, is ever called. Any other contract could do anything.
    public var isAllowed: Bool {
        switch kind {
        case .token: Base.tokens.contains { $0.contract == token }
        case .permit2: true
        }
    }
}

extension Revocation {
    /// From what the server found, which can be anything a contract emitted. Nil when it isn't something this can revoke, which
    /// includes anything that would call a contract off the allowlist, and so every collection.
    public init?(_ approval: TokenApproval) {
        guard let token = EthereumAddress(approval.token), let spender = EthereumAddress(approval.spender), token != .zero, spender != .zero else { return nil }
        let kind: Kind
        switch approval.kind {
        case .token: kind = .token
        case .permit2: kind = .permit2
        case .collection: return nil
        }
        self.init(kind: kind, token: token, spender: spender, label: approval.symbol ?? Format.shortHash(token.checksummed), spenderName: approval.spenderName)
        guard isAllowed else { return nil }
    }
}

/// One transaction a revocation sends.
public struct RevocationTransaction: Equatable, Sendable {
    public let to: EthereumAddress
    public let data: [UInt8]
    public let revocations: [Revocation]
}

public enum RevocationPlanner {
    /// The most at once, so one Touch ID can't send an endless list, and the fee stays small.
    public static let maximum = 20

    /// One transaction for each token, and one for everything Permit2 holds, since it takes them all together.
    public static func transactions(for revocations: [Revocation]) -> [RevocationTransaction] {
        var seen = Set<String>()
        let unique = revocations.filter { seen.insert($0.id).inserted }
        var transactions = unique.filter { $0.kind != .permit2 }.map { revocation in
            RevocationTransaction(
                to: revocation.token,
                data: Calldata.approve(revocation.spender, amount: 0),
                revocations: [revocation]
            )
        }
        let permit2 = unique.filter { $0.kind == .permit2 }
        if !permit2.isEmpty {
            transactions.append(RevocationTransaction(to: Base.permit2, data: Calldata.lockdown(permit2.map { ($0.token, $0.spender) }), revocations: permit2))
        }
        return transactions
    }
}

/// What revoking would cost right now, read just before it's shown. What's signed is estimated again, like any send.
public struct RevocationQuote: Equatable, Sendable {
    public let feeWei: UInt128
    public let feeUsdMicros: UInt128?
    public let transactions: Int

    public init(feeWei: UInt128, feeUsdMicros: UInt128?, transactions: Int) {
        self.feeWei = feeWei
        self.feeUsdMicros = feeUsdMicros
        self.transactions = transactions
    }
}

extension Calldata {
    static func approve(_ spender: EthereumAddress, amount: UInt128) -> [UInt8] {
        selector("approve(address,uint256)") + word(spender) + word(amount)
    }

    /// Permit2's `lockdown((address token, address spender)[])`.
    static func lockdown(_ pairs: [(token: EthereumAddress, spender: EthereumAddress)]) -> [UInt8] {
        selector("lockdown((address,address)[])") + word(32) + word(UInt128(pairs.count)) + pairs.flatMap { word($0.token) + word($0.spender) }
    }
}
