import Foundation
import KeyVault
import Observation
import PricetagKit

/// One send, exactly as the user asked for it. Only ever an allowlisted token, because nothing else is ever called.
public struct SendRequest: Equatable, Sendable {
    public let token: Token
    public let amount: UInt128
    public let to: EthereumAddress

    public init(token: Token, amount: UInt128, to: EthereumAddress) {
        self.token = token
        self.amount = amount
        self.to = to
    }
}

public enum SendProblem: Equatable, Sendable {
    case nothingToSend, moreThanHeld
    case keptForGas(UInt128)
    case noGas
    case isThisWallet, isARetiredKey, isZero, isAToken

    public var message: String {
        switch self {
        case .nothingToSend: "Enter an amount."
        case .moreThanHeld: HotWalletWording.notEnoughToSend
        case .keptForGas(let reserve): HotWalletWording.keptForGas(reserve)
        case .noGas: HotWalletWording.noGasToSend
        case .isThisWallet: HotWalletWording.sendingToItself
        case .isARetiredKey: HotWalletWording.sendingToARetiredKey
        case .isZero: HotWalletWording.sendingToNobody
        case .isAToken: HotWalletWording.sendingToAToken
        }
    }
}

public enum SendPlanner {
    /// ETH always leaves what sweeps need, so sending some can't strand the tokens that are left.
    public static func maximum(of token: Token, snapshot: ChainSnapshot) -> UInt128 {
        let balance = snapshot.balances[token] ?? 0
        return token.isNative ? balance.subtractingClamped(SweepPlanner.gasReserve(snapshot.fees)) : balance
    }

    public static func problem(sendingTo recipient: EthereumAddress, from wallet: EthereumAddress, retired: [EthereumAddress]) -> SendProblem? {
        if recipient == .zero { return .isZero }
        if recipient == wallet { return .isThisWallet }
        if retired.contains(recipient) { return .isARetiredKey }
        if Base.tokens.contains(where: { $0.contract == recipient }) { return .isAToken }
        return nil
    }

    public static func problem(with request: SendRequest, snapshot: ChainSnapshot) -> SendProblem? {
        guard request.amount > 0 else { return .nothingToSend }
        let balance = snapshot.balances[request.token] ?? 0
        guard request.amount <= balance else { return .moreThanHeld }
        let reserve = SweepPlanner.gasReserve(snapshot.fees)
        guard request.amount <= maximum(of: request.token, snapshot: snapshot) else { return .keptForGas(reserve) }
        guard snapshot.balances[Base.eth] ?? 0 >= snapshot.fees.costWei(of: request.token) else { return .noGas }
        return nil
    }
}

/// An address the user knows that a recipient only looks like.
public struct LookalikeMatch: Equatable, Sendable {
    public let address: EthereumAddress
    /// What it is to them, as in "This only looks like Treasury".
    public let name: String
}

/// What the Send sheet needs: what's been typed, whether to ask about the address, and sending it. The answer's only saved once
/// something's on its way, and a skipped question just comes back next time. What's typed can't change once it's being confirmed.
@MainActor
@Observable
public final class SendModel {
    public enum Stage: Equatable, Sendable {
        case composing, confirming, sent
    }

    /// What the amount is typed in. Either way, what's signed is the token amount, and that's shown before anything's confirmed.
    public enum Unit: Equatable, Sendable {
        case token, money
    }

    public private(set) var stage = Stage.composing
    /// What this send put on its way, once it has.
    private var sentHashes: [String] = []
    public var token: Token {
        didSet { if token != oldValue { tokenChanged() } }
    }
    public private(set) var unit = Unit.token
    public var amountText = "" {
        // Any edit is ordinary input, even one that types Max's amount again.
        didSet { if amountText != pinnedMaximum?.text { pinnedMaximum = nil } }
    }
    public var addressText = "" {
        didSet {
            guard addressText != oldValue else { return }
            ownership = nil
            acceptsLookalike = false
        }
    }
    /// The deliberate step it takes to send to an address that looks like one they know. It's for that address only.
    public var acceptsLookalike = false
    /// Fixed when it's confirmed, so a price or a rate that moves while Touch ID asks can't change what it signs.
    private var confirmedAmount: UInt128?
    /// What Max put in the field, in money, and the exact token amount it stood for then. Until the field changes, that's the amount,
    /// rather than what the rounded money would buy, and never a different maximum that a new balance makes.
    private var pinnedMaximum: (text: String, units: UInt128)?
    /// The answer to "Is this yours?", if they've given one.
    public var ownership: Ownership?
    public private(set) var failure: String?
    public private(set) var isSending = false

    private let wallet: HotWallet
    private let store: PortfolioStore
    private var askingPrompt: PresencePrompt?

    public init(wallet: HotWallet, store: PortfolioStore) {
        self.wallet = wallet
        self.store = store
        token = wallet.holdings.first { !$0.token.isNative }?.token ?? Base.eth
    }

