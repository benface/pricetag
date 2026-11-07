import Foundation
@testable import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private func money(_ usdMicros: UInt128) -> String { "$\(usdMicros / Money.dollar)" }
private let friend = EthereumAddress("0x0000000000000000000000000000000000c0ffee")!
private let scam = EthereumAddress("0x5555555555555555555555555555555555555555")!
private let uniswap = EthereumAddress("0x2626664c2603336e57b271c5c0b26f421741e481")!

private func review(to: EthereumAddress = friend, toName: String? = nil, value: UInt128 = 0, valueUsd: UInt128? = nil, data: [UInt8] = [], feeUsd: UInt128? = 2 * Money.dollar, recipient: EthereumAddress? = nil, spender: EthereumAddress? = nil, moved: ReviewAmount? = nil, preview: CallPreview? = nil, isUnreadableCall: Bool = false) -> TransactionReview {
    TransactionReview(headline: "Headline", to: to, toName: toName, value: value, valueUsdMicros: valueUsd, data: data, feeWei: 3_000_000_000_000, feeUsdMicros: feeUsd, warnings: [], symbol: "ETH", decimals: 18, amount: "0", usdMicros: nil, recipient: recipient, spender: spender, moved: moved, preview: preview, isUnreadableCall: isUnreadableCall)
}

private func labels(_ rows: [ConfirmationRow]) -> [String] { rows.map(\.label) }
private func row(_ label: String, in rows: [ConfirmationRow]) -> ConfirmationRow? { rows.first { $0.label == label } }

/// What someone reads before signing. The window only draws these, so this is the check on what they say.
@Suite struct ReviewRowsTests {
    private let fee = ConfirmationRow(label: "Network fee", value: "About $2")

    // MARK: Plain sends

    @Test func sendingEthSaysWhoGetsItAndTheFee() {
        let moved = ReviewAmount(text: "0.5", symbol: "ETH", usdMicros: 1500 * Money.dollar)
        let sent = review(value: oneEth / 2, recipient: friend, moved: moved)
        #expect(ReviewRows.hero(sent) == .amount("0.5", symbol: "ETH"))
        #expect(ReviewRows.worth(sent, money: money) == "$1500")
        #expect(ReviewRows.rows(sent, money: money) == [ConfirmationRow(label: "To", value: friend.checksummed, isAddress: true), fee])
        #expect(ReviewRows.details(sent).isEmpty)
    }

    @Test func aRecipientOnlyGetsANameWhenItsOnTheList() {
        let rows = ReviewRows.rows(review(recipient: uniswap), money: money)
        #expect(row("To", in: rows)?.name == "Uniswap")
    }

    @Test func aKnownTokensContractIsTuckedAway() {
        let token = usdc.contract!
        let sent = review(to: token, toName: "USDC", recipient: friend)
        #expect(labels(ReviewRows.rows(sent, money: money)) == ["To", "Network fee"])
        #expect(ReviewRows.details(sent) == [ConfirmationRow(label: "USDC", value: token.checksummed, isAddress: true)])
    }

    @Test func anUnknownTokensContractIsNeverTuckedAway() {
        let sent = review(to: scam, recipient: friend)
        let rows = ReviewRows.rows(sent, money: money)
        #expect(labels(rows) == ["To", "Contract", "Network fee"])
        #expect(row("Contract", in: rows) == ConfirmationRow(label: "Contract", value: scam.checksummed, isAddress: true, name: SiteWording.unknownContract))
        #expect(ReviewRows.details(sent).isEmpty)
    }

    @Test func sendingToAContractItselfDoesntShowItTwice() {
        let rows = ReviewRows.rows(review(to: scam, recipient: scam), money: money)
        #expect(labels(rows) == ["To", "Network fee"])
    }

    @Test func ethGoingAlongWithATokenIsItsOwnRow() {
        let moved = ReviewAmount(text: "5", symbol: "USDC", usdMicros: nil)
        let rows = ReviewRows.rows(review(to: usdc.contract!, toName: "USDC", value: oneEth, valueUsd: 3000 * Money.dollar, recipient: friend, moved: moved), money: money)
        #expect(labels(rows) == ["To", "Also sends", "Network fee"])
        #expect(row("Also sends", in: rows)?.value == "1 ETH ($3000)")
    }

