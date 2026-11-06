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

    /// An address in a sentence, with its name beside it when it's one this app knows, and never in place of it.
    static func who(_ address: EthereumAddress) -> String {
        KnownContracts.name(of: address).map { "\($0) (\(Self.address(address)))" } ?? Self.address(address)
    }

    /// What a contract row says above the address when it isn't on the list.
    public static let unknownContract = "Unknown contract"
    /// The same for a spender, which could be anyone.
    public static let unknownAddress = "Unknown address"
    /// When neither the call nor its estimate says clearly what it does.
    static let unclear = "It's not clear what this does"

    static func unlimited(spender: String, asset: String) -> String {
        "This lets \(spender) take all of your \(asset), now or at any time later, without asking again. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    /// One warning however many, so a call can't push everything else off the screen with them. The rows say which they are.
    static func unlimited(count: Int) -> String {
        "This lets others take all of \(count) different tokens or collections, now or at any time later, without asking again. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    static func typedPermit(spender: String?) -> String {
        "This signature lets \(spender ?? "someone else") spend your tokens or act for you, with no transaction and no fee, so you won't see it happen. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    /// For a token off the list, whose decimals can't be trusted, so no amount says how much of it someone holds.
    static func unknownAllowance(spender: String?) -> String {
        "This lets \(spender ?? "someone else") spend a token this app doesn't know, and there's no telling how much of it that comes to. Scams rely on this. Only approve it if you trust this site and meant to do this."
    }

    static let typedUnclear = "This app can't tell what this signature allows. It could let someone spend your tokens or act for you, with no transaction and no fee, so you won't see it happen. Scams rely on this. Only approve it if you trust this site and meant to do this."
    static let hiddenCharacters = "This has characters that change how it reads, shown here as codes, so it may not say what it seems to. Scams rely on this."

    /// A permit for nothing takes effect only when someone sends it, and the site can just keep it.
    static func removalIsOnlyARequest(spender: String) -> String {
        "Signing this doesn't stop anything by itself. It only takes effect if it's sent, so whatever \(spender) can spend now, it still can until then."
    }

    static let unreadableMessage = "This can't be read as text, so there's no way to know what it would be used for. Scams rely on this."
    static let anyChain = "This signature isn't tied to a network, so it could be used anywhere, not just on Base."
    static let burn = "This sends to an address nobody controls, where nothing can ever be recovered."
    static let unreadableCall = "This app can't tell what this does. All it can tell you is the ETH it sends."
    static let previewIsAnEstimate = "This is only an estimate of what would happen if it ran right now. It can do something else when it really runs."
    static let previewHasUnknownToken = "This moves a token this app doesn't know, so there's no telling how much of it, or what it's worth."
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
    /// When the destination is a token this app has a price for.
    public var tokenUsdMicros: UInt128?
    /// When this is a call nothing else can read, and the node could say what it would do.
    public var preview: CallPreview?
}

/// Something leaving this wallet, to the last digit.
public struct ReviewAmount: Equatable, Sendable {
    public let text: String
    public let symbol: String
    public let usdMicros: UInt128?
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
    /// Who gets a transfer, which for a token isn't `to`, the token's own contract.
    public var recipient: EthereumAddress?
    /// Who's being allowed to spend.
    public var spender: EthereumAddress?
    /// What leaves, when that's something this app can read. Otherwise the headline is all there is to say.
    public var moved: ReviewAmount?
    /// What a call this app can't read would do, as an estimate.
    public var preview: CallPreview?
    /// Whether all there is to say about this is what the node can work out.
    public var isUnreadableCall = false

    /// What the window says this does. For a call this app can't read, that's the estimate's words when it's clear, and plainly
    /// that it isn't otherwise. Touch ID only ever gets `headline`, which says nothing an estimate came up with.
    public var title: String {
        guard isUnreadableCall else { return headline }
        return preview?.title ?? SiteWording.unclear
    }

    /// Any ETH that goes along with what `moved` or the headline already says.
    public var alsoSendsEth: Bool { value > 0 && moved?.symbol != "ETH" }

    /// What it does, for a sentence that goes on to say who's asking.
    var promptWords: String {
        let words = headline.lowercasedFirst
        return alsoSendsEth ? "\(words) and send \(Money.text(ofUnits: value, decimals: 18)) ETH" : words
    }
}

extension String {
    var lowercasedFirst: String { prefix(1).lowercased() + dropFirst() }
}

extension TransactionReview {
    /// Whole tokens from which an allowance is unlimited in practice, whatever it says: a billion dollars or so, or about what exists.
    /// Nobody allows that on purpose, and a guess that's too low only costs acknowledging a warning.
    private static let unlimitedWholeTokens: [String: UInt128] = [
        "WETH": 1_000_000, "cbETH": 1_000_000, "wstETH": 1_000_000, "cbBTC": 100_000,
        "USDC": 1_000_000_000, "USDT": 1_000_000_000, "DAI": 1_000_000_000,
        "AERO": 1_000_000_000, "VIRTUAL": 1_000_000_000, "DEGEN": 10_000_000_000,
    ]

    /// For a token off the list, in units, because it can have any decimals. It covers the maximums in common use. Less than this
    /// says how many units and gets `SiteWording.unknownAllowance`.
    private static let unlimitedUnits: UInt128 = 1 << 96

    /// nil is an amount that doesn't fit, which is far more than anything's worth.
    static func isUnlimited(_ amount: UInt128?, of token: Token?) -> Bool {
        guard let amount else { return true }
        guard let token, let whole = unlimitedWholeTokens[token.symbol] else { return amount >= unlimitedUnits }
        return amount >= (0..<token.decimals).reduce(whole) { units, _ in units * 10 }
    }

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

    /// What a call to a contract off the list says it would allow. That contract can do anything at all whatever its selector says, so
    /// these words are never the title, and only ever warn: one that asks like an approval could well be one, and a preview can be wrong.
    private static func claimedAllowance(selector: [UInt8], arguments: Arguments, contract: EthereumAddress) -> SiteWarning? {
        let contractText = SiteWording.address(contract)
        func tokens(spender: EthereumAddress?, amount: UInt128?) -> SiteWarning? {
            guard let spender = spender.map(SiteWording.who), amount != 0 else { return nil }
            let text = isUnlimited(amount, of: nil) ? SiteWording.unlimited(spender: spender, asset: "tokens at \(contractText)") : SiteWording.unknownAllowance(spender: spender)
            return SiteWarning(text, isStrong: true)
        }
        switch selector {
        case Selectors.approve, Selectors.increaseAllowance:
            return tokens(spender: arguments.address(0), amount: arguments.amount(1))
        case Selectors.permit2Approve:
            return tokens(spender: arguments.address(1), amount: arguments.amount(2))
        case Selectors.permit:
            return tokens(spender: arguments.address(1), amount: nil)
        case Selectors.setApprovalForAll:
            guard let spender = arguments.address(0).map(SiteWording.who), arguments.amount(1) != 0 else { return nil }
            return SiteWarning(SiteWording.unlimited(spender: spender, asset: "items in the collection at \(contractText)"), isStrong: true)
        default:
            return nil
        }
    }

    init(_ transaction: SiteTransaction, quote: SiteQuote) {
        let token = Base.tokens.first { $0.contract == transaction.to }
        let selector = Array(transaction.data.prefix(4))
        // Only a contract on the list is known to do what its selector says: Permit2 for its own, and a token for the rest. No token is a collection.
        let isOnTheList = switch selector {
        case Selectors.permit2Approve: transaction.to == KnownContracts.permit2
        case Selectors.setApprovalForAll: false
        default: token != nil
        }
        let arguments = Arguments(bytes: transaction.data.dropFirst(4))
        var warnings: [SiteWarning] = []
        var headline: String?
        var recorded: (symbol: String, decimals: Int, amount: UInt128)?
        var recipient: EthereumAddress?
        var spender: EthereumAddress?
        var moved: ReviewAmount?
        var preview: CallPreview?
        var isUnreadableCall = false
        let valueUsd = quote.ethUsdMicros.map { Money.usdMicros(of: transaction.value, priceMicros: $0, decimals: 18) }
        let movedEth = ReviewAmount(text: Money.text(ofUnits: transaction.value, decimals: 18), symbol: "ETH", usdMicros: valueUsd)

        func asset(_ token: Token?, at contract: EthereumAddress?) -> String {
            token?.symbol ?? contract.map { "tokens at \(SiteWording.address($0))" } ?? "this token"
        }
        func amountText(_ amount: UInt128, _ token: Token?) -> String {
            token.map { "\(Money.text(ofUnits: amount, decimals: $0.decimals)) \($0.symbol)" } ?? "\(amount) units of this token"
        }

        switch isOnTheList ? selector : [] {
        case Selectors.transfer:
            if let to = arguments.address(0), let amount = arguments.amount(1) {
                headline = "Send \(amountText(amount, token)) to \(SiteWording.who(to))"
                recipient = to
                if let token {
                    recorded = (token.symbol, token.decimals, amount)
                    moved = ReviewAmount(text: Money.text(ofUnits: amount, decimals: token.decimals), symbol: token.symbol, usdMicros: quote.tokenUsdMicros.map { Money.usdMicros(of: amount, priceMicros: $0, decimals: token.decimals) })
                }
            }
        case Selectors.increaseAllowance:
            // This adds to whatever's already allowed, which nothing here has read. So it can't say what the total comes to, and adding nothing doesn't stop anything.
            spender = arguments.address(0)
            if let spender = spender.map(SiteWording.who) {
                let amount = arguments.amount(1)
                if amount == 0 {
                    headline = "Add nothing to what \(spender) can spend of your \(asset(token, at: transaction.to))"
                } else if let amount, !Self.isUnlimited(amount, of: token) {
                    headline = "Let \(spender) spend \(amountText(amount, token)) more"
                } else {
                    headline = "Let \(spender) spend all of your \(asset(token, at: transaction.to))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token, at: transaction.to)), isStrong: true))
                }
            }
        case Selectors.approve:
            spender = arguments.address(0)
            if let spender = spender.map(SiteWording.who) {
                let amount = arguments.amount(1)
                if amount == 0 {
                    headline = "Stop \(spender) from spending your \(asset(token, at: transaction.to))"
                } else if let amount, !Self.isUnlimited(amount, of: token) {
                    headline = "Let \(spender) spend up to \(amountText(amount, token))"
                } else {
                    headline = "Let \(spender) spend all of your \(asset(token, at: transaction.to))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token, at: transaction.to)), isStrong: true))
                }
            }
        case Selectors.permit2Approve:
            spender = arguments.address(1)
            if let spender = spender.map(SiteWording.who) {
                let approvedAddress = arguments.address(0)
                let approved = approvedAddress.flatMap { address in Base.tokens.first { $0.contract == address } }
                let amount = arguments.amount(2)
                if amount == 0 {
                    headline = "Stop \(spender) from spending your \(asset(approved, at: approvedAddress))"
                } else if let amount, !Self.isUnlimited(amount, of: approved) {
                    headline = "Let \(spender) spend up to \(amountText(amount, approved))"
                    if approved == nil { warnings.append(SiteWarning(SiteWording.unknownAllowance(spender: spender), isStrong: true)) }
                } else {
                    headline = "Let \(spender) spend all of your \(asset(approved, at: approvedAddress))"
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(approved, at: approvedAddress)), isStrong: true))
                }
            }
        case Selectors.permit:
            spender = arguments.address(1)
            if let spender = spender.map(SiteWording.who) {
                headline = "Let \(spender) spend your \(asset(token, at: transaction.to))"
                warnings.append(SiteWarning(SiteWording.unlimited(spender: spender, asset: asset(token, at: transaction.to)), isStrong: true))
            }
        default:
            break
        }

        if transaction.data.isEmpty {
            headline = "Send \(Money.text(ofUnits: transaction.value, decimals: 18)) ETH to \(SiteWording.who(transaction.to))"
            recipient = transaction.to
            moved = movedEth
        }
        if headline == nil {
            isUnreadableCall = true
            if transaction.value > 0 { moved = movedEth }
            headline = transaction.value > 0 ? "Send \(Money.text(ofUnits: transaction.value, decimals: 18)) ETH with a request this app can't read" : "Approve a request this app can't read"
            preview = quote.preview
            if let preview {
                warnings.append(SiteWarning(SiteWording.previewIsAnEstimate))
                if preview.movesUnknownToken { warnings.append(SiteWarning(SiteWording.previewHasUnknownToken)) }
                let unlimited = preview.allowances.filter(\.isUnlimited)
                if unlimited.count > 1 {
                    warnings.append(SiteWarning(SiteWording.unlimited(count: unlimited.count), isStrong: true))
                } else if let allowance = unlimited.first {
                    warnings.append(SiteWarning(SiteWording.unlimited(spender: SiteWording.who(allowance.spender), asset: allowance.asset), isStrong: true))
                }
                let unknown = preview.allowances.filter { !$0.isUnlimited && !$0.isCollection && $0.unknownContract != nil }
                if let allowance = unknown.first {
                    warnings.append(SiteWarning(SiteWording.unknownAllowance(spender: unknown.count == 1 ? SiteWording.who(allowance.spender) : nil), isStrong: true))
                }
            } else {
                warnings.append(SiteWarning(SiteWording.unreadableCall))
            }
            if !isOnTheList, let claimed = Self.claimedAllowance(selector: selector, arguments: arguments, contract: transaction.to), !warnings.contains(claimed) {
                warnings.append(claimed)
            }
        }
        if transaction.to == .zero { warnings.append(SiteWarning(SiteWording.burn, isStrong: true)) }
        if transaction.value + quote.feeWei > quote.ethBalance { warnings.append(SiteWarning(SiteWording.notEnoughEth)) }

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
            usdMicros: recorded == nil ? valueUsd.map { String($0) } : nil,
            recipient: recipient,
            spender: spender,
            moved: moved,
            preview: preview,
            isUnreadableCall: isUnreadableCall
        )
    }
}

