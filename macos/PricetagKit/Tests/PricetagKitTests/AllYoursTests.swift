import Foundation
import Testing
@testable import PricetagKit

private let a = "0x" + String(repeating: "a", count: 40)
private let b = "0x" + String(repeating: "b", count: 40)
private let c = "0x" + String(repeating: "c", count: 40)
private let d = "0x" + String(repeating: "d", count: 40)

/// Answers every read with all of the test's wallets as one, and remembers what it was asked for.
private actor AllYoursSource: PortfolioSource {
    private(set) var asked: [(address: String, linked: [String])] = []
    private(set) var proofs: [String] = []

    func portfolio(address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book, timeout: Duration) async throws -> Portfolio {
        asked.append((address, linked))
        return try resource("all-yours-portfolio", as: Portfolio.self)
    }

    func explanation(of target: ExplainTarget, address: String, method: CostMethod, currency: CurrencyCode, rule: String?, linked: [String], book: Book) async throws -> Explanation {
        throw FetchError.unreachable
    }

    func proof(leg: String, address: String, currency: CurrencyCode, rule: String?) async throws -> Proof {
        proofs.append(address)
        throw FetchError.unreachable
    }
}

@MainActor
struct AllYoursTests {
    private func date(_ seconds: TimeInterval) -> Date { Date(timeIntervalSince1970: seconds) }

