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
        // ETH alone doesn't make it clear: what it's sent for is still unknown.
        let paying = TransactionReview(SiteTransaction(to: EthereumAddress(stranger)!, value: 1_000_000_000_000_000, data: [0x12, 0x34, 0x56, 0x78]), quote: quote)
        #expect(paying.isUnreadableCall)
        #expect(paying.title == SiteWording.unclear)
        #expect(paying.headline == "Send 0.001 ETH with a request this app can't read")
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
    }

    /// Signing a permit for nothing changes nothing until it's sent, and the site can keep it, so the words never say it stops anything.
    @Test func aPermitForNothingIsOnlyARequest() throws {
        let zero = try review(eip2612(value: "0"))
        #expect(zero.headline == "Sign a request to stop 0x4444…4444 spending your USDC")
        #expect(zero.warnings.contains(SiteWarning(SiteWording.removalIsOnlyARequest(spender: "0x4444…4444"))))
        let permit2 = try review(permitSingle(amount: "0", expiration: "1796428800"))
        #expect(permit2.headline == "Sign a request to stop Uniswap (0x6fF5…9b43) spending your USDC")
        #expect(permit2.warnings.contains(SiteWarning(SiteWording.removalIsOnlyARequest(spender: "Uniswap (0x6fF5…9b43)"))))
        // Nothing gets easier to approve.
        #expect(zero.warnings.first?.isStrong == true)
        #expect(try review(eip2612(value: "1")).warnings.allSatisfy { $0.text != SiteWording.removalIsOnlyARequest(spender: "0x4444…4444") })
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
        // Zero is the block it's used in, which can hold more than one transfer up to the amount, so it isn't once or instant.
        #expect(try review(permitSingle(amount: "1", expiration: "0")).permit?.allowedUntil == "Only the few seconds it's used in")
        #expect(try review(permitSingle(amount: "1", expiration: "1")).permit?.allowedUntil == "at 1")
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
        #expect(message.title == "Sign this for USD Coin")
        #expect(message.headline == "Sign this message")
        #expect(message.warnings.first?.isStrong == true)
    }
}

private func note(domain: String = #""name":"x","chainId":8453"#, text: String) -> String {
    #"{"domain":{\#(domain)},"types":{"Note":[{"name":"text","type":"string"}]},"primaryType":"Note","message":{"text":"\#(text)"}}"#
}

/// What a site could otherwise get past the warnings that make someone stop and read.
@Suite struct StrongWarningTests {
    private let quote = SiteQuote(gasLimit: 60000, maxFeePerGas: 1, feeWei: 1, ethUsdMicros: nil, ethBalance: 1 << 64)
    private let spenderWord = String(repeating: "0", count: 24) + stranger.dropFirst(2)
    private let usdcWord = String(repeating: "0", count: 24) + usdcText.dropFirst(2)

    private func amountWord(_ amount: UInt128) -> String {
        let hex = String(amount, radix: 16)
        return String(repeating: "0", count: 64 - hex.count) + hex
    }

    private func call(to: String = usdcText, _ selector: String, _ arguments: String...) -> TransactionReview {
        TransactionReview(SiteTransaction(to: EthereumAddress(to)!, value: 0, data: Hex.decode(selector + arguments.joined())!), quote: quote)
    }

    private static let approve = "095ea7b3"
    private static let increaseAllowance = "39509351"
    private static let setApprovalForAll = "a22cb465"
    private static let transfer = "a9059cbb"

    // MARK: Near-unlimited approvals

    /// 2^96 - 1 of a token with 6 decimals is 79 sextillion of it.
    @Test func justUnderTheOldLineIsStillUnlimited() throws {
        let nearly = (UInt128(1) << 96) - 1
        for selector in [Self.approve, Self.increaseAllowance] {
            let review = call(selector, spenderWord, amountWord(nearly))
            #expect(review.headline == "Let 0x4444…4444 spend all of your USDC")
            #expect(review.warnings.first == SiteWarning(SiteWording.unlimited(spender: "0x4444…4444", asset: "USDC"), isStrong: true))
        }
        let permit2 = call(to: Base.permit2.lowercased, "87517c45", usdcWord, spenderWord, amountWord(nearly), amountWord(1))
        #expect(permit2.headline == "Let 0x4444…4444 spend all of your USDC")
        #expect(permit2.warnings.first?.isStrong == true)
        let permit = try review(eip2612(value: String(nearly)))
        #expect(permit.permit?.amount == "Unlimited")
        #expect(permit.headline == "Let 0x4444…4444 spend all of your USDC")
    }

