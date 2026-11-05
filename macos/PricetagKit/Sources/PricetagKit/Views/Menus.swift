import SwiftUI

/// What a right-click on a transaction offers, wherever it's listed. Each also has a place in the interface: the row opens its details,
/// and the details link to Basescan.
public struct TransactionActions: View {
    let hash: String
    let onShow: (() -> Void)?

    /// `onShow` opens its details, where there are some to open.
    public init(hash: String, onShow: (() -> Void)? = nil) {
        self.hash = hash
        self.onShow = onShow
    }

    public var body: some View {
        if let onShow {
            Button("Show Details", action: onShow)
            Divider()
        }
        Button("Copy Hash") { Clipboard.copy(hash) }
        if let url = Basescan.transaction(hash) {
            Link("View on Basescan", destination: url)
        }
    }
}

/// What a right-click on an address offers. It copies exactly the address given, which is the one on screen, so give it with its checksum.
public struct AddressActions: View {
    let address: String

    public init(address: String) {
        self.address = address
    }

    public var body: some View {
        Button("Copy Address") { Clipboard.copy(address) }
        if let url = Basescan.address(address) {
            Link("View on Basescan", destination: url)
        }
    }
}