    @Test func ethWithNoPriceIsStillSaid() {
        let moved = ReviewAmount(text: "5", symbol: "USDC", usdMicros: nil)
        let rows = ReviewRows.rows(review(to: usdc.contract!, toName: "USDC", value: oneEth, recipient: friend, moved: moved), money: money)
        #expect(row("Also sends", in: rows)?.value == "1 ETH")
    }

    @Test func aFeeWithNoPriceIsInEth() {
        let rows = ReviewRows.rows(review(feeUsd: nil, recipient: friend), money: money)
        #expect(row("Network fee", in: rows)?.value == "About 0.000003 ETH")
    }

    // MARK: Allowances

    @Test func aSpenderIsPlainlyUnknownWhenItIsnt() {
        let rows = ReviewRows.rows(review(to: usdc.contract!, toName: "USDC", spender: friend), money: money)
        #expect(row("Spender", in: rows) == ConfirmationRow(label: "Spender", value: friend.checksummed, isAddress: true, name: SiteWording.unknownAddress))
        #expect(labels(rows) == ["Spender", "Network fee"])
    }

    @Test func aSpenderOnTheListIsNamed() {
        let rows = ReviewRows.rows(review(to: usdc.contract!, toName: "USDC", spender: uniswap), money: money)
        #expect(row("Spender", in: rows)?.name == "Uniswap")
    }

    @Test func anUnknownTokensAllowanceShowsItsContract() {
        let rows = ReviewRows.rows(review(to: scam, spender: friend), money: money)
        #expect(labels(rows) == ["Spender", "Contract", "Network fee"])
    }

    // MARK: Calls it can't read

    @Test func aCallItCantReadHasNoBigNumberOrWorth() {
        let moved = ReviewAmount(text: "1", symbol: "ETH", usdMicros: 3000 * Money.dollar)
        let call = review(value: oneEth, moved: moved, isUnreadableCall: true)
        #expect(ReviewRows.hero(call) == .words(SiteWording.unclear))
        #expect(ReviewRows.worth(call, money: money) == nil)
    }

    @Test func withNoEstimateTheEthIsAllThatsCertain() {
        let rows = ReviewRows.rows(review(to: scam, value: oneEth, valueUsd: 3000 * Money.dollar, isUnreadableCall: true), money: money)
        #expect(labels(rows) == ["Sends", "Contract", "Also sends", "Network fee"])
        #expect(rows.first?.value == "1 ETH ($3000)")
        #expect(row("Contract", in: rows)?.name == SiteWording.unknownContract)
    }

    @Test func aCallSendingNoEthDoesntSayItDoes() {
        #expect(labels(ReviewRows.rows(review(to: scam, isUnreadableCall: true), money: money)) == ["Contract", "Network fee"])
    }

    @Test func aContractOnTheListIsNamed() {
        #expect(row("Contract", in: ReviewRows.rows(review(to: uniswap, isUnreadableCall: true), money: money))?.name == "Uniswap")
    }

    @Test func theBytesAreOneClickAway() {
        #expect(ReviewRows.data(review(data: [0xDE, 0xAD])) == "0xdead")
        #expect(ReviewRows.data(review()) == nil)
    }

    // MARK: Estimates

    private func estimate(gives: [CallPreview.Asset] = [], gets: [CallPreview.Asset] = [], allowances: [CallPreview.Allowance] = []) -> CallPreview {
        CallPreview(gives: gives, gets: gets, allowances: allowances)
    }

    private func allowance(spender: EthereumAddress = friend, contract: EthereumAddress? = nil, isCollection: Bool = false) -> CallPreview.Allowance {
        CallPreview.Allowance(spender: spender, words: "all of your USDC", unknownContract: contract, isCollection: isCollection, asset: "USDC", isUnlimited: true)
    }

