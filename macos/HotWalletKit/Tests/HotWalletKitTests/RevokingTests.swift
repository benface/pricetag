import Foundation
import KeyVault
import Testing
@testable import HotWalletKit

private let spender = EthereumAddress("0x000000000000000000000000000000000000bEEF")!
private let router = EthereumAddress("0x6fF5693b99212Da76ad316178A184AB56D299b43")!
private let collection = EthereumAddress("0x000000000000000000000000000000000000c011")!
private let usdcAddress = EthereumAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!
private let wethAddress = EthereumAddress("0x4200000000000000000000000000000000000006")!

private func hex(_ bytes: [UInt8]) -> String { Hex.encode(bytes) }

@Suite struct RevokingTests {
    @Test func aTokenApprovalIsSetToNothing() throws {
        let transactions = RevocationPlanner.transactions(for: [Revocation(kind: .token, token: usdcAddress, spender: spender, label: "USDC")])
        try #require(transactions.count == 1)
        let transaction = transactions[0]
        #expect(transaction.to == usdcAddress)
        #expect(hex(transaction.data) == "095ea7b3" + String(repeating: "0", count: 24) + "000000000000000000000000000000000000beef" + String(repeating: "0", count: 64))
    }

    @Test func aCollectionIsTurnedOff() throws {
        let transactions = RevocationPlanner.transactions(for: [Revocation(kind: .collection, token: collection, spender: spender, label: "0x0000…c011")])
        try #require(transactions.count == 1)
        let transaction = transactions[0]
        #expect(transaction.to == collection)
        #expect(hex(transaction.data) == "a22cb465" + String(repeating: "0", count: 24) + "000000000000000000000000000000000000beef" + String(repeating: "0", count: 64))
    }

    @Test func everythingPermit2HoldsGoesInOneLockdown() {
        let transactions = RevocationPlanner.transactions(for: [
            Revocation(kind: .permit2, token: usdcAddress, spender: router, label: "USDC"),
            Revocation(kind: .token, token: wethAddress, spender: spender, label: "WETH"),
            Revocation(kind: .permit2, token: wethAddress, spender: router, label: "WETH"),
            // The same one twice is still one.
            Revocation(kind: .permit2, token: wethAddress, spender: router, label: "WETH"),
        ])
        #expect(transactions.count == 2)
        let lockdown = transactions[1]
        #expect(lockdown.to == Base.permit2)
        #expect(lockdown.revocations.count == 2)
        let word = { (address: EthereumAddress) in String(repeating: "0", count: 24) + address.lowercased.dropFirst(2) }
        let expected = "cc53287f" + String(repeating: "0", count: 62) + "20" + String(repeating: "0", count: 63) + "2" + word(usdcAddress) + word(router) + word(wethAddress) + word(router)
        #expect(hex(lockdown.data) == expected)
    }

    @Test func onlyTrackedTokensAndPermit2AreEverCalled() {
        let stranger = EthereumAddress("0x000000000000000000000000000000000000f00d")!
        #expect(Revocation(kind: .token, token: usdcAddress, spender: spender, label: "USDC").isAllowed)
        #expect(Revocation(kind: .permit2, token: stranger, spender: spender, label: "0x0000…f00d").isAllowed, "only Permit2 is called, with the token as data")
        #expect(!Revocation(kind: .token, token: stranger, spender: spender, label: "0x0000…f00d").isAllowed)
        #expect(!Revocation(kind: .collection, token: collection, spender: spender, label: "0x0000…c011").isAllowed)
    }

    @Test func permit2IsUniswapsAddress() {
        #expect(Base.permit2.lowercased == "0x000000000022d473030f116ddee9f6b43ac78ba3")
    }
}

@Suite struct SecurityChecklistTests {
    private func facts(_ change: (inout SecurityFacts) -> Void = { _ in }) -> SecurityFacts {
        var facts = SecurityFacts(hasSpendingMoney: true, savingsWallets: 1, capUsdMicros: 50 * Money.dollar, capText: "$50.00", alarm: .watching, connectedSites: 1, walletTitle: "Spending Money", unlimitedApprovals: 0, approvalsFailed: false, hasPassword: true, fileVaultOn: true)
        change(&facts)
        return facts
    }

    private func status(_ id: SecurityCheck.ID, _ facts: SecurityFacts) -> SecurityCheck.Status? {
        SecurityChecklist.checks(facts).first { $0.id == id }?.status
    }

    @Test func allInPlace() {
        #expect(SecurityChecklist.checks(facts()).allSatisfy { $0.status == .done })
    }

    @Test func onlyWhatWasCheckedIsDone() {
        #expect(status(.fileVault, facts { $0.fileVaultOn = nil }) == .unknown)
        #expect(status(.password, facts { $0.hasPassword = nil }) == .unknown)
        #expect(status(.approvals, facts { $0.unlimitedApprovals = nil }) == .unknown)
        #expect(status(.alarm, facts { $0.alarm = .cantCheck }) == .unknown)
    }

    @Test func saysWhatToDo() {
        #expect(SecurityChecklist.checks(facts { $0.savingsWallets = 0 }).first { $0.id == .savings }?.fix == .addSavings)
        #expect(status(.cap, facts { $0.capUsdMicros = 51 * Money.dollar }) == .todo)
        #expect(status(.approvals, facts { $0.unlimitedApprovals = 2 }) == .todo)
        #expect(status(.alarm, facts { $0.alarm = .raised }) == .todo)
        #expect(status(.sites, facts { $0.connectedSites = 4 }) == .todo)
        #expect(status(.fileVault, facts { $0.fileVaultOn = false }) == .todo)
    }

    @Test func withoutSpendingMoneyOnlyWhatStillApplies() {
        let ids = SecurityChecklist.checks(facts { $0.hasSpendingMoney = false; $0.walletTitle = nil }).map(\.id)
        #expect(ids == [.password, .fileVault])
    }
}
