// Says in a few words what the feed knows, for the places with room for only that: the menu bar and a status badge.

import Foundation

/// What the menu bar item shows while the feed is live. Value by default, because a PnL that's always on screen is a score to watch, and it's on show to anyone looking.
public enum MenuBarShows: String, Codable, Sendable, CaseIterable, Identifiable {
    case value, pnl, icon

    public var id: Self { self }
    public var label: String {
        switch self {
        case .value: "Value"
        case .pnl: "PnL"
        case .icon: "Icon Only"
        }
    }
}

public struct FeedSummary: Equatable, Sendable {
    /// Empty when there's nothing to say yet, and an icon has to do.
    public let text: String
    public let isWarning: Bool

    /// A number only appears here while the feed is live. Old numbers stay in the popover and the window, labeled as old.
    /// What's wrong with the feed shows whatever `shows` is. What's wrong with a number only shows with that number.
    public init(feed: FeedState, portfolio: Portfolio?, shows: MenuBarShows) {
        switch feed {
        case .noWallet: (text, isWarning) = ("", false)
        // With numbers in the window, they're the last answer until the new one arrives.
        case .reading: (text, isWarning) = (portfolio == nil ? "Reading…" : "Updating…", false)
        case .behind: (text, isWarning) = ("Behind", true)
        case .catchingUp: (text, isWarning) = ("Catching up", true)
        case .serverUnreachable: (text, isWarning) = ("Offline", true)
        case .tooSlow: (text, isWarning) = ("Slow to read", true)
        case .ampUnavailable: (text, isWarning) = ("Prices offline", true)
        case .noAmpConfigured: (text, isWarning) = ("No prices", true)
        case .rejected: (text, isWarning) = ("Can't read", true)
        case .tooBig: (text, isWarning) = ("Too much history", true)
        case .rateLimited: (text, isWarning) = ("Slowed down", true)
        case .live:
            guard let portfolio else {
                (text, isWarning) = ("Reading…", false)
                return
            }
            let prefix = portfolio.mode == .demo ? "Demo " : ""
            if portfolio.isEmpty {
                (text, isWarning) = ("\(prefix)No activity", false)
                return
            }
            if portfolio.holdsOnlyOtherTokens {
                (text, isWarning) = ("\(prefix)\(Wording.nothingPriced)", false)
                return
            }
            switch shows {
            case .icon:
                (text, isWarning) = (portfolio.mode == .demo ? "Demo" : "", false)
            case .value:
                guard let value = portfolio.totalValueText else {
                    (text, isWarning) = (prefix + Wording.valueUnavailable, true)
                    return
                }
                // With no line beside it to say what's estimated, a number here keeps its own mark.
                (text, isWarning) = (prefix + Format.estimate(value, portfolio.totals.estimated.value), portfolio.isValuePartial)
            case .pnl:
                guard let pnl = portfolio.totalPnlText else {
                    (text, isWarning) = (prefix + Wording.pnlUnavailable, true)
                    return
                }
                (text, isWarning) = (prefix + Format.estimate(pnl, isPositive(portfolio.totals.estimatedMicros)), portfolio.pnlStatus == .partial)
            }
        }
    }
}

/// What's wrong, for someone who doesn't know there's a server: what happened, whether their money is affected, and what to do next.
/// What a developer would want, like the address that didn't answer, stays in `detail`.
public struct FeedProblem: Equatable, Sendable {
    public let title: String
    /// What happened, how old the numbers are if there are any, whether money's affected, and what to do.
    public let message: String
    /// The technical side, for whoever wants it. nil when there's nothing to add.
    public let detail: String?
}

extension URL {
    /// Where saying "on this Mac" and "start it" is true.
    public var isOnThisMac: Bool {
        ["127.0.0.1", "localhost", "::1"].contains(host()?.lowercased() ?? "")
    }
}

extension FeedState {
    /// How long a read goes before it's worth saying how long it's been. Most finish sooner.
    public static let longReadSeconds = 5

