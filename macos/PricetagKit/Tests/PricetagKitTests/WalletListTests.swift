import Foundation
import Testing
@testable import PricetagKit

private let a = "0x" + String(repeating: "a", count: 40)
private let b = "0x" + String(repeating: "b", count: 40)
private let c = "0x" + String(repeating: "c", count: 40)
private let d = "0x" + String(repeating: "d", count: 40)

@MainActor
struct WalletListTests {
    private func date(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: seconds) }

    private func address(_ number: Int) -> String {
        "0x" + String(format: "%040x", number)
    }

    private func makeStore(wallet: String? = nil) -> (PortfolioStore, UserDefaults) {
        let defaults = UserDefaults(suiteName: "wallet-list-\(UUID().uuidString)")!
        if let wallet { defaults.set(wallet, forKey: "wallet") }
        return (PortfolioStore(defaults: defaults, makeSource: { _ in ScriptedSource(Array(repeating: .failure(.unreachable), count: 50)) }), defaults)
    }

    @Test func eachAddressAppearsOnceAsTheMostItIs() {
        let list = WalletList(
            spending: NamedWallet(address: a, name: "Spending Money"),
            savings: [NamedWallet(address: b, name: "Ledger")],
            linked: [a, b, c],
            saved: [SavedWallet(address: a, name: "Old name", lastSeen: date(3)), SavedWallet(address: b, lastSeen: date(2)), SavedWallet(address: c, name: "Laptop", lastSeen: date(1))],
            current: a
        )
        #expect(list.yours.map(\.address) == [a, b, c])
        #expect(list.yours.map(\.kind) == [.spendingMoney, .savings, .yours])
        #expect(list.yours.map(\.title) == ["Spending Money", "Ledger", "Laptop"])
        #expect(list.watching.isEmpty)
        #expect(list.recent.isEmpty)
    }

    @Test func namedWalletsKeepTheirPlaceAndRecentOnesMove() {
        let saved = [
            SavedWallet(address: a, name: "zeta", lastSeen: date(9)),
            SavedWallet(address: b, name: "Alpha", lastSeen: date(1)),
            SavedWallet(address: c, lastSeen: date(1)),
            SavedWallet(address: d, lastSeen: date(2)),
        ]
        let list = WalletList(spending: nil, savings: [], linked: [], saved: saved, current: nil)
        #expect(list.watching.map(\.title) == ["Alpha", "zeta"])
        #expect(list.recent.map(\.address) == [d, c])
        #expect((list.watching + list.recent).allSatisfy { $0.kind == .watching && !$0.kind.isOwn })
    }

    @Test func aWalletBeingShownIsAlwaysListed() {
        let list = WalletList(spending: nil, savings: [], linked: [], saved: [], current: a)
        #expect(list.entry(for: a)?.kind == .watching)
        #expect(WalletList(spending: nil, savings: [], linked: [], saved: [], current: WalletAddress.demo).recent.isEmpty)
    }

    @Test func aProofLinksToTheUsersOwnWalletsAndNeverAWatchedOne() throws {
        let list = WalletList(spending: nil, savings: [], linked: [a, b], saved: [SavedWallet(address: c, lastSeen: date(1)), SavedWallet(address: d, name: "Treasury", lastSeen: date(1))], current: b)
        let watched = try #require(list.entry(for: d))
        #expect(list.proof(of: watched, current: b) == WalletProof(address: d, owner: b, title: "Treasury"), "the one showing, when it's theirs")
        #expect(list.proof(of: watched, current: c).owner == a, "another of theirs, when it's not")
        let alone = WalletList(spending: nil, savings: [], linked: [], saved: [SavedWallet(address: c, lastSeen: date(1))], current: nil)
        #expect(alone.proof(of: try #require(alone.entry(for: c)), current: c).owner == c, "with nothing else, it speaks for itself")
        #expect(list.proof(of: watched, current: b).message == Wording.linkMessage(owner: b, address: d))
        let demoSavings = "0x00000000000000000000000000000000000de301"
        let answered = WalletList(spending: nil, savings: [], linked: [demoSavings], saved: [SavedWallet(address: c, lastSeen: date(1))], current: demoSavings)
        #expect(answered.proof(of: try #require(answered.entry(for: c)), current: demoSavings).owner == c, "the demo's wallets aren't anyone's, even after answering for them")
        let both = WalletList(spending: nil, savings: [], linked: [demoSavings, a], saved: [SavedWallet(address: c, lastSeen: date(1))], current: demoSavings)
        #expect(both.proof(of: try #require(both.entry(for: c)), current: demoSavings).owner == a, "not even ahead of a real one")
    }

    @Test func onlyWhatTheUserSaidCanBeTakenBack() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Ledger")], linked: [a, b, c, d], accounts: [a, b, c], saved: [], current: nil)
        #expect(list.yours.map(\.canUnlink) == [false, false, false, true], "a key that's been replaced stays, whatever anyone says")
        #expect(!list.yours.contains { $0.canProve })
    }

    @Test func eachRowSaysWhatItsTitleDoesnt() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Savings"), NamedWallet(address: c, name: "Ledger")], linked: [], saved: [], current: d)
        let short = { (address: String) in Format.shortHash(address) }
        #expect(list.entry(for: a)?.detail == short(a))
        #expect(list.entry(for: a)?.badge == nil)
        #expect(list.entry(for: b)?.detail == short(b))
        #expect(list.entry(for: c)?.detail == "Savings · \(short(c))")
        #expect(list.entry(for: c)?.badge == "Savings")
        #expect(list.entry(for: d)?.title == short(d))
        #expect(list.entry(for: d)?.detail == "Watching")
        #expect(list.entry(for: d)?.badge == "Watching")
        let named = WalletList(spending: nil, savings: [], linked: [], saved: [SavedWallet(address: a, name: "Treasury", lastSeen: date(1))], current: a)
        #expect(named.entry(for: a)?.detail == short(a), "Its section says Watching")
        #expect(named.entry(for: a)?.badge == "Watching", "The toolbar has no section")
        #expect(list.demo?.title == "Demo Wallet")
        #expect(list.demo?.detail == "Sample data")
        #expect(list.demo?.badge == nil)
    }

    @Test func theDemoIsOnlyThereWhereItsOffered() {
        #expect(WalletList(spending: nil, savings: [], linked: [], saved: [], current: nil, offersDemo: false).all.isEmpty)
        let showing = WalletList(spending: nil, savings: [], linked: [], saved: [], current: WalletAddress.demo, offersDemo: false)
        #expect(showing.entry(for: WalletAddress.demo)?.kind == .demo, "It can't vanish while it's what's showing")
    }

    @Test func onlyAWatchedWalletCanBeRemovedHere() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Savings")], linked: [c], saved: [], current: d)
        #expect(list.all.filter(\.canRemove).map(\.address) == [d])
        #expect(list.all.filter(\.canRename).map(\.address) == [b, c, d])
    }

    @Test func removingAWalletNeverFallsBackToTheDemo() {
        let alone = WalletList(spending: nil, savings: [], linked: [], saved: [], current: a)
        #expect(alone.next(afterRemoving: a) == nil)
        let others = WalletList(spending: NamedWallet(address: b, name: "Spending Money"), savings: [], linked: [], saved: [], current: a)
        #expect(others.next(afterRemoving: a) == b)
    }

    @Test func findsTheAddressInWhateverWasPasted() {
        let mixed = "0x" + String(repeating: "aB", count: 20)
        #expect(WalletAddress.find(in: a) == a)
        #expect(WalletAddress.find(in: "  \(mixed)\n") == mixed.lowercased())
        #expect(WalletAddress.find(in: "base:\(a)") == a)
        #expect(WalletAddress.find(in: "https://basescan.org/address/\(a)#tokentxns") == a)
        #expect(WalletAddress.find(in: "\(a), \(a.uppercased().replacingOccurrences(of: "0X", with: "0x"))") == a)
        #expect(WalletAddress.find(in: "\(a) \(b)") == nil)
        #expect(WalletAddress.find(in: "0x" + String(repeating: "a", count: 64)) == nil)
        #expect(WalletAddress.find(in: "0x" + String(repeating: "a", count: 39)) == nil)
        #expect(WalletAddress.find(in: "test test test") == nil)
    }

    @Test func saysAPasteIsWrongOnlyOnceItCantBecomeAnAddress() {
        #expect(!WalletAddress.isTooLong("0x1234"))
        #expect(!WalletAddress.isTooLong(a))
        #expect(WalletAddress.isTooLong("0x" + String(repeating: "a", count: 64)))
        #expect(WalletAddress.isTooLong("\(a) \(b)"))
    }

    @Test func lookingAtAWalletRemembersIt() throws {
        let (store, defaults) = makeStore()
        store.setWallet(a.uppercased().replacingOccurrences(of: "0X", with: "0x"))
        store.setWallet(WalletAddress.demo)
        #expect(store.savedWallets.map(\.address) == [a], "The demo isn't a wallet anyone needs to remember")
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in ScriptedSource(Array(repeating: .failure(.unreachable), count: 50)) })
        #expect(reopened.savedWallets.map(\.address) == [a])
    }

    @Test func aWalletFromBeforeTheListIsRemembered() {
        #expect(makeStore(wallet: a).0.savedWallets.map(\.address) == [a])
        #expect(makeStore(wallet: WalletAddress.demo).0.savedWallets.isEmpty)
    }

    @Test func onlyTheLastFewUnnamedWalletsAreKept() {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.renameWallet(a, to: "Keeper")
        for number in 1...8 { store.setWallet(address(number)) }
        let list = WalletList(spending: nil, savings: [], linked: [], saved: store.savedWallets, current: store.address)
        #expect(list.watching.map(\.address) == [a])
        #expect(list.recent.count == SavedWallet.recentLimit)
        #expect(list.recent.first?.address == address(8))
        #expect(store.savedWallets.count == SavedWallet.recentLimit + 1)
    }

    @Test func ownWalletsDontUseUpTheRecentOnes() {
        let saved = (1...5).map { SavedWallet(address: address($0), lastSeen: date(Double($0))) } + [SavedWallet(address: a, lastSeen: date(100))]
        let next = SavedWallet.seeing(address(6), at: date(200), in: saved, own: [a])
        #expect(next.count == 6)
        #expect(next.contains { $0.address == a })
        #expect(!next.contains { $0.address == address(1) })
    }

    @Test func aNameCanBeGivenChangedAndTakenAway() {
        let (store, _) = makeStore()
        store.renameWallet(a, to: "  ")
        #expect(store.savedWallets.isEmpty, "Nothing to keep yet")
        store.renameWallet(a, to: " Treasury ")
        #expect(store.savedWallets.first?.name == "Treasury")
        store.renameWallet(a, to: "")
        #expect(store.savedWallets.first?.name == nil)
    }

    @Test func removingTheWalletShowingMovesOn() {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.setWallet(b)
        store.removeWallet(a, showing: nil)
        #expect(store.address == b, "It wasn't the one showing")
        #expect(store.savedWallets.map(\.address) == [b])
        store.setWallet(c)
        store.removeWallet(c, showing: b)
        #expect(store.address == b)
        store.removeWallet(b, showing: nil)
        #expect(store.address == nil)
        #expect(store.feed == .noWallet)
    }
}