    @Test func whatCanLeaveComesFirst() {
        let given = CallPreview.Asset.known(ReviewAmount(text: "200", symbol: "USDC", usdMicros: 200 * Money.dollar))
        let gotten = CallPreview.Asset.known(ReviewAmount(text: "0.1", symbol: "ETH", usdMicros: nil))
        let rows = ReviewRows.preview(estimate(gives: [given], gets: [gotten], allowances: [allowance()]), money: money)
        #expect(labels(rows) == ["You'd give", "You'd allow", "You'd get"])
        #expect(rows[0].value == "200 USDC ($200)")
        #expect(rows[1] == ConfirmationRow(label: "You'd allow", value: friend.checksummed, isAddress: true, name: "This address to spend all of your USDC"))
        #expect(rows[2].value == "0.1 ETH")
    }

    @Test func anEstimateComesBeforeWhoItsWith() {
        let rows = ReviewRows.rows(review(to: scam, value: oneEth, preview: estimate(), isUnreadableCall: true), money: money)
        #expect(labels(rows) == ["Your balances", "Contract", "Also sends", "Network fee"])
    }

    @Test func aTokenOffTheListIsPlainlyUnknown() {
        let rows = ReviewRows.preview(estimate(gets: [.unknown(contract: scam)]), money: money)
        #expect(rows == [ConfirmationRow(label: "You'd get", value: scam.checksummed, isAddress: true, name: "Unknown token")])
    }

    @Test func anAllowanceOnTheListSaysWhoItsFor() {
        #expect(ReviewRows.preview(estimate(allowances: [allowance(spender: uniswap)]), money: money).first?.name == "Uniswap to spend all of your USDC")
    }

    @Test func anAllowanceForWhatsOffTheListNamesItsContract() {
        let token = ReviewRows.preview(estimate(allowances: [allowance(contract: scam)]), money: money)
        #expect(labels(token) == ["You'd allow", "For"])
        #expect(token[1] == ConfirmationRow(label: "For", value: scam.checksummed, isAddress: true, name: "Unknown token"))
        let collection = ReviewRows.preview(estimate(allowances: [allowance(contract: scam, isCollection: true)]), money: money)
        #expect(collection[1].name == "Unknown collection")
    }

    @Test func nothingMovingSaysSo() {
        #expect(ReviewRows.preview(estimate(), money: money) == [ConfirmationRow(label: "Your balances", value: "No change")])
    }

    // MARK: Messages

    private func typed(_ json: String) throws -> MessageReview {
        try MessageReview(typed: TypedData(.string(json)), formatDate: { "at \(Int($0.timeIntervalSince1970))" })
    }

    private static let owner = "0x0000000000000000000000000000000000000abc"
    private static let permitTypes = #"{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]}"#

    private func permitJSON(spender: EthereumAddress, value: String) -> String {
        #"{"domain":{"name":"USD Coin","version":"2","chainId":8453,"verifyingContract":"\#(usdc.contract!.lowercased)"},"types":\#(Self.permitTypes),"primaryType":"Permit","message":{"owner":"\#(Self.owner)","spender":"\#(spender.lowercased)","value":"\#(value)","nonce":"0","deadline":"1793836800"}}"#
    }

    @Test func aPermitSaysWhatItAllowsAndKeepsTheBytesAClickAway() throws {
        let unlimited = "115792089237316195423570985008687907853269984665640564039457584007913129639935"
        let review = try typed(permitJSON(spender: friend, value: unlimited))
        let rows = ReviewRows.rows(review)
        #expect(labels(rows) == ["Can spend", "Token", "Spender", "Allowed until", "Must be used by"])
        #expect(rows[0].value == "Unlimited")
        #expect(rows[1] == ConfirmationRow(label: "Token", value: usdc.contract!.checksummed, isAddress: true, name: "USDC"))
        #expect(rows[2].name == SiteWording.unknownAddress)
        #expect(rows[4].value == "at 1793836800")
        // Its address is already the token, so there's no Contract row.
        #expect(row("Contract", in: rows) == nil)
        #expect(ReviewRows.message(review) == nil)
        #expect(ReviewRows.data(review) == review.body)
    }

