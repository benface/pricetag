import Foundation
@testable import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

private let usdcText = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
private let universalRouter = "0x6ff5693b99212da76ad316178a184ab56d299b43"
private let permit2 = "0x000000000022d473030f116ddee9f6b43ac78ba3"
private let stranger = "0x4444444444444444444444444444444444444444"
private let max256 = "115792089237316195423570985008687907853269984665640564039457584007913129639935"

private func known(_ text: String, _ symbol: String) -> CallPreview.Asset {
    .known(ReviewAmount(text: text, symbol: symbol, usdMicros: nil))
}

private func review(_ json: String) throws -> MessageReview {
    try MessageReview(typed: TypedData(.string(json)), formatDate: { "at \(Int($0.timeIntervalSince1970))" })
}

private func eip2612(spender: String = stranger, value: String, token: String = usdcText, chain: String = "8453", deadline: String = "1793836800") -> String {
    #"{"domain":{"name":"USD Coin","version":"2","chainId":\#(chain),"verifyingContract":"\#(token)"},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(hotAddress.lowercased)","spender":"\#(spender)","value":"\#(value)","nonce":"0","deadline":"\#(deadline)"}}"#
}

private func permitSingle(amount: String, expiration: String, verifyingContract: String = permit2) -> String {
    #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"\#(verifyingContract)"},"types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},"primaryType":"PermitSingle","message":{"details":{"token":"\#(usdcText)","amount":"\#(amount)","expiration":"\#(expiration)","nonce":"0"},"spender":"\#(universalRouter)","sigDeadline":"1793838600"}}"#
}

@Suite struct PreviewTitleTests {
    private func title(gives: [CallPreview.Asset], gets: [CallPreview.Asset], allowances: [CallPreview.Allowance] = []) -> String? {
        CallPreview(gives: gives, gets: gets, allowances: allowances).title
    }

    @Test func oneForAnotherIsASwap() {
        #expect(title(gives: [known("200", "USDC")], gets: [known("0.0757", "ETH")]) == "Swap 200 USDC for about 0.0757 ETH")
        #expect(title(gives: [known("200", "USDC")], gets: []) == "Send about 200 USDC")
        #expect(title(gives: [], gets: [known("12", "AERO")]) == "Get about 12 AERO")
    }

    /// Anything more than the title can say in a few words is left to the rows, with a title that says it isn't clear.
    @Test func anythingElseIsntClear() {
        let unknown = CallPreview.Asset.unknown(contract: EthereumAddress(stranger)!)
        #expect(title(gives: [], gets: []) == nil)
        #expect(title(gives: [known("200", "USDC")], gets: [unknown]) == nil)
        #expect(title(gives: [unknown], gets: [known("1", "ETH")]) == nil)
        #expect(title(gives: [known("200", "USDC"), known("1", "DAI")], gets: [known("1", "ETH")]) == nil)
        let allowance = CallPreview.Allowance(spender: EthereumAddress(stranger)!, words: "all of your USDC", unknownContract: nil, isCollection: false, asset: "USDC", isUnlimited: true)
        #expect(title(gives: [known("200", "USDC")], gets: [known("1", "ETH")], allowances: [allowance]) == nil)
    }

    @Test func aCallWithNoClearPreviewSaysSoOnScreen() {
        let quote = SiteQuote(gasLimit: 60000, maxFeePerGas: 1, feeWei: 1, ethUsdMicros: nil, ethBalance: 1 << 64)
        let call = TransactionReview(SiteTransaction(to: EthereumAddress(stranger)!, value: 0, data: [0x12, 0x34, 0x56, 0x78]), quote: quote)
        #expect(call.title == SiteWording.unclear)
        #expect(call.headline == "Approve a request this app can't read")
        var previewed = quote
        previewed.preview = CallPreview(gives: [known("200", "USDC")], gets: [known("0.0757", "ETH")], allowances: [])
        let swap = TransactionReview(SiteTransaction(to: EthereumAddress(stranger)!, value: 0, data: [0x12, 0x34, 0x56, 0x78]), quote: previewed)
        #expect(swap.title == "Swap 200 USDC for about 0.0757 ETH")
        // A call it can read keeps its own words.
        let send = TransactionReview(SiteTransaction(to: EthereumAddress(stranger)!, value: 1_000_000_000_000_000, data: []), quote: quote)
        #expect(send.title == send.headline)
    }
}

@Suite struct KnownContractTests {
    @Test func aKnownNameGoesBesideTheAddressNeverInstead() {
        #expect(SiteWording.who(EthereumAddress(universalRouter)!) == "Uniswap (0x6fF5…9b43)")
        #expect(SiteWording.who(EthereumAddress(stranger)!) == "0x4444…4444")
        #expect(KnownContracts.name(of: EthereumAddress(usdcText)!) == "USDC")
    }

    @Test func everyNameIsForADifferentAddressAndNoneLooksLikeAToken() {
        let symbols = Set(Base.tokens.map(\.symbol))
        for (address, name) in KnownContracts.names {
            #expect(!symbols.contains(name), "\(name)")
            #expect(Base.tokens.allSatisfy { $0.contract != address }, "\(name)")
        }
    }