private extension String {
    var prefixedAsHex: String { "0x" + self }
}

public struct MessageReview: Equatable, Sendable {
    /// For Touch ID, so nothing in it comes from what a site named things.
    public let headline: String
    /// For the window, which can say who the message names itself as.
    public let title: String
    public let body: String
    /// The contract the signature is for, when it names one.
    public let contract: EthereumAddress?
    public let warnings: [SiteWarning]
    let signable: SignableMessage
    /// What a permit allows, when it's one this app can read. Then `body` is only there for anyone who wants to check it.
    public var permit: PermitSummary?
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
        self.init(headline: "Sign this message", title: "Sign this message", body: body, contract: nil, warnings: warnings, signable: .personal(bytes))
    }

    /// `formatDate` is only for tests, which can't depend on where they run.
    init(typed data: TypedData, formatDate: (Date) -> String = { $0.formatted(date: .abbreviated, time: .shortened) }) throws(TypedData.Failure) {
        var warnings: [SiteWarning] = []
        let contract = data.domain["verifyingContract"]?.string.flatMap { EthereumAddress($0) }
        let chain = try data.chainID
        if chain == nil { warnings.append(SiteWarning(SiteWording.anyChain, isStrong: true)) }
        let spender = Self.firstValue(of: ["spender", "operator", "delegate", "taker"], in: data.message)?.string.flatMap { EthereumAddress($0) }.map(SiteWording.who)
        // Always strong: a contract can act on any shape, with or without naming itself in the domain. The word list only picks which warning.
        warnings.insert(SiteWarning(Self.looksLikeAPermit(data) ? SiteWording.typedPermit(spender: spender) : SiteWording.typedUnclear, isStrong: true), at: 0)
        let name = data.domain["name"]?.string
        if Self.hasHiddenCharacters(data.message) || name.map(JSONValue.string).map(Self.hasHiddenCharacters) == true {
            warnings.append(SiteWarning(SiteWording.hiddenCharacters, isStrong: true))
        }
        // The token list is Base's, so a permit for anywhere else isn't read as one.
        let permit = chain == Base.chainID ? PermitSummary(data, formatDate: formatDate) : nil
        if let permit, permit.isZero, permit.kind != .permit2Transfer { warnings.append(SiteWarning(SiteWording.removalIsOnlyARequest(spender: SiteWording.who(permit.spender)))) }
        let headline = permit?.headline ?? "Sign this message"
        // A name with anything in it that `shown` would change is left out, since the title has no room to explain it.
        let title = permit == nil ? name.flatMap { Self.shown($0) == $0 ? "Sign this for \($0)" : nil } ?? headline : headline
        self.init(headline: headline, title: title, body: Self.pretty(data.message, indent: 0), contract: contract, warnings: warnings, signable: try data.signable(), permit: permit)
    }

    /// Line breaks are fine. Direction overrides, zero-width characters and the like can make a message read as something it isn't.
    /// So can anything that draws nothing: Unicode's default-ignorable characters, plus two blanks it doesn't list as ignorable.
    private static func isPlainlyVisible(_ scalar: Unicode.Scalar) -> Bool {
        if scalar.properties.isDefaultIgnorableCodePoint || scalar == "\u{2800}" || scalar == "\u{1D159}" { return false }
        return switch scalar.properties.generalCategory {
        case .control: scalar == "\n" || scalar == "\t" || scalar == "\r"
        case .format, .privateUse, .surrogate, .unassigned: false
        default: true
        }
    }

    /// A typed message's strings on one line each, so none can look like another field, or like anything but what it is. What's
    /// signed doesn't change: anything that could mislead is shown as a code. So are repeated spaces, which can push text to a new line.
    private static func shown(_ text: String) -> String {
        var result = ""
        var previous: Unicode.Scalar?
        for scalar in text.unicodeScalars {
            let isPlain: Bool
            switch scalar.properties.generalCategory {
            case .lineSeparator, .paragraphSeparator: isPlain = false
            case .spaceSeparator: isPlain = scalar == " " && previous != " "
            case .control: isPlain = false
            default: isPlain = isPlainlyVisible(scalar)
            }
            switch scalar {
            case _ where isPlain: result.unicodeScalars.append(scalar)
            case "\n": result += "\\n"
            case "\r": result += "\\r"
            case "\t": result += "\\t"
            default: result += "\\u{\(String(scalar.value, radix: 16, uppercase: true))}"
            }
            previous = scalar
        }
        return result
    }

    /// Any character in a key or value that hides or rearranges text. Line breaks don't count, since `shown` makes those harmless.
    private static func hasHiddenCharacters(_ value: JSONValue) -> Bool {
        func hides(_ text: String) -> Bool { !text.unicodeScalars.allSatisfy(isPlainlyVisible) }
        switch value {
        case .object(let object): return object.keys.contains { key in hides(key) || object[key].map(hasHiddenCharacters) == true }
        case .array(let items): return items.contains(where: hasHiddenCharacters)
        case .string(let text): return hides(text)
        default: return false
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
                case .object, .array: return "\(padding)\(shown(key)):\n\(pretty(child, indent: indent + 1))"
                default: return "\(padding)\(shown(key)): \(pretty(child, indent: 0))"
                }
            }.joined(separator: "\n")
        case .array(let items):
            return items.map { pretty($0, indent: indent) }.joined(separator: "\n")
        case .string(let text): return shown(text)
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