    @Test func permit2SaysWhoItsThroughAndWhenItEnds() throws {
        let json = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},"primaryType":"PermitSingle","message":{"details":{"token":"\#(usdc.contract!.lowercased)","amount":"250000000","expiration":"1796428800","nonce":"0"},"spender":"0x6ff5693b99212da76ad316178a184ab56d299b43","sigDeadline":"1793838600"}}"#
        let rows = ReviewRows.rows(try typed(json))
        #expect(labels(rows) == ["Can spend", "Token", "Spender", "Allowed until", "Must be used by", "Contract"])
        #expect(row("Allowed until", in: rows)?.value == "at 1796428800")
        #expect(row("Spender", in: rows)?.name == "Uniswap")
        #expect(row("Contract", in: rows)?.name == "Uniswap Permit2")
    }

    @Test func aPermit2TransferCanOnlyTakeAndHasNoEndDate() throws {
        let json = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"PermitTransferFrom":[{"name":"permitted","type":"TokenPermissions"},{"name":"spender","type":"address"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],"TokenPermissions":[{"name":"token","type":"address"},{"name":"amount","type":"uint256"}]},"primaryType":"PermitTransferFrom","message":{"permitted":{"token":"\#(usdc.contract!.lowercased)","amount":"200000000"},"spender":"\#(friend.lowercased)","nonce":"7","deadline":"1793836800"}}"#
        let rows = ReviewRows.rows(try typed(json))
        #expect(labels(rows) == ["Can take", "Token", "Spender", "Must be used by", "Contract"])
    }

    @Test func aPermitForATokenOffTheListSaysSo() throws {
        let json = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"PermitTransferFrom":[{"name":"permitted","type":"TokenPermissions"},{"name":"spender","type":"address"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],"TokenPermissions":[{"name":"token","type":"address"},{"name":"amount","type":"uint256"}]},"primaryType":"PermitTransferFrom","message":{"permitted":{"token":"\#(scam.lowercased)","amount":"7"},"spender":"\#(friend.lowercased)","nonce":"7","deadline":"1793836800"}}"#
        #expect(row("Token", in: ReviewRows.rows(try typed(json)))?.name == "Unknown token")
    }

    @Test func aMessageIsShownAsItIs() {
        let message = MessageReview(personal: Array("Sign in".utf8), origin: "https://example.com")
        #expect(ReviewRows.rows(message).isEmpty)
        #expect(ReviewRows.message(message) == "Sign in")
        #expect(ReviewRows.data(message) == nil)
    }

    @Test func aMessageNamingAContractShowsIt() throws {
        let json = #"{"domain":{"name":"Thing","chainId":8453,"verifyingContract":"\#(scam.lowercased)"},"types":{"Hello":[{"name":"text","type":"string"}]},"primaryType":"Hello","message":{"text":"hi"}}"#
        let rows = ReviewRows.rows(try typed(json))
        #expect(rows == [ConfirmationRow(label: "Contract", value: scam.checksummed, isAddress: true, name: SiteWording.unknownContract)])
    }

    // MARK: Connecting

    @Test func connectingSaysWhatItCanAndCantDo() {
        let connect = ReviewRows.connect()
        #expect(connect.hero == .words("Connect to \(HotWalletWording.title)"))
        #expect(connect.rows == [
            ConfirmationRow(label: "It can see", value: "This wallet's address and balances"),
            ConfirmationRow(label: "It can't", value: "Move anything without you, or see your savings"),
        ])
    }

    // MARK: Fees

    @Test func everyFeeRowReadsTheSame() {
        #expect(ConfirmationRow.networkFee("$0.01") == ConfirmationRow(label: "Network fee", value: "About $0.01"))
        #expect(ConfirmationRow.networkFee(usdMicros: 2 * Money.dollar, wei: 1, money: money).value == "About $2")
        #expect(ConfirmationRow.networkFee(usdMicros: nil, wei: oneEth, money: money).value == "About 1 ETH")
    }
}