    @Test func theLineIsWhereItSaysForEachToken() {
        let usdcBillion: UInt128 = 1_000_000_000 * 1_000_000
        #expect(call(Self.approve, spenderWord, amountWord(usdcBillion - 1)).warnings.filter(\.isStrong).isEmpty)
        #expect(call(Self.approve, spenderWord, amountWord(usdcBillion - 1)).headline == "Let 0x4444…4444 spend up to 999999999.999999 USDC")
        #expect(call(Self.approve, spenderWord, amountWord(usdcBillion)).warnings.first?.isStrong == true)
        // Decimals alone wouldn't catch this: a billion WETH is a thousand times as many as exist.
        let weth = Base.tokens.first { $0.symbol == "WETH" }
        #expect(TransactionReview.isUnlimited(1_000_000 * 1_000_000_000_000_000_000, of: weth))
        #expect(!TransactionReview.isUnlimited(1_000_000 * 1_000_000_000_000_000_000 - 1, of: weth))
    }

    /// A token added to the list without a line of its own would fall back to one that's far too high.
    @Test func everyTokenOnTheListHasItsOwnLine() {
        for token in Base.tokens where !token.isNative {
            #expect(TransactionReview.isUnlimited((UInt128(1) << 96) - 1, of: token), "\(token.symbol)")
            let one = (0..<token.decimals).reduce(UInt128(1)) { units, _ in units * 10 }
            #expect(!TransactionReview.isUnlimited(one, of: token), "\(token.symbol)")
        }
    }

    /// With no decimals to go by, no amount can be called small.
    @Test func anyAmountOfATokenOffTheListIsStrong() {
        let review = call(to: stranger, Self.approve, spenderWord, amountWord(5))
        #expect(review.warnings.contains(SiteWarning(SiteWording.unknownAllowance(spender: "0x4444…4444"), isStrong: true)))
        let unlimited = call(to: stranger, Self.increaseAllowance, spenderWord, amountWord(1 << 96))
        #expect(unlimited.warnings.first == SiteWarning(SiteWording.unlimited(spender: "0x4444…4444", asset: "tokens at 0x4444…4444"), isStrong: true))
        let onPermit2 = call(to: Base.permit2.lowercased, "87517c45", spenderWord, spenderWord, amountWord(5), amountWord(1))
        #expect(onPermit2.headline == "Let 0x4444…4444 spend up to 5 units of this token")
        #expect(onPermit2.warnings.first == SiteWarning(SiteWording.unknownAllowance(spender: "0x4444…4444"), isStrong: true))
    }

    // MARK: Typed data that isn't a shape anyone checked

