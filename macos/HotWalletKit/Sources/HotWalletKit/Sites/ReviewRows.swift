import Foundation
import KeyVault
import PricetagKit

/// One line of what's being approved.
public struct ConfirmationRow: Equatable, Sendable {
    public let label: String
    public let value: String
    public var isAddress: Bool
    /// Who an address belongs to, above it, when that's known.
    public var name: String?

    public init(label: String, value: String, isAddress: Bool = false, name: String? = nil) {
        self.label = label
        self.value = value
        self.isAddress = isAddress
        self.name = name
    }

    /// What a transaction costs on its way, kept small. It's always "about", because the network sets it when it lands.
    public static func networkFee(_ text: String) -> ConfirmationRow {
        ConfirmationRow(label: "Network fee", value: "About \(text)")
    }

    /// The same in money, or in ETH when there's no price for it.
    public static func networkFee(usdMicros: UInt128?, wei: UInt128, money: (UInt128) -> String) -> ConfirmationRow {
        networkFee(usdMicros.map(money) ?? "\(Format.amount(String(wei), decimals: 18)) ETH")
    }
}

/// The one big thing an approval says.
public enum ConfirmationHero: Equatable, Sendable {
    case amount(String, symbol: String)
    case words(String)
}

/// What a site's request says before anyone signs it, from nothing but what was read from the request itself. Nothing here comes from
/// what a site called things. It's here and not in a view so that it's tested: someone decides whether to sign from these words.
public enum ReviewRows {
    // MARK: Connecting

    public static func connect(hotWalletTitle: String = HotWalletWording.title) -> (hero: ConfirmationHero, rows: [ConfirmationRow]) {
        (.words("Connect to \(hotWalletTitle)"), [
            ConfirmationRow(label: "It can see", value: "This wallet's address and balances"),
            ConfirmationRow(label: "It can't", value: "Move anything without you, or see your savings"),
        ])
    }

    // MARK: Transactions

    /// A big number says that's the whole of it, which it isn't when something comes back, or when nothing says what the call does.
    /// The rows say what goes where.
    public static func hero(_ review: TransactionReview) -> ConfirmationHero {
        guard !review.isUnreadableCall, let moved = review.moved else { return .words(review.title) }
        return .amount(moved.text, symbol: moved.symbol)
    }

    /// What it's worth, under the number. Not when the number isn't the whole of it.
    public static func worth(_ review: TransactionReview, money: (UInt128) -> String) -> String? {
        review.isUnreadableCall ? nil : review.moved?.usdMicros.map(money)
    }

    public static func rows(_ review: TransactionReview, money: (UInt128) -> String) -> [ConfirmationRow] {
        var rows = review.preview.map { preview($0, money: money) } ?? []
        // Anyone can be sent to, so a recipient only gets a name when it's on the list.
        if let recipient = review.recipient {
            rows.append(ConfirmationRow(label: "To", value: recipient.checksummed, isAddress: true, name: KnownContracts.name(of: recipient)))
        } else if let spender = review.spender {
            rows.append(spenderRow(spender))
        } else {
            rows.append(contractRow(review.to))
        }
        // A token this app doesn't know is only as good as its contract, so that's never tucked away.
        if review.toName == nil, review.recipient != review.to, review.recipient != nil || review.spender != nil {
            rows.append(contractRow(review.to))
        }
        let eth = ethAmount(review, money: money)
        // With no estimate, the ETH is all that's certain, so it's a row under the title rather than the title itself.
        if review.preview == nil, review.isUnreadableCall, review.value > 0 {
            rows.insert(ConfirmationRow(label: "Sends", value: eth), at: 0)
        }
        if review.alsoSendsEth {
            rows.append(ConfirmationRow(label: "Also sends", value: eth))
        }
        rows.append(.networkFee(usdMicros: review.feeUsdMicros, wei: review.feeWei, money: money))
        return rows
    }

    /// What's tucked away: the contract of a token this app knows, since the rows say who's on the other end of it.
    public static func details(_ review: TransactionReview) -> [ConfirmationRow] {
        guard let name = review.toName, review.recipient != review.to, review.recipient != nil || review.spender != nil else { return [] }
        return [ConfirmationRow(label: name, value: review.to.checksummed, isAddress: true)]
    }

