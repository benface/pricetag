// This app has no device code. The web app's hardware wallet flow does that part, so these are the links between the two.
// `src/core/device-link.ts` reads what these write and writes what `AddSavingsLink` reads, and a test on each side pins the format.

import Foundation

public enum DeviceFlow {
    /// The page that moves money from a device to `address`. It only fills in a form, and the device still shows what it's signing.
    public static func topUp(server: URL, to address: String, dollars: Int) -> URL? {
        link(server, [URLQueryItem(name: "topup", value: address), URLQueryItem(name: "usd", value: String(dollars))])
    }

    /// The page that publishes a cost from the wallet it arrived in. `usd` is as typed, if anything was.
    public static func publish(server: URL, draft: CostNoteDraft, usd: String?) -> URL? {
        var items = [
            URLQueryItem(name: "publish", value: draft.txHash),
            URLQueryItem(name: "wallet", value: draft.wallet),
            URLQueryItem(name: "asset", value: draft.asset),
            URLQueryItem(name: "units", value: draft.units),
            URLQueryItem(name: "decimals", value: String(draft.decimals)),
        ]
        if let usd, Format.micros(fromDollars: usd) != nil { items.append(URLQueryItem(name: "usd", value: usd)) }
        return link(server, items)
    }

    private static func link(_ server: URL, _ items: [URLQueryItem]) -> URL? {
        guard var parts = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = items
        return parts.url
    }
}

/// The web app saying a device has this account. Anyone can make this link, so it only ever fills in the form where the person checks it.
public struct AddSavingsLink: Equatable, Identifiable, Sendable {
    public let address: String
    public let name: String
    /// The device's other accounts that are in use. They only link costs, and money never goes to them by itself.
    public let linked: [String]

    public var id: String { address }

    public static let scheme = "patina"

    public init?(url: URL) {
        guard url.scheme == Self.scheme, url.host() == "add-savings", let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard let address = value("address"), Self.isAddress(address) else { return nil }
        self.address = address
        name = String((value("name") ?? "").prefix(40))
        linked = (value("linked") ?? "").split(separator: ",").map(String.init).filter { Self.isAddress($0) && $0.lowercased() != address.lowercased() }
    }

    private static func isAddress(_ text: String) -> Bool {
        text.wholeMatch(of: /0x[0-9a-fA-F]{40}/) != nil
    }
}
