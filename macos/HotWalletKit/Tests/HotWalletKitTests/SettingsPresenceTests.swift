import Foundation
import KeyVault
import LocalAuthentication
import Testing
@testable import HotWalletKit

private func recipient(_ transaction: UnsignedTransaction) -> EthereumAddress? {
    EthereumAddress("0x" + Hex.encode(transaction.data[16..<36]))
}

/// Someone at an unlocked Mac shouldn't be able to point sweeps at themselves through the app, then wait for one that nobody's asked about.
@MainActor
@Suite struct SettingsPresenceTests {
    private let attacker = EthereumAddress("0x3333333333333333333333333333333333333333")!
    private let elsewhere = URL(string: "https://example.com/rpc")!

    private func moneyAboveTheCap() -> ChainSnapshot { snapshot(tokens: [usdc: usdcUnits(80)]) }

    @Test func addingSavingsAsksAndNamesTheAddress() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        #expect(try await rig.wallet.addColdWallet(address: attacker.lowercased, name: "Keystone"))
        #expect(rig.wallet.settings.coldWallets.contains { $0.address == attacker })
        #expect(presence.reasons.count == 1)
        #expect(presence.reasons[0].contains(attacker.checksummed))
    }

    @Test func aRefusedAddChangesNothing() async throws {
        let rig = await Rig(presence: false)
        #expect(try await !rig.wallet.addColdWallet(address: attacker.lowercased, name: "Keystone"))
        #expect(!rig.wallet.settings.coldWallets.contains { $0.address == attacker })
        #expect(rig.wallet.lastActionProblem == HotWalletWording.touchIDDidNotConfirm)
    }

    @Test func aBadAddressDoesntAsk() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        await #expect(throws: HotWallet.ColdWalletProblem.notAnAddress) { try await rig.wallet.addColdWallet(address: "nope", name: "") }
        #expect(presence.reasons.isEmpty)
    }

    @Test func aKeyThatBecameThisWalletWhileAskingIsRefused() async throws {
        let prompt = OpenPrompt()
        let rig = await Rig(snapshot(eth: 0), userPresence: prompt)
        prompt.whileOpen = {
            await rig.wallet.replaceKey()
            await rig.wallet.finishRotationLeavingFundsBehind()
        }
        await #expect(throws: HotWallet.ColdWalletProblem.isThisHotWallet) { try await rig.wallet.addColdWallet(address: nextAddress.lowercased, name: "") }
        #expect(!rig.wallet.settings.coldWallets.contains { $0.address == nextAddress })
    }

    @Test func changingTheDestinationAsksAndNamesIt() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        try await rig.wallet.addColdWallet(address: attacker.lowercased, name: "Keystone")
        await rig.wallet.setSweepDestination(attacker)
        #expect(rig.wallet.settings.sweepDestination == attacker)
        #expect(presence.reasons.count == 2)
        #expect(presence.reasons[1].contains("Keystone"))
        #expect(presence.reasons[1].contains(attacker.checksummed))
    }

    @Test func aRefusedDestinationStaysWhereItWas() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        try await rig.wallet.addColdWallet(address: attacker.lowercased, name: "Keystone")
        presence.refusal = FakePresence.Refused()
        await rig.wallet.setSweepDestination(attacker)
        #expect(rig.wallet.settings.sweepDestination == coldAddress)
    }

    @Test func theSameDestinationOrOneThatIsntSavingsDoesntAsk() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        await rig.wallet.setSweepDestination(coldAddress)
        await rig.wallet.setSweepDestination(attacker)
        #expect(presence.reasons.isEmpty)
        #expect(rig.wallet.settings.sweepDestination == coldAddress)
    }

    @Test func loweringTheCapAsksAndNamesIt() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        await rig.wallet.setCap(dollars: 1)
        #expect(rig.wallet.settings.capInDollars == 1)
        #expect(presence.reasons.count == 1)
        #expect(presence.reasons[0].contains("$1"))
    }

    @Test func aRefusedCapStaysWhereItWas() async throws {
        let rig = await Rig(presence: false)
        let before = rig.wallet.settings.capInDollars
        await rig.wallet.setCap(dollars: 1)
        #expect(rig.wallet.settings.capInDollars == before)
    }

    @Test func raisingTheCapOrLeavingItAloneDoesntAsk() async throws {
        let rig = await Rig(presence: false)
        let before = rig.wallet.settings.capInDollars
        await rig.wallet.setCap(dollars: before)
        #expect(rig.wallet.lastActionProblem == nil)
        await rig.wallet.setCap(dollars: before + 10)
        #expect(rig.wallet.settings.capInDollars == before + 10)
        #expect(rig.wallet.lastActionProblem == nil)
    }

    @Test func changingTheNodeAsksAndNamesIt() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        await rig.wallet.setRPC(elsewhere)
        #expect(rig.wallet.settings.rpcURL == elsewhere)
        #expect(presence.reasons.count == 1)
        #expect(presence.reasons[0].contains("example.com"))
    }

    @Test func aRefusedNodeStaysWhereItWas() async throws {
        let rig = await Rig(presence: false)
        let before = rig.wallet.settings.rpcURL
        await rig.wallet.setRPC(elsewhere)
        #expect(rig.wallet.settings.rpcURL == before)
    }

    @Test func theSameNodeDoesntAsk() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(userPresence: presence)
        await rig.wallet.setRPC(rig.wallet.settings.rpcURL)
        #expect(presence.reasons.isEmpty)
    }

    @Test func cancellingIsntAProblemToReport() async throws {
        let presence = RecordingPresence()
        presence.refusal = LAError(.userCancel)
        let rig = await Rig(userPresence: presence)
        await rig.wallet.setCap(dollars: 1)
        #expect(rig.wallet.settings.capInDollars != 1)
        #expect(rig.wallet.lastActionProblem == nil)
    }

    @Test func aPassersByCantRedirectASweep() async throws {
        let rig = await Rig(moneyAboveTheCap(), presence: false)
        _ = try await rig.wallet.addColdWallet(address: attacker.lowercased, name: "Mine")
        await rig.wallet.setSweepDestination(attacker)
        await rig.wallet.setCap(dollars: 1)
        await rig.wallet.tick()
        for transaction in await rig.signer.signed {
            #expect(recipient(transaction) == coldAddress)
        }
    }

    @Test func sweepsStillRunWithNoPromptOnceItsChanged() async throws {
        let presence = RecordingPresence()
        let rig = await Rig(moneyAboveTheCap(), userPresence: presence)
        try await rig.wallet.addColdWallet(address: attacker.lowercased, name: "Keystone")
        await rig.wallet.setSweepDestination(attacker)
        await rig.wallet.setCap(dollars: 10)
        let asked = presence.reasons.count
        // From here on, a prompt would refuse, so this only works if a sweep never asks.
        presence.refusal = FakePresence.Refused()
        await rig.wallet.tick()
        #expect(presence.reasons.count == asked)
        let transaction = try #require(await rig.signer.signed.first)
        #expect(recipient(transaction) == attacker)
    }
}
