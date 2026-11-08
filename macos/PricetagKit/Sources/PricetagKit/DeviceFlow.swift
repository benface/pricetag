// This app has no device code. The web app's hardware wallet flow does that part, so these are the links between the two.
// `src/core/device-link.ts` reads what these write and writes what `AddSavingsLink` reads, and a test on each side pins the format.

import Foundation

public enum DeviceFlow {
    /// The page that moves money from a device to `address`. It only fills in a form, and the device still shows what it's signing.
    /// `naming` is what each savings wallet holds, so the send can name the units it takes. It's only there under US rules, and goes
    /// after the `#`, which never reaches a server, so a long history can't make the request line too long for one. The page hands the
    /// choice back in a `UnitChoiceLink` that brings its `flow` back.
    public static func topUp(server: URL, to address: String, dollars: Int, naming: TopUpNaming? = nil) -> URL? {
        guard var parts = URLComponents(url: server, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = [URLQueryItem(name: "topup", value: address), URLQueryItem(name: "usd", value: String(dollars))]
        if let naming {
            let encoder = JSONEncoder()
            encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
            guard let data = try? encoder.encode(naming.held), let text = String(data: data, encoding: .utf8) else { return nil }
            var fragment = URLComponents()
            fragment.queryItems = [URLQueryItem(name: "flow", value: naming.flow), URLQueryItem(name: "currency", value: naming.currency.rawValue), URLQueryItem(name: "held", value: text)]
            parts.percentEncodedFragment = fragment.percentEncodedQuery
        }
        return parts.url
    }

    /// The page that publishes a cost from the wallet it arrived in. `usd` is as typed, if anything was, and goes in plain digits,
    /// because this app reads more ways of writing an amount than the page does, and one it couldn't read would leave its form blank.
    public static func publish(server: URL, draft: CostNoteDraft, usd: String?) -> URL? {
        var items = [
            URLQueryItem(name: "publish", value: draft.txHash),
            URLQueryItem(name: "wallet", value: draft.wallet),
            URLQueryItem(name: "asset", value: draft.asset),
            URLQueryItem(name: "units", value: draft.units),
            URLQueryItem(name: "decimals", value: String(draft.decimals)),
        ]
        if let usd, let micros = Format.micros(fromDollars: usd), micros != "0" { items.append(URLQueryItem(name: "usd", value: plainDollars(micros))) }
        return link(server, items)
    }

    /// The page that gets an address from a Ledger and sends it back here in an `AddSavingsLink`.
    public static func addSavingsFromLedger(server: URL) -> URL? {
        link(server, [URLQueryItem(name: "addsavings", value: "ledger")])
    }

    private static func plainDollars(_ micros: String) -> String {
        let digits = String(repeating: "0", count: max(0, 7 - micros.count)) + micros
        let fraction = digits.suffix(6).replacing(/0+$/, with: "")
        return digits.dropLast(6) + (fraction.isEmpty ? "" : ".\(fraction)")
    }

    /// A server on this Mac serves these pages itself, and any other only answers the API, so the app has to.
    public static func needsItsOwnPage(_ link: URL) -> Bool {
        !link.isOnThisMac
    }

    /// The same request, on the page at `page`, with what's after its `#`.
    public static func link(_ link: URL, on page: URL) -> URL? {
        guard let original = URLComponents(url: link, resolvingAgainstBaseURL: false), let query = original.queryItems, var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = query
        parts.percentEncodedFragment = original.percentEncodedFragment
        return parts.url
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
    /// Other accounts the link says are on the same device. That's only a claim, and one wrong address here would change costs and PnL,
    /// so each is a suggestion the person has to accept. They only link costs, and money never goes to them by itself.
    public let linked: [String]

    public var id: String { address }

    public static let scheme = "patina"

    public init?(url: URL) {
        guard url.scheme == Self.scheme, url.host() == "add-savings", var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        // The page writes a space as "+", and this would keep it as one. A real plus comes as "%2B".
        parts.percentEncodedQuery = parts.percentEncodedQuery?.replacing("+", with: "%20")
        guard let items = parts.queryItems else { return nil }
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard let address = value("address"), WalletAddress.isValid(address) else { return nil }
        self.address = address
        name = String((value("name") ?? "").prefix(40))
        var seen = Set([address.lowercased()])
        linked = Array((value("linked") ?? "").split(separator: ",").map(String.init).filter { WalletAddress.isValid($0) && seen.insert($0.lowercased()).inserted }.prefix(Self.mostSuggestions))
    }

    /// What to link once someone's answered: only what they accepted, and only while they're adding the wallet the link named. Edit
    /// that address and it's a different wallet, which says nothing about what's on the same device.
    public func accountsToLink(accepted: Set<String>, adding address: String) -> [String] {
        guard address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == self.address.lowercased() else { return [] }
        return linked.filter(accepted.contains)
    }

    /// More than anyone would have in use, and all of them have to fit on a sheet.
    private static let mostSuggestions = 8
}

/// A browser on this Mac.
public struct InstalledBrowser: Equatable, Sendable {
    public let bundleID: String
    public let name: String
    public let url: URL

    public init(bundleID: String, name: String, url: URL) {
        self.bundleID = bundleID
        self.name = name
        self.url = url
    }
}

/// Which browser can do a Ledger's part. Only Chromium browsers have WebHID, so a default like Safari can't.
public struct LedgerBrowserChoice: Equatable, Sendable {
    /// Nil when nothing on this Mac is known to reach a Ledger.
    public let browser: InstalledBrowser?
    /// The default browser's name, when it's the one that can't.
    public let defaultThatCant: String?

    /// In the order to offer them, when the default can't.
    private static let chromium = [
        "com.google.Chrome", "com.brave.Browser", "com.microsoft.edgemac", "company.thebrowser.Browser", "com.vivaldi.Vivaldi", "com.operasoftware.Opera", "org.chromium.Chromium",
        "com.google.Chrome.beta", "com.google.Chrome.dev", "com.google.Chrome.canary", "com.brave.Browser.beta", "com.brave.Browser.nightly", "com.microsoft.edgemac.Beta", "com.microsoft.edgemac.Dev", "com.microsoft.edgemac.Canary",
    ]

    public init(defaultBrowser: InstalledBrowser?, installed: [InstalledBrowser]) {
        if let defaultBrowser, Self.chromium.contains(defaultBrowser.bundleID) {
            browser = defaultBrowser
            defaultThatCant = nil
        } else {
            browser = Self.chromium.lazy.compactMap { id in installed.first { $0.bundleID == id } }.first
            defaultThatCant = defaultBrowser?.name
        }
    }

    /// Before anything's been asked.
    public static let unknown = LedgerBrowserChoice(defaultBrowser: nil, installed: [])

    /// The one to send someone to, by name. With nothing that can reach a Ledger, that's still the default: a Keystone only needs a webcam.
    public var opens: String? { browser?.name ?? defaultThatCant }

    /// The default, when it isn't what opens, for someone with a Keystone who'd rather stay in it.
    public var defaultForKeystone: String? { browser == nil ? nil : defaultThatCant }

    public var continueTitle: String { "Continue in \(opens ?? "Browser")" }

    /// `outcome` says what happens there, and ends in a period.
    public func opening(_ outcome: String) -> String {
        let opening = "This opens \(opens ?? "your browser"), where \(outcome)"
        if let defaultForKeystone { return "\(opening) \(defaultForKeystone) can't reach a Ledger." }
        return opens == nil ? "\(opening) A Ledger needs Chrome, Brave, Edge or another Chromium browser." : opening
    }

    /// When nothing here can reach a Ledger, what someone with one should do about it.
    public var noLedgerBrowser: String? {
        guard browser == nil, let defaultThatCant else { return nil }
        return "\(defaultThatCant) can't reach a Ledger, only a Keystone. For a Ledger, install Chrome, Brave or Edge, then come back."
    }
}
