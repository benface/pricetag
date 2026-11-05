import Foundation
import KeyVault
import PricetagKit

/// What a site asked to sign, in words, with what the user should worry about.
public struct SiteWarning: Equatable, Identifiable, Sendable {
    public let text: String
    /// Scams rely on these, so approving takes saying so first. Rejecting is always one click.
    public let isStrong: Bool
    public var id: String { text }

    init(_ text: String, isStrong: Bool = false) {
        self.text = text
        self.isStrong = isStrong
    }
}

public enum SiteWording {
    /// The extension shows this name too, and a test keeps them and `App.xcconfig` the same.
    public static let appName = "Patina"

    static func address(_ address: EthereumAddress) -> String {
        let text = address.checksummed
        return "\(text.prefix(6))…\(text.suffix(4))"
    }

    static func unlimited(spender: String, asset: String) -> String {
        "This lets \(spender) take all of your \(asset), now or at any time later, without asking again. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    static func typedPermit(spender: String?) -> String {
        "This signature lets \(spender ?? "someone else") spend your tokens or act for you, with no transaction and no fee, so you won't see it happen. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    static let unreadableMessage = "This can't be read as text, so there's no way to know what it would be used for. Scams rely on this."
    static let anyChain = "This signature isn't tied to a network, so it could be used anywhere, not just on Base."
    static let burn = "This sends to the zero address, where nothing can ever be recovered."
    static let unreadableCall = "This app can't read what this contract call does. All it can tell you is the ETH it sends."
    static let notEnoughEth = "This wallet doesn't hold enough ETH for this and its fee, so it will probably fail. Top up first."

    static func signInForOtherSite(_ domain: String) -> String {
        "This signs you in to \(domain), which isn't the site asking. Scams rely on this."
    }
}

/// A transaction a site asked for, checked but not yet priced.
public struct SiteTransaction: Equatable, Sendable {
    public let to: EthereumAddress
    public let value: UInt128
    public let data: [UInt8]

    init(_ parameters: JSONValue?, from wallet: EthereumAddress) throws(SiteError) {
        guard let transaction = parameters?[0], transaction.object != nil else { throw .invalid("This needs a transaction.") }
        // Sites can only ever act as the hot wallet, whatever address they name.
        guard let fromText = transaction["from"]?.string, let from = EthereumAddress(fromText), from == wallet else { throw .notConnected }
        if let chain = transaction["chainId"], chain != .null {
            guard (try? TypedData.integerWord(chain, bits: 256, signed: false)) == Self.baseWord else { throw .wrongChain }
        }
        // An authorization hands the whole account over to a contract, which nothing here can show safely.
        if transaction["authorizationList"] != nil { throw .unsupported("authorization lists") }
        guard let toText = transaction["to"]?.string else { throw .unsupported("creating contracts") }
        guard let to = EthereumAddress(toText) else { throw .invalid("That destination isn't an address.") }
        self.to = to

        let valueWord: [UInt8]
        do {
            valueWord = try TypedData.integerWord(transaction["value"] ?? .string("0x0"), bits: 128, signed: false)
        } catch {
            throw .invalid("That value isn't a number this wallet can send.")
        }
        value = valueWord.suffix(16).reduce(UInt128(0)) { $0 << 8 | UInt128($1) }

        let dataText = transaction["data"]?.string
        let inputText = transaction["input"]?.string
        if let dataText, let inputText, dataText.lowercased() != inputText.lowercased() { throw .invalid("data and input disagree.") }
        guard let bytes = Hex.decode(dataText ?? inputText ?? "0x") else { throw .invalid("That data isn't hex.") }
        data = bytes
    }

    public init(to: EthereumAddress, value: UInt128, data: [UInt8]) {
        self.to = to
        self.value = value
        self.data = data
    }

