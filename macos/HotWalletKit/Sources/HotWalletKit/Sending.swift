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

/// What the Send sheet needs: what's been typed, whether to ask about the address, and sending it. The answer's only saved once
/// something's on its way, and a skipped question just comes back next time.
@MainActor
@Observable
public final class SendModel {
    public var token: Token
    public var amountText = ""
    public var addressText = "" {
        didSet { if addressText != oldValue { ownership = nil } }
    }
    /// The answer to "Is this yours?", if they've given one.
    public var ownership: Ownership?
    public private(set) var failure: String?
    public private(set) var isSending = false

    private let wallet: HotWallet
    private let store: PortfolioStore

    public init(wallet: HotWallet, store: PortfolioStore) {
        self.wallet = wallet
        self.store = store
        token = wallet.holdings.first { !$0.token.isNative }?.token ?? Base.eth
    }

    public var tokens: [Token] { wallet.holdings.map(\.token) }

    public var recipient: EthereumAddress? {
        EthereumAddress(addressText.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public var amount: UInt128? { Money.units(fromText: amountText, decimals: token.decimals) }

    /// What's wrong with the address, once it's an address.
    public var recipientProblem: SendProblem? { recipient.flatMap(wallet.problem(sendingTo:)) }

    /// What's wrong with the amount, once there is one.
    public var amountProblem: SendProblem? {
        guard let amount, let snapshot = wallet.snapshot else { return nil }
        return SendPlanner.problem(with: SendRequest(token: token, amount: amount, to: .zero), snapshot: snapshot)
    }

    /// An address nobody's said anything about. Accounts in this wallet are always in the book, so they never come up.
    public var asksIfItsYours: Bool {
        guard let recipient, recipientProblem == nil else { return false }
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
        guard let amount else { return nil }
        return wallet.holdings.first { $0.token == token }?.priceUsdMicros.map { Money.usdMicros(of: amount, priceMicros: $0, decimals: token.decimals) }
    }

    public var maximum: UInt128 { wallet.maximumSend(of: token) }

    public func useMaximum() {
        amountText = Money.text(ofUnits: maximum, decimals: token.decimals)
    }

    public var canSend: Bool {
        guard wallet.canSend, !isSending, let amount, amount > 0, recipient != nil else { return false }
        return recipientProblem == nil && amountProblem == nil
    }

    /// True once it's on its way, and the answer's been saved.
    public func send() async -> Bool {
        guard canSend, let recipient, let amount else { return false }
        // Together, because the answer is about this address, whatever's on screen by the time this lands.
        let answer = asksIfItsYours ? ownership?.answer : nil
        isSending = true
        defer { isSending = false }
        failure = nil
        guard await wallet.send(SendRequest(token: token, amount: amount, to: recipient)) else {
            failure = wallet.sweepProblem
            return false
        }
        if let answer, store.book.senders[recipient.lowercased] == nil {
            store.setBook(store.book.answering(recipient.lowercased, answer, focus: wallet.address?.lowercased))
        }
        return true
    }
}
