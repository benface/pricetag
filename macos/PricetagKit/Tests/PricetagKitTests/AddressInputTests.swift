import Foundation
import Testing
@testable import PricetagKit

@Suite struct AddressInputTests {
    private let address = "0x52908400098527886E0F7030069857D2E4169EE7"
    private let treasury = WalletEntry(address: "0x00000000000000000000000000000000c0ffee01", name: "Treasury", kind: .watching)
    private let savings = WalletEntry(address: "0x00000000000000000000000000000000c0ffee02", name: "Ledger", kind: .savings)
    private let recent = WalletEntry(address: "0x00000000000000000000000000000000beef0003", name: nil, kind: .watching)

    // MARK: What the field makes of it

    @Test func saysNothingWhileItsStillBeingTyped() {
        #expect(AddressInput(text: "") == .empty)
        #expect(AddressInput(text: "  \n") == .empty)
        #expect(AddressInput(text: "0") == .typing(digits: 0))
        #expect(AddressInput(text: "0x") == .typing(digits: 0))
        #expect(AddressInput(text: "0x5290") == .typing(digits: 4))
        #expect(AddressInput(text: "Trea") == .searching)
    }

    @Test func returnSaysWhatsMissing() {
        #expect(AddressInput(text: "0x5290", isSubmitted: true) == .problem(Wording.notAnAddress))
        #expect(AddressInput(text: "Trea", isSubmitted: true) == .problem(Wording.notAnAddress))
        #expect(AddressInput(text: "Trea", isSubmitted: true, hasMatches: true) == .searching)
    }

    @Test func saysAtOnceWhatTypingMoreCantFix() {
        #expect(AddressInput(text: "0xzz") == .problem(Wording.notAnAddress))
        // A transaction hash, or anything else that long.
        #expect(AddressInput(text: "0x" + String(repeating: "a", count: 64)) == .problem(Wording.notAnAddress))
        #expect(AddressInput(text: "0x3762…5D89") == .problem(Wording.addressIsShortened))
        #expect(AddressInput(text: "0x3762...5D89") == .problem(Wording.addressIsShortened))
    }

    @Test func aNameCanLookAlmostLikeAnything() {
        #expect(AddressInput(text: "0xford", hasMatches: true) == .searching)
        #expect(AddressInput(text: "Mom...", hasMatches: true) == .searching)
    }

    @Test func whereItMovesMoneyOnlyAnAddressWillDo() {
        let strict: (String) -> String? = { WalletAddress.isValid($0) ? $0 : nil }
        #expect(AddressInput(text: address, read: strict) == .address)
        #expect(AddressInput(text: " \(address)\n", read: strict) == .address)
        // A payment request's address is usually a token's contract.
        #expect(AddressInput(text: "ethereum:\(address)?value=1", read: strict) == .problem(Wording.addressWithExtras))
        #expect(AddressInput(text: "\(address) \(treasury.address)", read: strict) == .problem(Wording.addressWithExtras))
    }

    @Test func wholeButWrongIsATypo() {
        #expect(AddressInput(text: address, read: { _ in nil }) == .problem(Wording.addressHasATypo))
    }

    @Test func whereItOnlyLooksAnAddressAnywhereWillDo() {
        #expect(AddressInput(text: "https://basescan.org/address/\(address)") == .address)
        #expect(WalletAddress.pasted(in: "base:\(address)") == address)
        #expect(WalletAddress.find(in: "base:\(address)") == address.lowercased())
    }

    @Test func findsEveryDifferentAddress() {
        #expect(WalletAddress.all(in: "\(address)\n\(treasury.address), \(address.lowercased())") == [address, treasury.address])
    }

    // MARK: Pasting several

    private let other = "0x00000000000000000000000000000000c0ffee01"

    @Test func takesEveryAddressHoweverTheyreSeparated() throws {
        let sorted = try #require(AddressInput.sort("\(address)\n \(other), ", read: WalletAddress.pasted(in:)))
        #expect(sorted.addresses == [address, other])
        #expect(sorted.rest.isEmpty)
    }

    @Test func keepsWhatItCantAdd() throws {
        // A short one, one with a bad character, and one that fails its checksum, wherever they fall.
        let checksummed: (String) -> String? = { [other] in $0 == other ? $0 : nil }
        let cases = [
            ("\(other)\n0x2222", "0x2222"),
            ("\(other)\n0x22zz", "0x22zz"),
            ("0x2222 \(other)", "0x2222"),
            ("\(other)\n\(address)", address),
            ("\(other) 0x2222, \(other) nope", "0x2222 nope"),
        ]
        for (text, rest) in cases {
            let sorted = try #require(AddressInput.sort(text, read: checksummed))
            #expect(sorted.rest == rest)
            #expect(!sorted.addresses.isEmpty)
        }
    }

    @Test func aNameBeingTypedIsntAPaste() {
        #expect(AddressInput.sort("My Treasury", read: WalletAddress.pasted(in:)) == nil)
        #expect(AddressInput.sort("0x2222 0x3333", read: WalletAddress.pasted(in:)) == nil)
        #expect(AddressInput.sort(address, read: WalletAddress.pasted(in:)) == nil)
    }

    /// Whatever's left says what's wrong with it, or it would look like it had been added.
    @Test func whatsLeftSaysWhatsWrong() {
        #expect(AddressInput(text: "0x2222", isSubmitted: true, takesSeveral: true) == .problem(Wording.notAnAddress))
        #expect(AddressInput(text: address, takesSeveral: true, read: { _ in nil }) == .problem(Wording.addressHasATypo))
        #expect(AddressInput(text: "0x2222 nope", isSubmitted: true, takesSeveral: true) == .problem(Wording.notAllAddresses))
        #expect(AddressInput(text: "0x2222 0x3333", takesSeveral: true) == .problem(Wording.notAllAddresses))
        #expect(AddressInput(text: "\(address) \(other)", takesSeveral: true, read: { _ in nil }) == .problem(Wording.notAllAddresses))
    }

    @Test func aNameWithASpaceIsStillAName() {
        #expect(AddressInput(text: "My Tre", takesSeveral: true) == .searching)
        #expect(AddressInput(text: "My Tre", isSubmitted: true, hasMatches: true, takesSeveral: true) == .searching)
    }

    // MARK: What it offers

    @Test func offersEverythingUntilThereIsSomethingToGoOn() {
        #expect(AddressInput.suggestions(for: " ", in: [treasury, savings]) == [treasury, savings])
    }

    @Test func findsByNameKindAndAddress() {
        let wallets = [treasury, savings, recent]
        #expect(AddressInput.suggestions(for: "trea", in: wallets) == [treasury])
        #expect(AddressInput.suggestions(for: "SAVINGS", in: wallets) == [savings])
        #expect(AddressInput.suggestions(for: "beef", in: wallets) == [recent])
        #expect(AddressInput.suggestions(for: "nothing", in: wallets) == [])
    }

    @Test func aShortenedAddressFindsTheWalletItCameFrom() throws {
        let short = try #require(treasury.shortAddress)
        #expect(AddressInput.suggestions(for: short, in: [treasury, savings]) == [treasury])
    }

    /// A whole address is what it is, even if it's a saved wallet's. Nothing should sit under it asking to replace it.
    @Test func offersNothingOnceItsAnAddress() {
        #expect(AddressInput.suggestions(for: treasury.address, in: [treasury, savings]) == [])
    }
}