    public var tokens: [Token] { wallet.holdings.map(\.token) }

    public var recipient: EthereumAddress? {
        EthereumAddress(addressText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// The token amount, which is all that's ever signed. In money, it's what that buys at the price shown, never more.
    public var amount: UInt128? {
        stage == .composing ? typedAmount : confirmedAmount
    }

    private var typedAmount: UInt128? {
        switch unit {
        case .token:
            return Money.units(fromText: amountText, decimals: token.decimals)
        case .money:
            if let pinnedMaximum, amountText == pinnedMaximum.text { return pinnedMaximum.units }
            guard let price, let shown = Money.units(fromText: amountText, decimals: 6) else { return nil }
            let units = Money.amount(ofUsdMicros: wallet.display.usdMicros(ofShown: shown), priceMicros: price, decimals: token.decimals)
            // Digits past these are worth nothing anyone would count, and only make the amount harder to check.
            let step = (0..<max(token.decimals - Self.moneyDecimals, 0)).reduce(UInt128(1)) { value, _ in value * 10 }
            return units - units % step
        }
    }

    private static let moneyDecimals = 8

    private var price: UInt128? {
        wallet.holdings.first { $0.token == token }?.priceUsdMicros.flatMap { $0 > 0 ? $0 : nil }
    }

    /// Only with a price to work it out from.
    public var canTypeMoney: Bool { price != nil }

    /// What goes before an amount typed in money.
    public var moneySymbol: String { wallet.display.symbol }

    /// Typing in the other unit, keeping what's there as near as it can be said in it.
    public func switchUnit() {
        guard unit == .money || canTypeMoney else { return }
        let current = typedAmount
        let wasMaximum = current != nil && current == maximum && maximum > 0
        unit = unit == .token ? .money : .token
        pinnedMaximum = nil
        guard !amountText.isEmpty else { return }
        // Without an amount to carry over, say because the price is gone, the digits mean nothing in the other unit.
        guard let current, let text = unit == .token ? Money.text(ofUnits: current, decimals: token.decimals) : moneyText(of: current) else {
            amountText = ""
            return
        }
        amountText = text
        if wasMaximum, unit == .money { pinnedMaximum = (text, current) }
    }

    private func tokenChanged() {
        pinnedMaximum = nil
        if unit == .money, !canTypeMoney {
            unit = .token
            amountText = ""
        }
    }

    /// In money, to the cent and rounded down, as it's typed.
    private func moneyText(of units: UInt128) -> String? {
        guard let price else { return nil }
        let cents = wallet.display.shownMicros(Money.usdMicros(of: units, priceMicros: price, decimals: token.decimals)) / 10_000
        let fraction = String(cents % 100)
        return "\(cents / 100).\(fraction.count == 1 ? "0" : "")\(fraction)"
    }

    /// The most that can be sent, in what's being typed.
    public var availableText: String? {
        guard wallet.snapshot != nil else { return nil }
        switch unit {
        case .token: return "\(Format.amount(String(maximum), decimals: token.decimals)) \(token.symbol)"
        case .money: return price.map { wallet.money(Money.usdMicros(of: maximum, priceMicros: $0, decimals: token.decimals)) }
        }
    }

    /// The exact token amount, to the last digit, which is what Touch ID will sign.
    public var tokenAmountText: String? {
        amount.map { "\(Money.text(ofUnits: $0, decimals: token.decimals)) \(token.symbol)" }
    }

    /// What's wrong with the address, once it's an address.
    public var recipientProblem: SendProblem? { recipient.flatMap(wallet.problem(sendingTo:)) }

    /// What's wrong with the amount, once there is one.
    public var amountProblem: SendProblem? {
        guard let amount, let snapshot = wallet.snapshot else { return nil }
        return SendPlanner.problem(with: SendRequest(token: token, amount: amount, to: .zero), snapshot: snapshot)
    }

    /// An address nobody's said anything about. Accounts in this wallet are always in the book, so they never come up.
    public var asksIfItsYours: Bool {
        guard let recipient, recipientProblem == nil, lookalike == nil else { return false }
        return store.book.senders[recipient.lowercased] == nil
    }

    /// What's already known about this address, to show instead of asking.
    public var knownAs: Ownership? {
        guard let recipient, recipientProblem == nil else { return nil }
        return switch store.book.senders[recipient.lowercased]?.kind {
        case .mine: .mine
        case .myExchange: .myExchange
        case .someoneElse: .someoneElse
        case nil: nil
        }
    }

    public var usdMicros: UInt128? {
        guard let amount, let price else { return nil }
        return Money.usdMicros(of: amount, priceMicros: price, decimals: token.decimals)
    }

    /// An address they know that this one only starts and ends like, which is how address poisoning works. Checked against what's on
    /// this Mac only: their wallets, this one, and where it's sent before. Named ones come first, because a name is what they'd recognize.
    public var lookalike: LookalikeMatch? {
        guard let recipient, recipientProblem == nil else { return nil }
        var known: [(address: String, name: String)] = wallet.settings.coldWallets.map { ($0.address.lowercased, $0.name) }
        known += store.savedWallets.compactMap { saved in saved.name.map { (saved.address, $0) } }
        if let own = wallet.address { known.append((own.lowercased, HotWalletWording.title)) }
        known += store.savedWallets.filter { $0.name == nil }.map { ($0.address, "a wallet you watch") }
        known += wallet.records.map { ($0.to.lowercased, "an address you've sent to") }
        known += store.book.senders.keys.sorted().map { ($0, "an address you've used") }
        guard let match = Lookalike.match(for: recipient.lowercased, among: known.map(\.address)), let address = EthereumAddress(match) else { return nil }
        return known.first { $0.address == match }.map { LookalikeMatch(address: address, name: $0.name) }
    }

    public var worthText: String? { usdMicros.map(wallet.money) }

    /// What it should cost to send this token right now. It's read again before anything's signed.
    public var feeText: String? {
        guard let snapshot = wallet.snapshot else { return nil }
        let wei = snapshot.fees.costWei(of: token)
        return snapshot.ethUsdMicros.map { wallet.money(Money.usdMicros(of: wei, priceMicros: $0, decimals: 18)) } ?? "\(Format.amount(String(wei), decimals: 18)) ETH"
    }

    /// What the user calls this address, if anything. It's only ever shown beside the address, because a name proves nothing.
    public var recipientName: String? {
        guard let recipient else { return nil }
        return wallet.settings.coldWallets.first { $0.address == recipient }?.name ?? store.savedWallets.first { $0.address == recipient.lowercased }?.name
    }

    /// Whether a saved wallet is somewhere this can send to, so the list only offers what would work.
    public func canSend(to entry: WalletEntry) -> Bool {
        EthereumAddress(entry.address).map { wallet.problem(sendingTo: $0) == nil } ?? false
    }

    public var nextPromptAt: Date? { wallet.nextPromptAt }

    /// What became of this send, once it's gone, from the receipts of exactly what it put on its way.
    public var landing: Landing {
        guard stage == .sent else { return .onItsWay }
        return wallet.landing(of: sentHashes)
    }

    public var maximum: UInt128 { wallet.maximumSend(of: token) }

    public func useMaximum() {
        let most = maximum
        // Without a price to say it in money, it's said in the token, so what's shown is always what's sent.
        guard unit == .money, let text = moneyText(of: most) else {
            unit = .token
            amountText = Money.text(ofUnits: most, decimals: token.decimals)
            return
        }
        amountText = text
        pinnedMaximum = (text, most)
    }

    public var canSend: Bool {
        guard wallet.canSend, !isSending, let amount, amount > 0, recipient != nil else { return false }
        return recipientProblem == nil && amountProblem == nil && (lookalike == nil || acceptsLookalike)
    }

    /// On to what Touch ID will be asked about, with the amount as it is now.
    public func confirm() {
        guard canSend else { return }
        failure = nil
        confirmedAmount = typedAmount
        stage = .confirming
    }

    /// Not once Touch ID has said yes, when it's on its way whatever this shows. Before that, it calls off the prompt here and now, because
    /// the view going away comes later, and a touch landing in between would send what's just been left.
    public func backToEditing() {
        guard stage == .confirming, askingPrompt?.isConfirmed != true else { return }
        askingPrompt?.cancel()
        stage = .composing
    }

    /// What the confirmation asks for, in its own terms.
    public func sendConfirmed(in prompt: PresencePrompt) async -> ApprovalResult {
        guard stage == .confirming else { return .cancelled }
        if await send(in: prompt) { return .done }
        return failure.map(ApprovalResult.failed) ?? .cancelled
    }

    /// True once it's on its way, and the answer's been saved.
    public func send(in prompt: PresencePrompt? = nil) async -> Bool {
        guard canSend, let recipient, let amount else { return false }
        // Together, because the answer is about this address, whatever's on screen by the time this lands.
        let answer = asksIfItsYours ? ownership?.answer : nil
        isSending = true
        askingPrompt = prompt
        defer {
            isSending = false
            askingPrompt = nil
        }
        failure = nil
        guard await wallet.send(SendRequest(token: token, amount: amount, to: recipient), in: prompt) else {
            failure = wallet.sweepProblem.map(HotWalletWording.sendFailure)
            return false
        }
        sentHashes = wallet.lastSubmitted
        stage = .sent
        if let answer, store.book.senders[recipient.lowercased] == nil {
            store.setBook(store.book.answering(recipient.lowercased, answer, focus: wallet.address?.lowercased))
        }
        return true
    }
}