    /// nil when nothing's wrong. Catching up isn't a problem: those numbers are still updating.
    public func problem(serverURL: URL, portfolio: Portfolio?) -> FeedProblem? {
        let title: String, what: String, next: String, detail: String?
        switch self {
        case .noWallet, .reading, .live, .catchingUp: return nil
        case .behind(let seconds):
            title = "Prices Are Running Behind"
            what = "Prices are \(Self.age(seconds)) behind the network, so the newest transactions may be missing."
            next = "This usually catches up by itself."
            detail = "The newest block in the data is \(Self.age(seconds)) old."
        case .serverUnreachable where serverURL.isOnThisMac:
            title = "The Price Service Isn't Running"
            what = "The price service on this Mac isn't running."
            next = "Start it, then try again."
            detail = "Nothing answered at \(serverURL.absoluteString). To start it, run pnpm start in the pricetag folder."
        case .serverUnreachable:
            title = "Can't Reach the Price Service"
            what = "The price service isn't answering."
            next = "Check your internet connection, then try again."
            detail = "Nothing answered at \(serverURL.absoluteString)."
        case .tooSlow:
            title = "This Wallet Is Slow to Read"
            what = "This wallet took more than \(Format.elapsed(seconds: Int(PortfolioStore.firstReadTimeout.components.seconds))) to read, so the read stopped."
            next = "Another try starts by itself."
            detail = "The price service is answering, but its read of this wallet didn't finish in time."
        case .ampUnavailable(let message):
            title = "Prices Aren't Available Right Now"
            what = "The price service can't get its data right now."
            next = "It usually clears up by itself, and updates start again when it does."
            detail = "The price service said: \(message)"
        case .noAmpConfigured(let message):
            title = "No Price Data Set Up"
            what = "The price service has no data source, so only the demo wallet works."
            next = serverURL.isOnThisMac ? "Set one up, then restart the price service." : "Whoever runs it needs to set one up."
            detail = "The price service said: \(message)" + (serverURL.isOnThisMac ? " Its data source goes in .env.local." : "")
        case .rejected(let message):
            title = "Couldn't Read This Wallet"
            what = "The price service turned this request down."
            next = serverURL.isOnThisMac ? "Try again. If it keeps happening, restart the price service." : "Try again. If it keeps happening, let whoever runs the price service know."
            detail = "The price service said: \(message)"
        case .tooBig(let message):
            title = "Too Much History to Read"
            what = "This is more history than the price service can hold at once, so there are no numbers to show rather than incomplete ones."
            next = "Trying again won't change this."
            detail = "The price service said: \(message)"
        case .rateLimited(let message):
            title = "Slowed Down for a Moment"
            what = "The price service asked this app to slow down."
            next = "Updates start again by themselves."
            detail = "The price service said: \(message)"
        }
        let stale = portfolio.flatMap { $0.progress.started ? Wording.stale(lastUpdate: $0.latest.date.map(Format.time) ?? $0.latest.timestamp) : nil }
        return FeedProblem(title: title, message: [what, stale, Wording.moneyUnaffected, next].compactMap { $0 }.joined(separator: " "), detail: detail)
    }

    /// What's wrong, in a sentence that says numbers shown alongside it are old. nil when nothing is.
    public func staleNotice(serverURL: URL, portfolio: Portfolio?) -> String? {
        // These numbers are still updating, up to where the dataset has reached.
        if self == .catchingUp { return portfolio.flatMap(Wording.catchingUp) }
        return problem(serverURL: serverURL, portfolio: portfolio)?.message
    }

    /// `problem` in a few words, for the menu bar's view. nil when nothing is wrong.
    public func shortProblem(portfolio: Portfolio?) -> String? {
        switch self {
        case .noWallet, .reading, .live: nil
        case .catchingUp: portfolio.flatMap(Wording.shortCatchingUp)
        case .behind(let seconds): "Prices are \(Self.age(seconds)) behind"
        case .serverUnreachable: "Price service is down"
        case .tooSlow: "Wallet is slow to read"
        case .ampUnavailable: "Prices unavailable for now"
        case .noAmpConfigured: "No price data set up"
        case .rejected: "Couldn't read this wallet"
        case .tooBig: "Too much history to read"
        case .rateLimited: "Slowed down for a moment"
        }
    }

    private static func age(_ seconds: Int) -> String {
        if seconds < 3600 { return "\(max(1, seconds / 60)) min" }
        return "\(seconds / 3600) h"
    }
}
