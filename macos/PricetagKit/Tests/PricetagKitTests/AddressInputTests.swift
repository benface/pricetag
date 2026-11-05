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