    @Test func anyShapeThatIsntCheckedIsStrong() throws {
        let contract = #""chainId":8453,"verifyingContract":"\#(stranger)""#
        let shapes = [
            #"{"domain":{\#(contract)},"types":{"ForwardRequest":[{"name":"from","type":"address"},{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"gas","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"data","type":"bytes"}]},"primaryType":"ForwardRequest","message":{"from":"\#(stranger)","to":"\#(stranger)","value":"0","gas":"1","nonce":"0","data":"0x"}}"#,
            #"{"domain":{\#(contract)},"types":{"MetaTransaction":[{"name":"nonce","type":"uint256"},{"name":"from","type":"address"},{"name":"functionSignature","type":"bytes"}]},"primaryType":"MetaTransaction","message":{"nonce":"0","from":"\#(stranger)","functionSignature":"0x"}}"#,
            #"{"domain":{\#(contract)},"types":{"SafeTx":[{"name":"to","type":"address"},{"name":"value","type":"uint256"},{"name":"data","type":"bytes"}]},"primaryType":"SafeTx","message":{"to":"\#(stranger)","value":"0","data":"0x"}}"#,
            // Only words, but for a contract that can read them however it likes.
            note(domain: contract, text: "hi"),
            note(domain: #""chainId":8453,"salt":"0x\#(String(repeating: "0", count: 64))""#, text: "hi"),
            // No contract, but there's something in it to act on.
            #"{"domain":{"chainId":8453},"types":{"Pay":[{"name":"to","type":"address"}]},"primaryType":"Pay","message":{"to":"\#(stranger)"}}"#,
            #"{"domain":{"chainId":8453},"types":{"Outer":[{"name":"inner","type":"Inner"}],"Inner":[{"name":"text","type":"string"}]},"primaryType":"Outer","message":{"inner":{"text":"hi"}}}"#,
        ]
        for shape in shapes {
            let message = try review(shape)
            #expect(message.warnings.first == SiteWarning(SiteWording.typedUnclear, isStrong: true), "\(shape)")
            #expect(message.headline == "Sign this message", "\(shape)")
        }
    }

    @Test func wordsForNoContractAreTheOneShapeThatsLeftAlone() throws {
        #expect(try review(note(text: "hi")).warnings.isEmpty)
        // What it's called still counts.
        let named = note(text: "hi").replacingOccurrences(of: "Note", with: "Permit")
        #expect(try review(named).warnings.first?.isStrong == true)
    }

    // MARK: Text that pretends to be something else

    @Test func aStringCantLookLikeAnotherField() throws {
        let message = try review(note(text: #"hi\nspender: Uniswap"#))
        #expect(message.body == #"text: hi\nspender: Uniswap"#)
        #expect(!message.body.contains("\n"))
        // Harmless once it's on one line, so it's nothing to warn about.
        #expect(message.warnings.isEmpty)
        for (escaped, code) in [(#"\u2028"#, #"\u{2028}"#), (#"\u2029"#, #"\u{2029}"#), (#"\u0085"#, #"\u{85}"#), (#"\r"#, #"\r"#), (#"\t"#, #"\t"#)] {
            let body = try review(note(text: "a\(escaped)b")).body
            #expect(body == "text: a\(code)b", "\(escaped)")
        }
    }

    @Test func spacesCantPushTextOntoANewLine() throws {
        #expect(try review(note(text: "one two")).body == "text: one two")
        #expect(try review(note(text: "one   two")).body == #"text: one \u{20}\u{20}two"#)
        #expect(try review(note(text: #"one\u3000two"#)).body == #"text: one\u{3000}two"#)
    }

    @Test func charactersThatHideOrRearrangeAreShownAndWarnedAbout() throws {
        for (escaped, code) in [(#"\u202e"#, #"\u{202E}"#), (#"\u200b"#, #"\u{200B}"#), (#"\u0007"#, #"\u{7}"#)] {
            let message = try review(note(text: "safe\(escaped)text"))
            #expect(message.body == "text: safe\(code)text", "\(escaped)")
            #expect(message.warnings == [SiteWarning(SiteWording.hiddenCharacters, isStrong: true)], "\(escaped)")
        }
    }

    @Test func aFieldsNameIsFilteredToo() throws {
        let json = #"{"domain":{"chainId":8453},"types":{"Note":[{"name":"a\nspender","type":"string"}]},"primaryType":"Note","message":{"a\nspender":"Uniswap"}}"#
        #expect(try review(json).body == #"a\nspender: Uniswap"#)
    }

    @Test func aNameThatIsntPlainStaysOffTheTitle() throws {
        #expect(try review(note(domain: #""name":"USD Coin","chainId":8453"#, text: "hi")).title == "Sign this for USD Coin")
        for name in [#"USD\nCoin"#, #"USD\u202eCoin"#, #"USD\u200bCoin"#, "USD  Coin"] {
            let message = try review(note(domain: #""name":"\#(name)","chainId":8453"#, text: "hi"))
            #expect(message.title == "Sign this message", "\(name)")
        }
        #expect(try review(note(domain: #""name":"USD\u202eCoin","chainId":8453"#, text: "hi")).warnings == [SiteWarning(SiteWording.hiddenCharacters, isStrong: true)])
    }

    /// What a permit says comes from what's signed, so nothing a site named things reaches the window or Touch ID.
    @Test func aPermitsTitleIsItsOwn() throws {
        let message = try review(eip2612(value: "250000000").replacingOccurrences(of: "USD Coin", with: "Totally Safe"))
        #expect(message.title == "Let 0x4444…4444 spend up to 250 USDC")
        #expect(message.title == message.headline)
    }

    // MARK: Selectors on contracts off the list

    @Test func aSelectorMeansNothingOffTheList() {
        let cases: [(String, [String], Bool)] = [
            (Self.approve, [spenderWord, amountWord(0)], false),
            (Self.increaseAllowance, [spenderWord, amountWord(0)], false),
            (Self.transfer, [spenderWord, amountWord(5)], false),
            (Self.setApprovalForAll, [spenderWord, amountWord(0)], false),
            (Self.approve, [spenderWord, amountWord(5)], true),
            (Self.setApprovalForAll, [spenderWord, amountWord(1)], true),
            ("d505accf", [spenderWord, spenderWord, amountWord(5), amountWord(1), amountWord(27), amountWord(1), amountWord(2)], true),
        ]
        for (selector, arguments, isStrong) in cases {
            let data = Hex.decode(selector + arguments.joined())!
            let review = TransactionReview(SiteTransaction(to: EthereumAddress(stranger)!, value: 0, data: data), quote: quote)
            #expect(review.isUnreadableCall, "\(selector)")
            #expect(review.headline == "Approve a request this app can't read", "\(selector)")
            #expect(review.title == SiteWording.unclear, "\(selector)")
            #expect(review.recipient == nil && review.spender == nil, "\(selector)")
            #expect(review.warnings.filter(\.isStrong).isEmpty != isStrong, "\(selector)")
        }
    }

    @Test func approveForAllStaysStrongWithoutAnEstimate() {
        let review = call(to: stranger, Self.setApprovalForAll, spenderWord, amountWord(1))
        #expect(review.warnings.first == SiteWarning(SiteWording.unlimited(spender: "0x4444…4444", asset: "items in the collection at 0x4444…4444"), isStrong: true))
    }

    @Test func aReadableCallToTheListIsntAnUnreadableOne() {
        #expect(!call(Self.approve, spenderWord, amountWord(5)).isUnreadableCall)
        #expect(!call(Self.transfer, spenderWord, amountWord(5)).isUnreadableCall)
    }
}
