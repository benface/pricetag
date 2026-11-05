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

    @Test func pickableLeavesOutTheDemo() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Savings")], linked: [c, "0x00000000000000000000000000000000000de300"], saved: [SavedWallet(address: d, name: "Treasury", lastSeen: date(1))], current: WalletAddress.demo)
        #expect(list.pickable.map(\.address) == [a, b, c, d])
    }

    @Test func aPickSaysWhatKindItIsWithNoSectionToSaySo() {
        #expect(WalletEntry(address: a, name: "Treasury", kind: .watching).pickDetail == "Watching · \(Format.shortHash(a))")
        #expect(WalletEntry(address: a, name: nil, kind: .watching).pickDetail == "Watching")
        #expect(WalletEntry(address: a, name: "Savings", kind: .savings).pickDetail == Format.shortHash(a))
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

    @Test func everyWalletCanMoveExceptWhereThatMeansMore() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Ledger")], linked: [a, b, c, d], replacedKeys: [c], saved: [], current: nil)
        #expect(list.yours.map(\.canMoveToWatching) == [false, false, false, true], "a replaced key stays theirs, whatever anyone says")
        #expect(list.yours.map(\.canRemove) == [false, false, true, true], "money and sweeps depend on the first two")
        #expect(!list.yours.contains { $0.canMoveToYours })
        #expect(list.entry(for: b)?.canStopBeingSavings == true)
        #expect(list.entry(for: c)?.detail == "Replaced Key")
    }

    @Test func aWalletMovesToYoursWithoutASignatureAndBack() throws {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.setWallet(b)
        store.renameWallet(a, to: "Laptop")
        store.moveToYours(a)
        #expect(store.book.linkedWallets == [a])
        var list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: store.address)
        #expect(list.yours.map(\.title) == ["Laptop"], "the name goes with it")
        store.moveToWatching(a)
        #expect(store.book.linkedWallets.isEmpty)
        list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: store.address)
        #expect(list.watching.map(\.title) == ["Laptop"])
    }

    @Test func anUnnamedWalletMovedToWatchingStaysThere() {
        let (store, _) = makeStore()
        store.moveToYours(a)
        store.moveToWatching(a)
        for number in 1...8 { store.setWallet(address(number)) }
        let list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: store.address)
        #expect(list.watching.map(\.address) == [a], "It's there because the user put it there")
        #expect(list.watching.first?.canKeep == false)
        #expect(list.recent.first?.canKeep == true)
    }

    @Test func markingAWalletAsYoursDoesntMakeItASavingsWallet() {
        let (store, _) = makeStore()
        store.moveToYours(a)
        let list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: nil)
        #expect(list.entry(for: a)?.kind == .yours)
    }

    @Test func aWalletThatStopsBeingSavingsStaysYoursUnderItsName() {
        let (store, _) = makeStore()
        store.setLinkedWallets([a])
        store.moveToYours(a)
        #expect(store.undoStack.isEmpty, "Saying so about an account changes nothing")
        store.setLinkedWallets([])
        store.renameWallet(a, to: "Ledger")
        store.moveToYours(a)
        #expect(store.book.linkedWallets == [a], "Costs keep following its money")
        let list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: nil)
        #expect(list.yours.map(\.title) == ["Ledger"])
    }

    @Test func removingAWalletOfYoursTakesBackThatItsYours() {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.moveToYours(a)
        store.removeWallet(a, showing: nil)
        #expect(store.book.linkedWallets.isEmpty)
        #expect(store.savedWallets.isEmpty)
        #expect(store.address == nil)
    }

    @Test func aRemovedAccountIsOnlyHiddenAndCostsKeepFollowing() {
        let (store, _) = makeStore()
        store.setLinkedWallets([a])
        store.removeWallet(a, showing: nil)
        #expect(store.book.linkedWallets == [a], "this Mac's wallet still holds it")
        #expect(WalletList(spending: nil, savings: [], linked: [a], replacedKeys: [a], saved: [], current: nil, hidden: store.hiddenWallets).all.count == 1, "only the demo is left")
        #expect(WalletList(spending: nil, savings: [], linked: [a], replacedKeys: [a], saved: [], current: a, hidden: store.hiddenWallets).yours.map(\.address) == [a], "still listed while it's showing")
        store.setWallet(a)
        #expect(store.hiddenWallets.isEmpty, "looking at it brings it back")
    }

    @Test func undoPutsTheWalletBackAsItWas() {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.renameWallet(a, to: "Laptop")
        store.moveToYours(a)
        store.moveWallets(in: [a, b], from: [1], to: 0)
        let depth = store.undoStack.count
        let before = store.changeWallet(a) { store.removeWallet(a, showing: b) }
        #expect(store.address == b)
        store.restore(before)
        #expect(store.address == a)
        #expect(store.book.linkedWallets == [a])
        #expect(store.savedWallets.first { $0.address == a }?.name == "Laptop")
        #expect(store.walletOrder == [b, a])
        #expect(store.undoStack.count == depth)
    }

    @Test func editUndoPutsBackAllOfAWalletChangeAndRedoMakesItAgain() {
        let (store, _) = makeStore()
        store.setWallet(a)
        store.renameWallet(a, to: "Laptop")
        store.moveToYours(a)
        store.moveWallets(in: [a, b], from: [1], to: 0)
        var relinked = 0
        store.changeWallet(a, alsoUndo: { relinked += 1 }) { store.removeWallet(a, showing: b) }
        #expect(store.undoNames.last == "Remove from List")
        store.undo()
        #expect(store.address == a, "the wallet that was showing is showing again")
        #expect(store.book.linkedWallets == [a])
        #expect(store.savedWallets.first { $0.address == a }?.name == "Laptop")
        #expect(store.walletOrder == [b, a])
        #expect(relinked == 1, "and what's outside the store comes back too")
        #expect(store.redoNames == ["Remove from List"])
        store.redo()
        #expect(store.address == b)
        #expect(store.book.linkedWallets.isEmpty)
        #expect(!store.savedWallets.contains { $0.address == a })
        #expect(store.undoNames.last == "Remove from List")
        store.undo()
        #expect(store.savedWallets.first { $0.address == a }?.name == "Laptop", "as often as it's undone")
    }

    @Test func theListsUndoStillFindsAChangeAfterEditUndoAndRedo() {
        let (store, _) = makeStore()
        let move = store.changeWallet(a) { store.moveToYours(a) }
        store.undo()
        store.redo()
        #expect(store.book.linkedWallets == [a])
        store.restore(move)
        #expect(store.book.linkedWallets.isEmpty)
        #expect(store.undoStack.isEmpty, "its entry goes with it, so the next Undo isn't one that does nothing")
        #expect(store.redoStack.isEmpty)
    }

    @Test func undoKeepsACostRecordedSince() throws {
        let (store, defaults) = makeStore()
        let before = store.changeWallet(a) { store.moveToYours(a) }
        store.recordPurchase(Purchase(provider: "coinbase", order: "1", wallet: b, asset: "ETH", units: "1", txHash: "0x1", blockNum: 1, cost: Money(micros: "5000000", currency: .USD), costUsdMicros: "5000000"))
        store.restore(before)
        #expect(store.book.purchases.count == 1)
        #expect(store.book.linkedWallets.isEmpty, "only the move is undone")
        #expect(store.undoStack.isEmpty, "there's nothing left of it to undo")
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in ScriptedSource(Array(repeating: .failure(.unreachable), count: 50)) })
        #expect(reopened.book.purchases.count == 1, "and that's what was saved")
    }

    @Test func undoKeepsAnythingElseChangedSince() {
        let (store, _) = makeStore()
        store.renameWallet(b, to: "Before")
        let before = store.changeWallet(a) { store.moveToWatching(a) }
        store.renameWallet(b, to: "After")
        store.moveToYours(c)
        store.renameWallet(a, to: "Named Since")
        store.restore(before)
        #expect(store.savedWallets.first { $0.address == b }?.name == "After")
        #expect(store.book.linkedWallets == [c], "another answer given since stays")
        #expect(store.undoStack.count == 1, "and it can still be undone")
        store.undo()
        #expect(store.book.linkedWallets.isEmpty)
        #expect(store.savedWallets.first { $0.address == a }?.name == "Named Since", "so does the wallet's own new name")
        #expect(store.savedWallets.first { $0.address == a }?.isKept == nil)
        let unnamed = store.changeWallet(d) { store.moveToWatching(d) }
        store.restore(unnamed)
        #expect(!store.savedWallets.contains { $0.address == d }, "an entry only the move made goes with it")
    }

    @Test func undoingALaterAnswerDoesntBringBackAMoveThatWasUndone() {
        let (store, _) = makeStore()
        let move = store.changeWallet(a) { store.moveToYours(a) }
        // Like an import that finishes while the list is still open: an answer of its own, saved for Undo with the move in it.
        store.setBook(store.book.answering(b, .someoneElse, focus: nil))
        store.restore(move)
        #expect(store.book.linkedWallets.isEmpty)
        #expect(store.book.senders[b]?.kind == .someoneElse, "the later answer stays")
        #expect(store.undoStack.count == 1, "and can still be undone")
        store.undo()
        #expect(store.book.senders[b] == nil)
        #expect(store.book.linkedWallets.isEmpty, "undoing it doesn't make the wallet yours again")
    }

    @Test func undoingAChangeThatSavedNoUndoLeavesAnotherAnswersUndoAlone() {
        let (store, _) = makeStore()
        store.setWallet(a)
        let removal = store.changeWallet(a) { store.removeWallet(a, showing: nil) }
        store.setBook(store.book.answering(b, .mine, focus: nil))
        store.restore(removal)
        #expect(store.savedWallets.contains { $0.address == a })
        #expect(store.book.linkedWallets == [b])
        #expect(store.undoStack.count == 1, "the later answer can still be undone")
        store.undo()
        #expect(store.book.linkedWallets.isEmpty)
    }

    @Test func undoLeavesAnythingSaidAboutTheWalletSince() {
        let (store, _) = makeStore()
        let move = store.changeWallet(a) { store.moveToYours(a) }
        store.setBook(store.book.answering(a, .someoneElse, focus: nil))
        store.restore(move)
        #expect(store.book.senders[a]?.kind == .someoneElse, "the user's latest word on it wins")
        #expect(store.undoStack.count == 1)
        store.undo()
        #expect(store.book.senders[a] == nil, "and undoing it doesn't bring back the move, which was undone too")
    }

    @Test func aKeySpendingMoneyIsMovingToCantBeMovedOrRemoved() throws {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [], linked: [a, b], newKey: b, saved: [], current: a)
        let new = try #require(list.entry(for: b))
        #expect(new.kind == .yours)
        #expect(!new.canMoveToWatching)
        #expect(!new.canRemove)
        #expect(new.badge == "New Key")
        #expect(new.isNewKey)
    }

    @Test func aReplacedKeyIsNeverWhatShowsNext() {
        let replaced = WalletList(spending: nil, savings: [], linked: [a, b], replacedKeys: [a, b], saved: [], current: nil)
        #expect(replaced.next(afterRemoving: a) == nil, "with nothing else, it's the first screen")
        let others = WalletList(spending: nil, savings: [], linked: [a, b, c], replacedKeys: [a, b], saved: [], current: nil)
        #expect(others.next(afterRemoving: a) == c)
    }

    @Test func dragsAreSavedPerSectionAndAcrossLaunches() {
        let (store, defaults) = makeStore()
        store.moveWallets(in: [a, b, c], from: [2], to: 0)
        #expect(store.walletOrder == [c, a, b])
        store.moveWallets(in: [c, a, b], from: [0], to: 3)
        #expect(store.walletOrder == [a, b, c])
        store.moveWallets(in: [d], from: [0], to: 0)
        #expect(store.walletOrder == [a, b, c, d], "one section moving leaves another alone")
        let reopened = PortfolioStore(defaults: defaults, makeSource: { _ in ScriptedSource(Array(repeating: .failure(.unreachable), count: 50)) })
        #expect(reopened.walletOrder == [a, b, c, d])
    }

    @Test func theListFollowsTheOrderAndNewWalletsGoLast() {
        let saved = [SavedWallet(address: a, name: "Alpha", lastSeen: date(1)), SavedWallet(address: b, name: "Beta", lastSeen: date(1)), SavedWallet(address: c, name: "Gamma", lastSeen: date(1))]
        let list = WalletList(spending: nil, savings: [], linked: [], saved: saved, current: nil, order: [c, a])
        #expect(list.watching.map(\.title) == ["Gamma", "Alpha", "Beta"])
        let spending = address(9)
        let yours = WalletList(spending: NamedWallet(address: spending, name: "Spending Money"), savings: [NamedWallet(address: a, name: "Ledger")], linked: [b], saved: [], current: nil, order: [b, spending])
        #expect(yours.yours.map(\.address) == [b, spending, a])
    }

    @Test func oldSavedWalletsStillRead() throws {
        let old = #"[{"address":"\#(a)","lastSeen":0}]"#
        let wallets = try JSONDecoder().decode([SavedWallet].self, from: Data(old.utf8))
        #expect(wallets.first?.isKept == nil)
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

    @Test func onlyWhatsNoMoreThanAnEntryCanBeRemovedFromTheList() {
        let list = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Savings")], linked: [c], saved: [], current: d)
        #expect(list.all.filter(\.canRemove).map(\.address) == [c, d])
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