    /// The bytes being signed, one click away. A call with none has nothing to show.
    public static func data(_ review: TransactionReview) -> String? {
        review.data.isEmpty ? nil : "0x" + Hex.encode(review.data)
    }

    /// "You'd" because it's an estimate, and the note under the rows says so too.
    static func preview(_ preview: CallPreview, money: (UInt128) -> String) -> [ConfirmationRow] {
        func row(_ label: String, _ asset: CallPreview.Asset) -> ConfirmationRow {
            switch asset {
            case .known(let amount):
                ConfirmationRow(label: label, value: amount.usdMicros.map { "\(amount.text) \(amount.symbol) (\(money($0)))" } ?? "\(amount.text) \(amount.symbol)")
            case .unknown(let contract):
                ConfirmationRow(label: label, value: contract.checksummed, isAddress: true, name: "Unknown token")
            }
        }
        let allowances = preview.allowances.flatMap { allowance in
            var rows = [ConfirmationRow(label: "You'd allow", value: allowance.spender.checksummed, isAddress: true, name: "\(KnownContracts.name(of: allowance.spender) ?? "This address") to spend \(allowance.words)")]
            if let contract = allowance.unknownContract {
                rows.append(ConfirmationRow(label: "For", value: contract.checksummed, isAddress: true, name: allowance.isCollection ? "Unknown collection" : "Unknown token"))
            }
            return rows
        }
        // What can leave comes first, so a long list of what's arriving can't push it out of sight.
        let rows = preview.gives.map { row("You'd give", $0) } + allowances + preview.gets.map { row("You'd get", $0) }
        return rows.isEmpty ? [ConfirmationRow(label: "Your balances", value: "No change")] : rows
    }

    // MARK: Messages

    /// A permit this app can read says what it allows, and what's signed is one click away. Anything else is shown as it is.
    /// A token's own permit already shows its address as the token.
    public static func rows(_ review: MessageReview) -> [ConfirmationRow] {
        let contract = review.contract.flatMap { $0 == review.permit?.token ? nil : [contractRow($0)] } ?? []
        return (review.permit.map(permit) ?? []) + contract
    }

    /// The message in full, unless it's a permit, whose rows already say what it does.
    public static func message(_ review: MessageReview) -> String? {
        review.permit == nil ? review.body : nil
    }

    /// What's signed, one click away, for a permit.
    public static func data(_ review: MessageReview) -> String? {
        review.permit == nil ? nil : review.body
    }

    static func permit(_ permit: PermitSummary) -> [ConfirmationRow] {
        var rows = [
            ConfirmationRow(label: permit.kind == .permit2Transfer ? "Can take" : "Can spend", value: permit.amount),
            ConfirmationRow(label: "Token", value: permit.token.checksummed, isAddress: true, name: permit.tokenSymbol ?? "Unknown token"),
            spenderRow(permit.spender),
        ]
        if let allowedUntil = permit.allowedUntil { rows.append(ConfirmationRow(label: "Allowed until", value: allowedUntil)) }
        rows.append(ConfirmationRow(label: "Must be used by", value: permit.mustBeUsedBy))
        return rows
    }

    // MARK: Who's who

    /// Every address with its name above it when it's on the list, and plainly unknown when it isn't.
    private static func contractRow(_ address: EthereumAddress) -> ConfirmationRow {
        ConfirmationRow(label: "Contract", value: address.checksummed, isAddress: true, name: KnownContracts.name(of: address) ?? SiteWording.unknownContract)
    }

    private static func spenderRow(_ address: EthereumAddress) -> ConfirmationRow {
        ConfirmationRow(label: "Spender", value: address.checksummed, isAddress: true, name: KnownContracts.name(of: address) ?? SiteWording.unknownAddress)
    }

    private static func ethAmount(_ review: TransactionReview, money: (UInt128) -> String) -> String {
        let text = Money.text(ofUnits: review.value, decimals: 18)
        return review.valueUsdMicros.map { "\(text) ETH (\(money($0)))" } ?? "\(text) ETH"
    }
}
