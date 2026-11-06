import Foundation
import KeyVault
import PricetagKit
import Testing
@testable import HotWalletKit

/// What a watch-only build signs with. `macos/watch-only-test.sh` checks that the real thing isn't in that build at all.
@MainActor @Suite struct WatchOnlyTests {
    private func wallet() -> HotWallet {
        HotWallet(signer: WatchOnlySigner(), settingsStore: MemorySettingsStore(), stateStore: MemoryStateStore(), portfolioSource: { ScriptedPortfolios(.failure(.unreachable)) })
    }

    @Test func thereIsNoWayToMakeOrUseAKey() async throws {
        let signer = WatchOnlySigner()
        await #expect(throws: KeychainSealedKeyStore.Failure.notProvisioned) { try await signer.createKey() }
        let transaction = UnsignedTransaction(chainID: 8453, nonce: 0, maxPriorityFeePerGas: 1, maxFeePerGas: 1, gasLimit: 21000, to: .zero, value: 0, data: [])
        await #expect(throws: KeychainSealedKeyStore.Failure.notProvisioned) { try await signer.sign(transaction, from: .zero) }
        await #expect(throws: KeychainSealedKeyStore.Failure.notProvisioned) { try await signer.deleteKey(.zero) }
        #expect(try await signer.addresses().isEmpty)
        #expect(try await !signer.hasKey(.zero))
    }

    @Test func aWalletWithoutOneOffersNothing() async {
        let wallet = wallet()
        #expect(wallet.availability == .notProvisioned, "From the start, with nothing having run yet")
        wallet.start()
        #expect(wallet.address == nil)
        #expect(!wallet.canSend)
    }
}
