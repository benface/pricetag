#if DEBUG
import Foundation
import HotWalletKit
import KeyVault

/// `pnpm check:keychain` runs this from a signed debug build, since only one of those can reach the Secure Enclave and the
/// device-only Keychain together. It makes a key, signs with it, and deletes it. None of this is in a release build.
nonisolated enum HotWalletDebug {
    private static let service = "com.benface.pricetag.hot-wallet.self-test"

    static let opensWindow = CommandLine.arguments.contains("--open-spending-money")

    static let sheet = value(after: "--sheet")

    private static func value(after flag: String) -> String? {
        CommandLine.arguments.firstIndex(of: flag).flatMap { CommandLine.arguments.indices.contains($0 + 1) ? CommandLine.arguments[$0 + 1] : nil }
    }

    /// Sets up a state to look at, against a local fork. What this does goes through the same calls as the app's buttons.
    @MainActor static func applyLaunchArguments(to wallet: HotWallet) {
        if let rpc = value(after: "--rpc").flatMap(URL.init(string:)) { wallet.setRPC(rpc) }
        if let cold = value(after: "--add-cold") { try? wallet.addColdWallet(address: cold, name: "Ledger") }
        if let cap = value(after: "--cap").flatMap(Int.init) { wallet.setCap(dollars: cap) }
        if CommandLine.arguments.contains("--create-wallet") { Task { await wallet.createWallet() } }
    }

    static func runSelfTestIfAsked() {
        if CommandLine.arguments.contains("--reset-debug-wallet") {
            let store = KeychainSealedKeyStore(service: "com.benface.pricetag.hot-wallet.debug")
            for address in (try? store.addresses()) ?? [] { try? store.delete(address) }
            try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: "HotWallet"))
            UserDefaults.standard.removeObject(forKey: "hotWallet.settings")
            print("Reset the debug wallet.")
            exit(0)
        }
        guard CommandLine.arguments.contains("--hot-wallet-self-test") else { return }
        // This runs before the app has started, and blocks it until the test exits.
        let never = DispatchSemaphore(value: 0)
        Task.detached {
            do {
                try await selfTest()
                print("KEYCHAIN SELF TEST PASSED")
                exit(0)
            } catch {
                print("KEYCHAIN SELF TEST FAILED: \(error)")
                exit(1)
            }
        }
        never.wait()
    }

    private static func selfTest() async throws {
        let store = KeychainSealedKeyStore(service: service)
        for address in try store.addresses() { try store.delete(address) }
        let vault = KeyVault(store: store)

        let address = try await vault.createKey()
        print("Made a key, wrapped by the Secure Enclave and stored in the data protection Keychain: \(address)")
        guard let item = try store.load(address), !item.wrappingKey.isEmpty, item.ciphertext.count == 48 else { throw Problem("The stored item isn't what it should be") }
        let attributes = try store.attributes(of: address)
        print("Accessible: \(attributes.accessible). Synchronizable: \(attributes.synchronizable).")
        guard attributes.accessible == "cku" else { throw Problem("The item isn't device-only: \(attributes.accessible)") }
        guard !attributes.synchronizable else { throw Problem("The item syncs") }

        let transaction = UnsignedTransaction(chainID: 8453, nonce: 0, maxPriorityFeePerGas: 1, maxFeePerGas: 1, gasLimit: 21000, to: .zero, value: 0, data: [])
        let signed = try await vault.sign(transaction, from: address)
        print("Unwrapped with no prompt, and signed a transaction that recovers to it: \(signed.hash)")

        try await vault.deleteKey(address)
        guard try await !vault.hasKey(address) else { throw Problem("The key is still there") }
        print("Deleted it.")
    }

    private struct Problem: Error, CustomStringConvertible {
        let description: String

        init(_ description: String) {
            self.description = description
        }
    }
}
#endif