    private static let baseWord = [UInt8](repeating: 0, count: 30) + [0x21, 0x05]
}

/// Enough to say what a transaction costs. Its gas and fee per gas are limits that what's signed keeps to. `feeWei` also has the L1 data
/// fee, which the chain charges on top at whatever L1 costs when it lands, so nothing can cap it and the total is an estimate.
public struct SiteQuote: Equatable, Sendable {
    public let gasLimit: UInt64
    public let maxFeePerGas: UInt128
    public let feeWei: UInt128
    public let ethUsdMicros: UInt128?
    public let ethBalance: UInt128
}

public struct TransactionReview: Equatable, Sendable {
    public let headline: String
    public let to: EthereumAddress
    /// The token's symbol, when the destination is one this app knows.
    public let toName: String?
    public let value: UInt128
    public let valueUsdMicros: UInt128?
    public let data: [UInt8]
    public let feeWei: UInt128
    public let feeUsdMicros: UInt128?
    public let warnings: [SiteWarning]
    /// What it's written down as in this app's records.
    let symbol: String
    let decimals: Int
    let amount: String
    let usdMicros: String?
}

extension TransactionReview {
    /// Past this it's unlimited in practice: no token anyone holds has that many units, and it covers the maximums in common use.
    private static let unlimitedAt: UInt128 = 1 << 96

    private enum Selectors {
        static let transfer = Calldata.selector("transfer(address,uint256)")
        static let approve = Calldata.selector("approve(address,uint256)")
        static let increaseAllowance = Calldata.selector("increaseAllowance(address,uint256)")
        static let setApprovalForAll = Calldata.selector("setApprovalForAll(address,bool)")
        static let permit2Approve = Calldata.selector("approve(address,address,uint160,uint48)")
        static let permit = Calldata.selector("permit(address,address,uint256,uint256,uint8,bytes32,bytes32)")
    }

    private struct Arguments {
        let bytes: ArraySlice<UInt8>

        func address(_ index: Int) -> EthereumAddress? {
            guard let word = word(index), word.prefix(12).allSatisfy({ $0 == 0 }) else { return nil }
            return EthereumAddress(Hex.encode(word.suffix(20)).prefixedAsHex)
        }

        /// nil if it doesn't fit, which for an amount means far more than anything's worth.
        func amount(_ index: Int) -> UInt128? {
            guard let word = word(index), word.prefix(16).allSatisfy({ $0 == 0 }) else { return nil }
            return word.suffix(16).reduce(UInt128(0)) { $0 << 8 | UInt128($1) }
        }

        func word(_ index: Int) -> ArraySlice<UInt8>? {
            let start = bytes.startIndex + index * 32
            guard start + 32 <= bytes.endIndex else { return nil }
            return bytes[start..<(start + 32)]
        }
    }

