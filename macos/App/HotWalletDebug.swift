#if DEBUG
import Foundation
import HotWalletKit
import KeyVault

/// `pnpm check:keychain` runs this from a signed debug build, since only one of those can reach the Secure Enclave and the
/// device-only Keychain together. It makes a key, signs with it, and deletes it. None of this is in a release build.
nonisolated enum HotWalletDebug {
    private static let service = "com.benface.pricetag.hot-wallet.self-test"

    /// No window opens by itself, and nothing activates, so a scripted run doesn't interrupt anyone.
    static let isQuiet = CommandLine.arguments.contains("--quiet")

    /// A wallet of its own, in its own Keychain service and files, which never touches the debug wallet someone may be using.
    static let isolatedName = value(after: "--isolated")

    static func isolatedService(_ name: String) -> String { "com.benface.pricetag.hot-wallet.isolated.\(name)" }
    static func isolatedStateURL(_ name: String) -> URL { URL.applicationSupportDirectory.appending(path: "HotWallet-\(name)/device-state.json") }

    /// Only with `--isolated`, for scripts: `macos/extension-test.sh` can't touch a sensor.
    static var presence: any UserPresence { NoPresence() }

    private struct NoPresence: UserPresence {
        func confirm(reason: String) async throws {}
    }

    private static func value(after flag: String) -> String? {
        CommandLine.arguments.firstIndex(of: flag).flatMap { CommandLine.arguments.indices.contains($0 + 1) ? CommandLine.arguments[$0 + 1] : nil }
    }

    /// An isolated wallet's settings, against a local fork, in place before it starts. These don't go through the wallet's own calls, which would ask for Touch ID.
    static func applySettingsArguments(to store: some WalletSettingsStore) {
        var settings = store.load()
        if let rpc = value(after: "--rpc").flatMap(URL.init(string:)) { settings.rpcURL = rpc }
        if let cold = value(after: "--add-cold").flatMap(EthereumAddress.init) { settings.add(ColdWallet(address: cold, name: "Ledger", confirmedOnDeviceAt: Date())) }
        if let cap = value(after: "--cap").flatMap(Int.init) { settings.setCap(dollars: cap) }
        store.save(settings)
    }

    /// Sets up a state to look at. What this does goes through the same calls as the app's buttons.
    @MainActor static func applyLaunchArguments(to wallet: HotWallet, bridge: SiteBridge) {
        if let url = value(after: "--answer-site-requests-from").flatMap(URL.init(string:)) { answerSiteRequests(bridge, from: url) }
        if CommandLine.arguments.contains("--create-wallet") { Task { await wallet.createWallet() } }
        // An address is public, and scripts driving a fork need it to fund the wallet.
        if CommandLine.arguments.contains("--print-address") {
            Task {
                try? await Task.sleep(for: .seconds(2))
                FileHandle.standardError.write(Data("PID \(getpid())\nADDRESS \(wallet.address?.lowercased ?? "none")\n".utf8))
            }
        }
    }

    /// Answers what's waiting with what a script's local server says, in place of a person at the window. There's nothing like this in a release build.
    @MainActor private static func answerSiteRequests(_ bridge: SiteBridge, from url: URL) {
        Task {
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(100))
                guard let approval = bridge.current, let (data, _) = try? await URLSession.shared.data(from: url) else { continue }
                switch String(decoding: data, as: UTF8.self) {
                case "approve": await bridge.approve(approval.id, acknowledged: true)
                case "reject": bridge.reject(approval.id)
                default: break
                }
            }
        }
    }

    static func runSelfTestIfAsked() {
        #if !PATINA_WATCH_ONLY
        if let name = isolatedName, CommandLine.arguments.contains("--reset-isolated-wallet") {
            let store = KeychainSealedKeyStore(service: isolatedService(name))
            for address in (try? store.addresses()) ?? [] { try? store.delete(address) }
            try? FileManager.default.removeItem(at: isolatedStateURL(name).deletingLastPathComponent())
            UserDefaults(suiteName: "isolated.\(name)")?.removePersistentDomain(forName: "isolated.\(name)")
            print("Reset the isolated wallet.")
            exit(0)
        }
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
        #endif
    }

    #if !PATINA_WATCH_ONLY
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
    #endif

    private struct Problem: Error, CustomStringConvertible {
        let description: String

        init(_ description: String) {
            self.description = description
        }
    }
}
#endif
