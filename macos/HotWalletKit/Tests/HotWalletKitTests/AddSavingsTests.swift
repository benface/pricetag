import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

@MainActor
@Suite struct AddSavingsTests {
    private let address = "0x52908400098527886E0F7030069857D2E4169EE7"
    private let another = "0xde709f2102306220921060314715629080e2fb77"

    private func link(_ address: String, name: String = "Ledger", linked: String? = nil) -> AddSavingsLink {
        AddSavingsLink(url: URL(string: "patina://add-savings?address=\(address)&name=\(name)" + (linked.map { "&linked=\($0)" } ?? ""))!)!
    }

    private func model(withCold: Bool = false) async -> (AddSavingsModel, HotWallet) {
        let rig = await Rig(snapshot(eth: 0), withCold: withCold)
        return (AddSavingsModel(wallet: rig.wallet), rig.wallet)
    }

    // MARK: Picking a saved wallet

    @Test func offersOnlyWhatCouldBecomeSavings() async throws {
        let (model, wallet) = await model(withCold: true)
        let saved = WalletEntry(address: address.lowercased(), name: "Treasury", kind: .watching)
        let spending = WalletEntry(address: try #require(wallet.address).lowercased, name: "Spending Money", kind: .spendingMoney)
        let cold = WalletEntry(address: try #require(wallet.settings.coldWallets.first).address.lowercased, name: "Savings", kind: .savings)
        #expect(model.offers(saved))
        #expect(!model.offers(spending))
        #expect(!model.offers(cold))
    }

    /// A saved name proves nothing, so a picked wallet goes through the same check as a pasted one.
    @Test func pickingStillNeedsTheDeviceCheck() async throws {
        let (model, _) = await model()
        model.choose(.other)
        model.address = address
        #expect(model.parsed == EthereumAddress(address))
        #expect(!model.canAdd)
        #expect(!model.matches)
        try model.add()
        #expect(model.added == nil)
        model.matches = true
        #expect(model.canAdd)
        // A different address takes back having said it matches.
        model.address = another
        #expect(!model.matches)
        #expect(!model.canAdd)
    }

    // MARK: Reading an address

    @Test func onlyAPlainAddressCounts() {
        let expected = EthereumAddress(address)!
        #expect(ScannedAddress(text: address) == .address(expected))
        #expect(ScannedAddress(text: " \(address)\n") == .address(expected))
        #expect(ScannedAddress(text: "ethereum:\(address)") == .address(expected))
        #expect(ScannedAddress(text: "ethereum:\(address)@8453") == .address(expected))
        #expect(ScannedAddress(text: "UR:CRYPTO-HDKEY/abc") == .connectCode)
        #expect(ScannedAddress(text: "ur:crypto-multi-accounts/abc") == .connectCode)
        // A payment request names the token's contract, which isn't anyone's wallet.
        #expect(ScannedAddress(text: "ethereum:\(address)/transfer?address=\(another)") == .somethingElse)
        #expect(ScannedAddress(text: "ethereum:\(address)?value=1") == .somethingElse)
        // Naming the chain doesn't change what comes after it, and its contract isn't the one getting paid.
        #expect(ScannedAddress(text: "ethereum:\(address)@8453/transfer?address=\(another)&uint256=1000000") == .somethingElse)
        #expect(ScannedAddress(text: "ethereum:\(address)@8453?value=1") == .somethingElse)
        #expect(ScannedAddress(text: "ethereum:\(address)@not-a-chain") == .somethingElse)
        #expect(ScannedAddress(text: "ethereum:\(address)@") == .somethingElse)
        #expect(ScannedAddress(text: "ethereum:pay-\(address)") == .somethingElse)
        #expect(ScannedAddress(text: "some words that are not an address") == .somethingElse)
        // A wrong checksum is a mistyped address.
        #expect(ScannedAddress(text: "0x52908400098527886E0F7030069857D2E4169Ee7") == .somethingElse)
    }

    // MARK: Going through the steps

    @Test func aLedgerGoesThroughItsStepsToTheBrowser() async {
        let (flow, _) = await model()
        flow.choose(.ledger)
        #expect(flow.step == .ledgerPlugIn)
        #expect(flow.name == "Ledger")
        flow.next()
        #expect(flow.step == .ledgerApp)
        flow.next()
        #expect(flow.step == .ledgerQuit)
        flow.next()
        #expect(flow.step == .ledgerBrowser)
        flow.wentToBrowser()
        #expect(flow.isWaitingForBrowser)
    }

    @Test func aLinkBringsTheWaitingFlowToTheCheck() async {
        let (flow, _) = await model()
        flow.choose(.ledger)
        flow.next(); flow.next(); flow.next()
        flow.wentToBrowser()
        flow.receive(link(address))
        #expect(flow.step == .check)
        #expect(flow.device == .ledger)
        #expect(!flow.isWaitingForBrowser)
        #expect(!flow.matches)
        flow.back()
        #expect(flow.step == .ledgerBrowser)
        #expect(flow.address.isEmpty)
        #expect(flow.link == nil)
    }

    @Test func aKeystoneScanGoesToTheCheck() async {
        let (flow, _) = await model()
        flow.choose(.keystone)
        flow.next(); flow.next()
        #expect(flow.step == .keystoneScan)
        flow.read("ur:crypto-hdkey/abc")
        #expect(flow.step == .keystoneScan)
        #expect(flow.scanProblem == AddSavingsWording.scannedConnectCode)
        flow.read("not an address")
        #expect(flow.scanProblem == AddSavingsWording.scannedSomethingElse)
        #expect(flow.address.isEmpty)
        flow.read(address)
        #expect(flow.step == .check)
        #expect(flow.scanProblem == nil)
        #expect(flow.parsed == EthereumAddress(address))
        #expect(!flow.matches)
        flow.back()
        #expect(flow.step == .keystoneScan)
        #expect(flow.address.isEmpty)
    }

    @Test func theCameraOnlyCountsOnItsOwnStep() async {
        let (flow, _) = await model()
        flow.choose(.keystone)
        flow.read(address)
        #expect(flow.address.isEmpty)
        #expect(flow.step == .keystoneUnlock)
    }

    @Test func noCameraMeansTypingIt() async {
        let (flow, _) = await model()
        flow.choose(.keystone)
        flow.next(); flow.next()
        flow.enterByHand()
        #expect(flow.step == .paste)
        flow.address = address
        flow.next()
        #expect(flow.step == .check)
        flow.back()
        #expect(flow.step == .paste)
        #expect(flow.address == address)
    }

    // MARK: Nothing's added without the check

    @Test func nothingsAddedUntilTheyAnswer() async throws {
        let (flow, wallet) = await model()
        flow.choose(.other)
        flow.address = address
        flow.next()
        try flow.add()
        #expect(wallet.settings.coldWallets.isEmpty)
        #expect(flow.step == .check)
        flow.matches = true
        try flow.add()
        #expect(wallet.settings.coldWallets.map(\.address) == [EthereumAddress(address)!])
        #expect(flow.step == .finished)
        #expect(flow.sweepsGoHere)
    }

    @Test func aChangedAddressTakesBackTheAnswer() async {
        let (flow, _) = await model()
        flow.choose(.other)
        flow.address = address
        flow.matches = true
        flow.address = another
        #expect(!flow.matches)
        #expect(!flow.canAdd)
    }

    /// A page can send a link at any moment, including just as someone's about to press Add.
    @Test func aLinkArrivingMidCheckTakesBackTheAnswer() async throws {
        let (flow, wallet) = await model()
        flow.receive(link(address))
        flow.matches = true
        flow.receive(link(another))
        #expect(!flow.matches)
        try flow.add()
        #expect(wallet.settings.coldWallets.isEmpty)
        // Even the same address, since it's a new claim.
        flow.matches = true
        flow.receive(link(another))
        #expect(!flow.matches)
    }

    @Test func aLinkWithABadChecksumCantBeAdded() async throws {
        let (flow, wallet) = await model()
        flow.receive(link("0x52908400098527886E0F7030069857D2E4169Ee7"))
        #expect(flow.parsed == nil)
        flow.matches = true
        #expect(!flow.canAdd)
        try flow.add()
        #expect(wallet.settings.coldWallets.isEmpty)
    }

    @Test func thisWalletAndWhatsAlreadyAddedAreRefusedUpFront() async throws {
        let (flow, wallet) = await model()
        flow.address = wallet.address!.checksummed
        #expect(flow.problem != nil)
        flow.matches = true
        #expect(!flow.canAdd)
        flow.address = address
        flow.matches = true
        try flow.add()
        let again = AddSavingsModel(wallet: wallet)
        again.address = address
        #expect(again.problem == AddSavingsWording.alreadyAdded)
    }

    @Test func otherAccountsOnlyLinkWhenTicked() async throws {
        let (flow, wallet) = await model()
        flow.receive(link(address, linked: another))
        #expect(flow.suggestedAccounts == [another])
        flow.matches = true
        try flow.add()
        #expect(wallet.settings.deviceAccounts.isEmpty)
    }

    // MARK: The finish

    @Test func aSecondWalletLeavesSweepsWhereTheyWereUntilAsked() async throws {
        let (flow, wallet) = await model(withCold: true)
        let before = wallet.settings.sweepDestination
        flow.address = address
        flow.matches = true
        try flow.add()
        #expect(!flow.sweepsGoHere)
        #expect(wallet.settings.sweepDestination == before)
        #expect(flow.sweepDestinationName != nil)
        flow.sweepHere()
        #expect(flow.sweepsGoHere)
    }

    @Test func aSecondWalletWithTheSameNameDoesntNameTheFirst() async throws {
        let (flow, wallet) = await model(withCold: true)
        let first = try #require(wallet.settings.coldWallets.first)
        flow.address = address
        flow.name = first.name
        flow.matches = true
        try flow.add()
        #expect(flow.sweepDestinationName == nil)
    }

    @Test func theFirstWalletSaysItCanStartSweeps() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(100)]), withCold: false)
        await rig.wallet.tick()
        let flow = AddSavingsModel(wallet: rig.wallet)
        flow.address = address
        #expect(flow.wouldStartSweeps)
        flow.matches = true
        try flow.add()
        #expect(flow.startedSweeps)
        #expect(flow.sweepsGoHere)
        #expect(!flow.wouldStartSweeps)
    }

    @Test func addingBeforeTheFirstReadStillWarns() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(100)]), withCold: false)
        await rig.chain.hold(snapshots: true)
        let firstRead = Task { await rig.wallet.tick() }
        let deadline = Date.now.addingTimeInterval(10)
        while await rig.chain.heldCalls == 0, Date.now < deadline { try await Task.sleep(for: .milliseconds(1)) }
        #expect(await rig.chain.heldCalls > 0)
        let flow = AddSavingsModel(wallet: rig.wallet)
        flow.address = address
        flow.matches = true
        #expect(rig.wallet.plan == nil)
        #expect(flow.wouldStartSweeps)
        #expect(flow.sweepNotice == AddSavingsWording.balanceUnread)
        do {
            try flow.add()
        } catch {
            await rig.chain.release()
            await firstRead.value
            throw error
        }
        #expect(flow.startedSweeps)
        #expect(flow.mayBeSweeping)
        #expect(!flow.canSendTest)
        await rig.chain.release()
        await firstRead.value
        // It really does go out, which is why this says so.
        #expect(await rig.chain.sent.count == 1)
        #expect(flow.mayBeSweeping)
    }

    @Test func anEmptyFirstWalletStillSaysWhatItBecomes() async throws {
        let rig = await Rig(snapshot(eth: 0), withCold: false)
        await rig.wallet.tick()
        let flow = AddSavingsModel(wallet: rig.wallet)
        flow.address = address
        #expect(!flow.wouldStartSweeps)
        #expect(flow.sweepNotice == AddSavingsWording.firstWallet)
        flow.matches = true
        try flow.add()
        #expect(!flow.startedSweeps)
        #expect(!flow.mayBeSweeping)
        #expect(flow.sweepNotice == nil)
    }

    @Test func theFinishFollowsMoneyThatArrivesAfterAdding() async throws {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei), withCold: false)
        await rig.wallet.tick()
        let flow = AddSavingsModel(wallet: rig.wallet)
        flow.address = address
        flow.matches = true
        try flow.add()
        #expect(!flow.mayBeSweeping)
        await rig.chain.set(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(500)]))
        await rig.wallet.tick()
        #expect(await rig.chain.sent.count == 1)
        #expect(!flow.startedSweeps)
        #expect(flow.mayBeSweeping)
        #expect(!flow.canSendTest)
    }

    @Test func aSecondWalletChangesNothingAboutSweeps() async {
        let rig = await Rig(snapshot(eth: SweepPlanner.minimumGasReserveWei, tokens: [usdc: usdcUnits(100)]), withCold: true)
        await rig.wallet.tick()
        let second = AddSavingsModel(wallet: rig.wallet)
        second.address = address
        #expect(!second.wouldStartSweeps)
        #expect(second.sweepNotice == nil)
    }

    // MARK: Wording

    @Test func everyPageSaysItPlainly() {
        let devices: [AddSavingsModel.Device?] = [nil, .ledger, .keystone, .other]
        let steps: [AddSavingsModel.Step] = [.pick, .ledgerPlugIn, .ledgerApp, .ledgerQuit, .ledgerBrowser, .keystoneUnlock, .keystoneReceive, .keystoneScan, .paste, .check, .finished]
        var all = [AddSavingsWording.neverAsked]
        for step in steps {
            for device in devices {
                let page = AddSavingsWording.page(step, device: device)
                all += [page.title, page.body] + page.troubles.flatMap { [$0.when, $0.then] }
            }
        }
        let text = all.joined(separator: " ").lowercased()
        for word in ["seed", "mnemonic", "private key", "fifo", "oracle"] { #expect(!text.contains(word), "\(word)") }
        // Said once, plainly, on the first page.
        #expect(!all.dropFirst().contains { $0.lowercased().contains("recovery phrase") })
    }

    @Test func theDevicesOwnWords() {
        #expect(AddSavingsWording.page(.ledgerApp, device: .ledger).body.contains("Ethereum"))
        #expect(AddSavingsWording.page(.ledgerApp, device: .ledger).troubles[0].then.contains("My Ledger"))
        #expect(AddSavingsWording.page(.check, device: .ledger).body.contains("Verify Base address"))
        // The button that's really on the page by then.
        #expect(AddSavingsWording.page(.check, device: .ledger).troubles.contains { $0.then.contains("Open the Mac app again") })
        #expect(AddSavingsWording.page(.keystoneReceive, device: .keystone).body.contains("Receive ETH"))
        // Neither device has a receive screen "for Base".
        #expect(!AddSavingsWording.page(.keystoneReceive, device: .keystone).body.contains("for Base"))
    }
}