    init(_ transaction: SiteTransaction, quote: SiteQuote) {
        let token = Base.tokens.first { $0.contract == transaction.to }
        let selector = Array(transaction.data.prefix(4))
        let arguments = Arguments(bytes: transaction.data.dropFirst(4))
        var warnings: [SiteWarning] = []
        var headline: String?
        var recorded: (symbol: String, decimals: Int, amount: UInt128)?

        func asset(_ token: Token?) -> String { token?.symbol ?? "this token" }
        func amountText(_ amount: UInt128, _ token: Token?) -> String {
            token.map { "\(Money.text(ofUnits: amount, decimals: $0.decimals)) \($0.symbol)" } ?? "\(amount) units of this token"
        }

        switch selector {
        case Selectors.transfer:
            if let recipient = arguments.address(0), let amount = arguments.amount(1) {
                headline = "Send \(amountText(amount, token)) to \(SiteWording.address(recipient))"
                if let token { recorded = (token.symbol, token.decimals, amount) }
            }
        case Selectors.increaseAllowance:
            // This adds to whatever's already allowed, which nothing here has read. So it can't say what the total comes to, and adding nothing doesn't stop anything.
            if let spender = arguments.address(0).map(SiteWording.address) {
                let amount = arguments.amount(1)
                if amount == 0 {
                    headline = "Add nothing to what \(spender) can spend of your \(asset(token))"
                } else if let amount, amount < Self.unlimitedAt {
                    headline = "Let \(spender) spend \(amountText(amount, token)) more"
                } else {
                    headline = "Let \(spender) spend all of your \(asset(token))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token)), isStrong: true))
                }
            }
        case Selectors.approve:
            if let spender = arguments.address(0).map(SiteWording.address) {
                let amount = arguments.amount(1)
                if amount == 0 {
                    headline = "Stop \(spender) from spending your \(asset(token))"
                } else if let amount, amount < Self.unlimitedAt {
                    headline = "Let \(spender) spend up to \(amountText(amount, token))"
                } else {
                    headline = "Let \(spender) spend all of your \(asset(token))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token)), isStrong: true))
                }
            }
        case Selectors.permit2Approve:
            if let spender = arguments.address(1).map(SiteWording.address) {
                let approved = arguments.address(0).flatMap { address in Base.tokens.first { $0.contract == address } }
                let amount = arguments.amount(2)
                if amount == 0 {
                    headline = "Stop \(spender) from spending your \(asset(approved))"
                } else if let amount, amount < Self.unlimitedAt {
                    headline = "Let \(spender) spend up to \(amountText(amount, approved))"
                } else {
                    headline = "Let \(spender) spend all of your \(asset(approved))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(approved)), isStrong: true))
                }
            }
        case Selectors.setApprovalForAll:
            if let spender = arguments.address(0).map(SiteWording.address), let flag = arguments.amount(1) {
                if flag == 0 {
                    headline = "Stop \(spender) from moving your items in this collection"
                } else {
                    headline = "Let \(spender) move every item you hold in this collection"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: "items in this collection"), isStrong: true))
                }
            }
        case Selectors.permit:
            if let spender = arguments.address(1).map(SiteWording.address) {
                headline = "Let \(spender) spend your \(asset(token))"
                warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token)), isStrong: true))
            }
        default:
            break
        }

        if transaction.data.isEmpty {
            headline = "Send \(Money.text(ofUnits: transaction.value, decimals: 18)) ETH to \(SiteWording.address(transaction.to))"
        }
        if headline == nil {
            headline = transaction.value > 0 ? "Send \(Money.text(ofUnits: transaction.value, decimals: 18)) ETH in a contract call" : "Make a contract call"
            warnings.append(SiteWarning(SiteWording.unreadableCall))
        }
        if transaction.to == .zero { warnings.append(SiteWarning(SiteWording.burn, isStrong: true)) }
        if transaction.value + quote.feeWei > quote.ethBalance { warnings.append(SiteWarning(SiteWording.notEnoughEth)) }

        let valueUsd = quote.ethUsdMicros.map { Money.usdMicros(of: transaction.value, priceMicros: $0, decimals: 18) }
        self.init(
            headline: headline ?? "",
            to: transaction.to,
            toName: token?.symbol,
            value: transaction.value,
            valueUsdMicros: valueUsd,
            data: transaction.data,
            feeWei: quote.feeWei,
            feeUsdMicros: quote.ethUsdMicros.map { Money.usdMicros(of: quote.feeWei, priceMicros: $0, decimals: 18) },
            warnings: warnings.sorted { $0.isStrong && !$1.isStrong },
            symbol: recorded?.symbol ?? "ETH",
            decimals: recorded?.decimals ?? 18,
            amount: String(recorded?.amount ?? transaction.value),
            usdMicros: recorded == nil ? valueUsd.map { String($0) } : nil
        )
    }
}

private extension String {
    var prefixedAsHex: String { "0x" + self }
}

public struct MessageReview: Equatable, Sendable {
    public let headline: String
    public let body: String
    /// The contract the signature is for, when it names one.
    public let contract: EthereumAddress?
    public let warnings: [SiteWarning]
    let signable: SignableMessage
}

