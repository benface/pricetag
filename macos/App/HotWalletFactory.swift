import Foundation
import HotWalletKit
import KeyVault
import PricetagKit

enum HotWalletFactory {
    static func make(store: PortfolioStore) -> HotWallet {
        #if PATINA_WATCH_ONLY
        let signer = WatchOnlySigner()
        #elseif DEBUG
        if let name = HotWalletDebug.isolatedName {
            let settingsStore = UserDefaultsWalletSettingsStore(defaults: UserDefaults(suiteName: "isolated.\(name)") ?? .standard)
            HotWalletDebug.applySettingsArguments(to: settingsStore)
            return HotWallet(
                signer: KeyVault(store: KeychainSealedKeyStore(service: HotWalletDebug.isolatedService(name))),
                settingsStore: settingsStore,
                stateStore: FileDeviceStateStore(url: HotWalletDebug.isolatedStateURL(name)),
                presence: HotWalletDebug.presence,
                portfolioSource: { store.currentSource },
                costMethod: { store.method }
            )
        }
        // A debug build has its own bundle identifier, and so its own settings and records. The Keychain is shared across the team.
        let signer = KeyVault(store: KeychainSealedKeyStore(service: "com.benface.pricetag.hot-wallet.debug"))
        #else
        let signer = KeyVault()
        #endif
        return HotWallet(signer: signer, portfolioSource: { store.currentSource }, costMethod: { store.method }, moneyDisplay: { store.moneyDisplay })
    }
}
