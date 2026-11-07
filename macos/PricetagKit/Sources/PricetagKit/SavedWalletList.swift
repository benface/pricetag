// The wallets the user has looked at and how they arranged them, kept in the settings. Addresses and names only.

import Foundation
import Observation

@MainActor
@Observable
final class SavedWalletList {
    /// Wallets the user has looked at, for the switcher.
    private(set) var saved: [SavedWallet]
    /// How the user arranged the list.
    private(set) var order: [String]
    /// Taken off the list, but still the user's, so costs keep following their money.
    private(set) var hidden: [String]
    /// Called when `hidden` is different, after it's saved.
    @ObservationIgnored var onHiddenChange: () -> Void = {}
    @ObservationIgnored private let defaults: UserDefaults

    init(defaults: UserDefaults, showing address: String?, now: Date) {
        self.defaults = defaults
        var saved = SetAside.decoded([SavedWallet].self, key: StoreKeys.savedWallets, in: defaults) ?? []
        // With a list that couldn't be read, the wallet being shown is all there is to remember.
        if let address, address != WalletAddress.demo, !WalletAddress.isAllYours(address), !saved.contains(where: { $0.address == address }) {
            saved.append(SavedWallet(address: address, lastSeen: now))
        }
        self.saved = saved
        order = defaults.stringArray(forKey: StoreKeys.walletOrder) ?? []
        hidden = defaults.stringArray(forKey: StoreKeys.hiddenWallets) ?? []
    }

    /// Someone looked at it, so it's on the list again.
    func see(_ address: String, at date: Date, own: [String]) {
        save(SavedWallet.seeing(address, at: date, in: saved, own: own))
        unhide(address)
    }

    /// Keeps it in the list under this name, or makes it a recent one again with an empty name.
    func rename(_ address: String, to name: String, at date: Date) {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var next = saved
        if let index = next.firstIndex(where: { $0.address == address }) {
            next[index].name = clean.isEmpty ? nil : clean
            if clean.isEmpty { next[index].isKept = nil }
        } else if !clean.isEmpty {
            next.append(SavedWallet(address: address, name: clean, lastSeen: date))
        }
        save(next)
    }

    func hide(_ address: String) {
        saveHidden(hidden + [address])
    }

    func unhide(_ address: String) {
        saveHidden(hidden.filter { $0 != address })
    }

    func remove(_ address: String) {
        save(saved.filter { $0.address != address })
        saveOrder(order.filter { $0 != address })
    }

    /// Stays under Watching, instead of falling off the list once enough others have been looked at.
    func keep(_ address: String, at date: Date, own: [String]) {
        var next = SavedWallet.seeing(address, at: date, in: saved, own: own)
        if let index = next.firstIndex(where: { $0.address == address }) { next[index].isKept = true }
        save(next)
    }

    /// `addresses` is a section as it's listed. Each section keeps its own order, so one moving doesn't disturb another.
    func move(in addresses: [String], from source: IndexSet, to destination: Int) {
        let moved = source.map { addresses[$0] }
        var arranged = addresses.filter { !moved.contains($0) }
        arranged.insert(contentsOf: moved, at: destination - source.count { $0 < destination })
        saveOrder(order.filter { !addresses.contains($0) } + arranged)
    }

    /// The list's side of taking back one change to one wallet.
    func putBack(_ snapshot: WalletListSnapshot) {
        let address = snapshot.address
        var wallets = saved
        if let index = wallets.firstIndex(where: { $0.address == address }) {
            // A name given since is the user's latest word on it. Without one, an entry the change made goes with the change.
            wallets[index].isKept = snapshot.saved?.isKept
            if snapshot.saved == nil, wallets[index].name == nil { wallets.remove(at: index) }
        } else if let saved = snapshot.saved {
            wallets.append(saved)
        }
        save(wallets)
        if let index = snapshot.orderIndex, !order.contains(address) {
            var next = order
            next.insert(address, at: min(index, next.count))
            saveOrder(next)
        }
        saveHidden(hidden.filter { $0 != address } + (snapshot.wasHidden ? [address] : []))
    }

    private func save(_ wallets: [SavedWallet]) {
        saved = wallets
        defaults.set(try? JSONEncoder().encode(wallets), forKey: StoreKeys.savedWallets)
    }

    private func saveOrder(_ next: [String]) {
        order = next
        defaults.set(next, forKey: StoreKeys.walletOrder)
    }

    private func saveHidden(_ next: [String]) {
        guard next != hidden else { return }
        hidden = next
        defaults.set(next, forKey: StoreKeys.hiddenWallets)
        onHiddenChange()
    }
}