extension MessageReview {
    /// `personal_sign`: the message as text when it is text. A line that says otherwise can't hide in the hex, because it's shown as hex.
    init(personal bytes: [UInt8], origin: String) {
        var warnings: [SiteWarning] = []
        let body: String
        if let text = String(validating: bytes, as: UTF8.self), text.unicodeScalars.allSatisfy(Self.isPlainlyVisible) {
            body = text
            if let domain = Self.signInDomain(text), domain != URL(string: origin)?.hostAndPort {
                warnings.append(SiteWarning(SiteWording.signInForOtherSite(domain), isStrong: true))
            }
        } else {
            body = "0x" + Hex.encode(bytes)
            warnings.append(SiteWarning(SiteWording.unreadableMessage, isStrong: true))
        }
        self.init(headline: "Sign this message", body: body, contract: nil, warnings: warnings, signable: .personal(bytes))
    }

    init(typed data: TypedData) throws(TypedData.Failure) {
        var warnings: [SiteWarning] = []
        let contract = data.domain["verifyingContract"]?.string.flatMap { EthereumAddress($0) }
        if try data.chainID == nil { warnings.append(SiteWarning(SiteWording.anyChain, isStrong: true)) }
        let spender = Self.firstValue(of: ["spender", "operator", "delegate", "taker"], in: data.message)?.string.flatMap { EthereumAddress($0) }.map(SiteWording.address)
        if Self.looksLikeAPermit(data) { warnings.insert(SiteWarning(SiteWording.typedPermit(spender: spender), isStrong: true), at: 0) }
        self.init(headline: "Sign \(data.domain["name"]?.string.map { "this for \($0)" } ?? "this data")", body: Self.pretty(data.message, indent: 0), contract: contract, warnings: warnings, signable: try data.signable())
    }

    /// Line breaks are fine. Direction overrides, zero-width characters and the like can make a message read as something it isn't.
    private static func isPlainlyVisible(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar.properties.generalCategory {
        case .control: scalar == "\n" || scalar == "\t" || scalar == "\r"
        case .format, .privateUse, .surrogate, .unassigned: false
        default: true
        }
    }

    /// The domain of a Sign-In with Ethereum message, which is its first line.
    private static func signInDomain(_ text: String) -> String? {
        let suffix = " wants you to sign in with your Ethereum account:"
        guard let line = text.split(separator: "\n", omittingEmptySubsequences: false).first, line.hasSuffix(suffix) else { return nil }
        return String(line.dropLast(suffix.count))
    }

    /// Permits, orders and delegations all let someone act for this wallet later, on the strength of one signature.
    private static func looksLikeAPermit(_ data: TypedData) -> Bool {
        let name = data.primaryType.lowercased()
        if ["permit", "approv", "allowance", "order", "delegat", "authoriz"].contains(where: name.contains) { return true }
        return firstValue(of: ["spender", "operator", "delegate", "taker"], in: data.message) != nil
    }

    private static func firstValue(of keys: [String], in value: JSONValue) -> JSONValue? {
        switch value {
        case .object(let object):
            for key in keys {
                if let found = object[key] { return found }
            }
            for key in object.keys.sorted() {
                if let found = object[key].flatMap({ firstValue(of: keys, in: $0) }) { return found }
            }
            return nil
        case .array(let items):
            return items.lazy.compactMap { firstValue(of: keys, in: $0) }.first
        default:
            return nil
        }
    }

    private static func pretty(_ value: JSONValue, indent: Int) -> String {
        let padding = String(repeating: "  ", count: indent)
        switch value {
        case .object(let object):
            return object.keys.sorted().map { key in
                let child = object[key] ?? .null
                switch child {
                case .object, .array: return "\(padding)\(key):\n\(pretty(child, indent: indent + 1))"
                default: return "\(padding)\(key): \(pretty(child, indent: 0))"
                }
            }.joined(separator: "\n")
        case .array(let items):
            return items.map { pretty($0, indent: indent) }.joined(separator: "\n")
        case .string(let text): return text
        case .number(let number): return number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : String(number)
        case .bool(let flag): return flag ? "true" : "false"
        case .null: return "nothing"
        }
    }
}

private extension URL {
    var hostAndPort: String? {
        guard let host = host(percentEncoded: false) else { return nil }
        return port.map { "\(host):\($0)" } ?? host
    }
}