    @Test func transactionsSayWhichWalletAndCanBeFoundByIt() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        let log = TransactionLog(points: portfolio.points, names: [b: "Savings"])
        #expect(log.items.first { $0.txHash == "0x2" }?.wallets == [a, b])
        #expect(log.filtered(query: "savings", asset: nil).map(\.txHash).contains("0x2"))
        #expect(!log.filtered(query: "savings", asset: nil).map(\.txHash).contains("0x1"))
    }

    @Test func readsWhatTheServerSends() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        #expect(portfolio.isAllYours)
        #expect(portfolio.wallets?.map(\.state) == [.read, .read, .read, .reading])
        let eth = try #require(portfolio.positions.first { $0.asset == "ETH" })
        #expect(eth.wallets?.filter(\.hasUnknownCost).map(\.wallet) == [c])
        #expect(portfolio.totals.excluded.map(\.wallet) == [c])
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.amount == TransactionAmount(direction: .trade, micros: "3000000000"))
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.wallets == [a, b])
        #expect(portfolio.transactions.first { $0.txHash == "0x2" }?.summary == "Moved 1 ETH between your wallets")

        let explanation = try resource("all-yours-explanation", as: Explanation.self)
        #expect(explanation.parts?.map(\.wallet) == [a, b, c])
        // A move is the same leg in both wallets, and a list of them still tells them apart.
        #expect(Set(explanation.legs.map(\.rowID)).count == explanation.legs.count)
        #expect(explanation.legs.allSatisfy { $0.wallet != nil })
    }

    @Test func saysWhichWalletWhatsLeftOutIsIn() throws {
        let portfolio = try resource("all-yours-portfolio", as: Portfolio.self)
        let attention = try #require(portfolio.attention(names: [c: "Laptop"]))
        #expect([attention.title, attention.fullList].compactMap(\.self).contains { $0.contains("ETH in Laptop (unknown cost)") })
        #expect(Wording.excluded([Exclusion(asset: "ETH", reason: "unknown cost", wallet: c)]) == "Excludes ETH in \(Format.shortHash(c)) (unknown cost).")
    }

    @Test func isOfferedOnceThereAreTwoWalletsToAddUp() {
        let one = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [], linked: [a], saved: [], current: a)
        #expect(one.allYours == nil)
        let two = WalletList(spending: NamedWallet(address: a, name: "Spending Money"), savings: [NamedWallet(address: b, name: "Ledger")], linked: [a, b], saved: [SavedWallet(address: d, name: "Treasury", lastSeen: date(1))], current: a)
        #expect(two.allYours?.title == "All Yours")
        #expect(two.allYours?.detail == "2 wallets")
        #expect(two.all.first?.kind == .allYours, "at the top")
        #expect(two.allYoursAddresses == [a, b], "and never a wallet that's only watched")
        #expect(!two.pickable.contains { $0.kind == .allYours }, "it has no address to paste anywhere")
        #expect(two.allYours?.canRename == false && two.allYours?.canRemove == false)
        #expect(two.names[b] == "Ledger")
        // Still there while it's showing, whatever's happened to the list.
        let showing = WalletList(spending: nil, savings: [], linked: [a], saved: [], current: WalletAddress.allYours)
        #expect(showing.entry(for: WalletAddress.allYours)?.kind == .allYours)
        #expect(showing.recent.isEmpty, "and it's never a recent wallet")
    }

    @Test func comesBackAfterARelaunchAsAllYoursAndNothingElse() throws {
        let defaults = UserDefaults(suiteName: "all-yours-relaunch-\(UUID().uuidString)")!
        defaults.set(WalletAddress.allYours, forKey: "wallet")
        // What an earlier build could have saved.
        defaults.set(try JSONEncoder().encode([SavedWallet(address: WalletAddress.allYours, lastSeen: date(1)), SavedWallet(address: d, name: "Treasury", lastSeen: date(2))]), forKey: "savedWallets")
        defaults.set(try JSONEncoder().encode(Book().answering(a, .mine, focus: nil).answering(b, .mine, focus: nil)), forKey: "answers")
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in AllYoursSource() })
        #expect(store.address == WalletAddress.allYours)
        #expect(store.savedWallets.map(\.address) == [d])
        let list = WalletList(spending: nil, savings: [], linked: store.book.linkedWallets, saved: store.savedWallets, current: store.address)
        #expect(list.all.filter { $0.address == WalletAddress.allYours }.map(\.kind) == [.allYours], "once, as itself")
        #expect(list.recent.isEmpty && list.watching.map(\.address) == [d])
        #expect(!list.pickable.contains { WalletAddress.isAllYours($0.address) })
        #expect(Set(list.all.map(\.id)).count == list.all.count)
        // Even if a saved list still has it, the list never shows it as a wallet.
        let stale = WalletList(spending: nil, savings: [], linked: [a, b], saved: [SavedWallet(address: WalletAddress.allYours, lastSeen: date(1))], current: WalletAddress.allYours)
        #expect(stale.recent.isEmpty && stale.watching.isEmpty)
    }

    @Test func readsEveryWalletOfYoursAsOne() async throws {
        let defaults = UserDefaults(suiteName: "all-yours-\(UUID().uuidString)")!
        let source = AllYoursSource()
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source })
        store.setLinkedWallets([a, b])
        store.setBook(store.book.answering(c, .mine, focus: nil))
        store.stop()
        store.setWallet(WalletAddress.allYours)
        store.stop()
        #expect(store.savedWallets.isEmpty, "it's not a wallet to remember")
        #expect(store.linked(for: WalletAddress.allYours) == [a, b, c])

        _ = await store.poll()
        let asked = await source.asked
        #expect(asked.last?.address == WalletAddress.allYours)
        #expect(asked.last?.linked == [a, b, c])
        #expect(store.portfolio?.isAllYours == true)
        // A wallet that's still being read is on its way, so the numbers say they're updating until it's in.
        #expect(store.updatingNote == Wording.updatingWallets(1))

        // Taking one off the list takes it out of All Yours, and a leg in one of them can show its proof.
        store.removeWallet(c, showing: nil)
        store.stop()
        #expect(store.linked(for: WalletAddress.allYours) == [a, b])
        await #expect(throws: FetchError.unreachable) { try await store.proof(leg: "0x2:ETH", address: b) }
        await #expect(throws: CancellationError.self) { try await store.proof(leg: "0x2:ETH", address: d) }
        #expect(await source.proofs == [b])
    }
}
