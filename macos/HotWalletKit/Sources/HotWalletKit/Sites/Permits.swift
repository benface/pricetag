import Foundation
import KeyVault

/// A permit in a common shape, read into what it allows. Anything that doesn't match one exactly, field for field and type for type,
/// isn't read at all, and shows as the raw message it is.
public struct PermitSummary: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// EIP-2612: an allowance set by signature, which never ends once it's used.
        case allowance
        /// Permit2's `PermitSingle`: an allowance on Permit2 that ends on a date.
        case permit2Allowance
        /// Permit2's `PermitTransferFrom`: one transfer, once.
        case permit2Transfer
    }

    public let kind: Kind
    public let token: EthereumAddress
    /// From the token list. Anything else has no name, decimals or price anyone can trust.
    public let tokenSymbol: String?
    public let spender: EthereumAddress
    /// "Unlimited", or the amount to the last digit.
    public let amount: String
    let isUnlimited: Bool
    let isZero: Bool
    /// When what it allows stops, or nil for a transfer, which allows nothing after it.
    public let allowedUntil: String?
    /// The last moment the signature itself can be used.
    public let mustBeUsedBy: String

    /// "Let Uniswap (0x6fF5…2a2a) spend all of your USDC", for a title and Touch ID. Nothing here comes from what a site named things.
    var headline: String {
        let who = SiteWording.who(spender)
        let asset = tokenSymbol ?? "this token"
        if kind == .permit2Transfer { return isUnlimited ? "Let \(who) take all of your \(asset), once" : "Let \(who) take up to \(amount), once" }
        // Only sending the signature changes anything, and whoever has it can choose not to, so this is a request, not a stop.
        if isZero { return "Sign a request to stop \(who) spending your \(asset)" }
        return isUnlimited ? "Let \(who) spend all of your \(asset)" : "Let \(who) spend up to \(amount)"
    }

    /// Past this a date means no end: it's later than anything a calendar shows.
    private static let noEndAfter: UInt64 = 253_402_300_799

    init?(_ data: TypedData, formatDate: (Date) -> String) {
        let message = data.message
        let fields = data.types[data.primaryType]?.map { "\($0.type) \($0.name)" }
        let contract = data.domain["verifyingContract"]?.string.flatMap { EthereumAddress($0) }
        func address(_ value: JSONValue?) -> EthereumAddress? { value?.string.flatMap { EthereumAddress($0) } }

        let token: EthereumAddress
        let spender: EthereumAddress
        let amount: [UInt8]
        switch data.primaryType {
        case "Permit" where fields == ["address owner", "address spender", "uint256 value", "uint256 nonce", "uint256 deadline"]:
            guard let contract, let spenderAddress = address(message["spender"]), let value = message["value"], let deadline = message["deadline"],
                  let word = try? TypedData.integerWord(value, bits: 256, signed: false), let usedBy = Self.date(deadline, formatDate) else { return nil }
            kind = .allowance
            (token, spender, amount) = (contract, spenderAddress, word)
            allowedUntil = Self.noEnd
            mustBeUsedBy = usedBy
        case "PermitSingle" where contract == KnownContracts.permit2 && fields == ["PermitDetails details", "address spender", "uint256 sigDeadline"]
            && data.types["PermitDetails"]?.map({ "\($0.type) \($0.name)" }) == ["address token", "uint160 amount", "uint48 expiration", "uint48 nonce"]:
            let details = message["details"]
            guard let tokenAddress = address(details?["token"]), let spenderAddress = address(message["spender"]), let value = details?["amount"], let expiration = details?["expiration"], let deadline = message["sigDeadline"],
                  let word = try? TypedData.integerWord(value, bits: 160, signed: false), let usedBy = Self.date(deadline, formatDate) else { return nil }
            kind = .permit2Allowance
            (token, spender, amount) = (tokenAddress, spenderAddress, word)
            // Permit2 takes zero to mean the time of the block it's used in, and allows spending until that time has passed. So it
            // holds, up to the amount and as many times as that allows, for the couple of seconds Base takes for a block.
            guard let ends = try? TypedData.integerWord(expiration, bits: 48, signed: false) else { return nil }
            allowedUntil = Self.seconds(ends) == 0 ? "Only the few seconds it's used in" : Self.date(Self.seconds(ends), formatDate)
            mustBeUsedBy = usedBy
        case "PermitTransferFrom" where contract == KnownContracts.permit2 && fields == ["TokenPermissions permitted", "address spender", "uint256 nonce", "uint256 deadline"]
            && data.types["TokenPermissions"]?.map({ "\($0.type) \($0.name)" }) == ["address token", "uint256 amount"]:
            let permitted = message["permitted"]
            guard let tokenAddress = address(permitted?["token"]), let spenderAddress = address(message["spender"]), let value = permitted?["amount"], let deadline = message["deadline"],
                  let word = try? TypedData.integerWord(value, bits: 256, signed: false), let usedBy = Self.date(deadline, formatDate) else { return nil }
            kind = .permit2Transfer
            (token, spender, amount) = (tokenAddress, spenderAddress, word)
            allowedUntil = nil
            mustBeUsedBy = usedBy
        default:
            return nil
        }

        self.token = token
        self.spender = spender
        let known = Base.tokens.first { $0.contract == token }
        tokenSymbol = known?.symbol
        let units = amount.prefix(16).allSatisfy { $0 == 0 } ? amount.suffix(16).reduce(UInt128(0)) { $0 << 8 | UInt128($1) } : nil
        // Permit2's own maximum is 2^160 - 1, which doesn't fit in `units`, and this counts as unlimited too.
        isUnlimited = TransactionReview.isUnlimited(units, of: known)
        isZero = units == 0
        if isUnlimited {
            self.amount = "Unlimited"
        } else if let units, let known {
            self.amount = "\(Money.text(ofUnits: units, decimals: known.decimals)) \(known.symbol)"
        } else {
            self.amount = "\(units ?? 0) units"
        }
    }

    private static let noEnd = "No end date"

    private static func seconds(_ word: [UInt8]) -> UInt64? {
        word.prefix(24).allSatisfy { $0 == 0 } ? word.suffix(8).reduce(UInt64(0)) { $0 << 8 | UInt64($1) } : nil
    }

    private static func date(_ value: JSONValue, _ formatDate: (Date) -> String) -> String? {
        guard let word = try? TypedData.integerWord(value, bits: 256, signed: false) else { return nil }
        return date(seconds(word), formatDate)
    }

    /// Anything too far off for a calendar has no end, as far as anyone alive is concerned.
    private static func date(_ seconds: UInt64?, _ formatDate: (Date) -> String) -> String {
        guard let seconds, seconds <= noEndAfter else { return noEnd }
        return formatDate(Date(timeIntervalSince1970: TimeInterval(seconds)))
    }
}