    @Test func anApprovalToAKnownRouterNamesIt() {
        let quote = SiteQuote(gasLimit: 60000, maxFeePerGas: 1, feeWei: 1, ethUsdMicros: nil, ethBalance: 1 << 64)
        let data = Hex.decode("095ea7b3" + String(repeating: "0", count: 24) + universalRouter.dropFirst(2) + String(repeating: "f", count: 64))!
        let approval = TransactionReview(SiteTransaction(to: EthereumAddress(usdcText)!, value: 0, data: data), quote: quote)
        #expect(approval.headline == "Let Uniswap (0x6fF5…9b43) spend all of your USDC")
    }
}

@Suite struct PermitTests {
    @Test func anUnlimitedPermitSaysUnlimitedAndARealDate() throws {
        let message = try review(eip2612(value: max256))
        let permit = try #require(message.permit)
        #expect(permit.kind == .allowance)
        #expect(permit.amount == "Unlimited")
        #expect(permit.tokenSymbol == "USDC")
        #expect(permit.spender == EthereumAddress(stranger))
        // EIP-2612 sets an allowance that never runs out by itself. Only the signature has a deadline.
        #expect(permit.allowedUntil == "No end date")
        #expect(permit.mustBeUsedBy == "at 1793836800")
        #expect(message.headline == "Let 0x4444…4444 spend all of your USDC")
        // Nothing gets easier to approve.
        #expect(message.warnings.first?.isStrong == true)
        // What's signed is still all there, one click away.
        #expect(message.body.contains("value: \(max256)"))
    }

    @Test func aLimitedPermitSaysHowMuch() throws {
        #expect(try review(eip2612(value: "250000000")).permit?.amount == "250 USDC")
        #expect(try review(eip2612(value: "250000000")).headline == "Let 0x4444…4444 spend up to 250 USDC")
        #expect(try review(eip2612(value: "0")).headline == "Stop 0x4444…4444 from spending your USDC")
    }

    /// A token off the list has no decimals anyone can trust, so it's units, and it's named as unknown.
    @Test func aTokenOffTheListIsntGivenAName() throws {
        let permit = try #require(try review(eip2612(value: "250000000", token: stranger)).permit)
        #expect(permit.tokenSymbol == nil)
        #expect(permit.amount == "250000000 units")
        #expect(permit.headline == "Let 0x4444…4444 spend up to 250000000 units")
    }

    @Test func aDeadlineNoCalendarShowsHasNoEnd() throws {
        #expect(try review(eip2612(value: "1", deadline: max256)).permit?.mustBeUsedBy == "No end date")
    }

    /// The token list is Base's. Anything that isn't tied to Base is shown as it is, with its warnings.
    @Test func aPermitThatIsntTiedToBaseIsntRead() throws {
        let json = eip2612(value: max256).replacingOccurrences(of: #""chainId":8453,"#, with: "")
        let message = try review(json)
        #expect(message.permit == nil)
        #expect(message.warnings.contains(SiteWarning(SiteWording.anyChain, isStrong: true)))
    }

    @Test func permit2NamesTheSpenderAndWhenItEnds() throws {
        let message = try review(permitSingle(amount: "250000000", expiration: "1796428800"))
        let permit = try #require(message.permit)
        #expect(permit.kind == .permit2Allowance)
        #expect(permit.amount == "250 USDC")
        #expect(permit.allowedUntil == "at 1796428800")
        #expect(permit.mustBeUsedBy == "at 1793838600")
        #expect(message.headline == "Let Uniswap (0x6fF5…9b43) spend up to 250 USDC")
        #expect(message.warnings.first?.text.contains("Uniswap (0x6fF5…9b43)") == true)
        // Permit2's own maximum, 2^160 - 1.
        #expect(try review(permitSingle(amount: "1461501637330902918203684832716283019655932542975", expiration: "0")).permit?.amount == "Unlimited")
        #expect(try review(permitSingle(amount: "1", expiration: "0")).permit?.allowedUntil == "As soon as it's used")
    }

    /// The same shape from anywhere but Permit2 is something else, which has to be shown as it is.
    @Test func permit2sShapeFromAnotherContractIsntRead() throws {
        #expect(try review(permitSingle(amount: "1", expiration: "1", verifyingContract: stranger)).permit == nil)
    }

    @Test func aOneTimeTransferSaysOnce() throws {
        let json = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"\#(permit2)"},"types":{"PermitTransferFrom":[{"name":"permitted","type":"TokenPermissions"},{"name":"spender","type":"address"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}],"TokenPermissions":[{"name":"token","type":"address"},{"name":"amount","type":"uint256"}]},"primaryType":"PermitTransferFrom","message":{"permitted":{"token":"\#(usdcText)","amount":"200000000"},"spender":"\#(stranger)","nonce":"7","deadline":"1793836800"}}"#
        let message = try review(json)
        #expect(message.permit?.kind == .permit2Transfer)
        #expect(message.permit?.allowedUntil == nil)
        #expect(message.headline == "Let 0x4444…4444 take up to 200 USDC, once")
    }

    /// A field more, less or of another type is a different message, whatever it's called.
    @Test func aPermitThatDoesntMatchExactlyIsShownAsItIs() throws {
        let extra = eip2612(value: "1").replacingOccurrences(of: #"{"name":"deadline","type":"uint256"}]"#, with: #"{"name":"deadline","type":"uint256"},{"name":"note","type":"string"}]"#)
            .replacingOccurrences(of: #""deadline":"1793836800"}"#, with: #""deadline":"1793836800","note":"hi"}"#)
        let message = try review(extra)
        #expect(message.permit == nil)
        #expect(message.headline == "Sign this for USD Coin")
        #expect(message.warnings.first?.isStrong == true)
    }
}
