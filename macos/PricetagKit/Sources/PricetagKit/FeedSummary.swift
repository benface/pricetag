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
        case .reading: (text, isWarning) = ("Reading…", false)
        case .behind: (text, isWarning) = ("Behind", true)
        case .catchingUp: (text, isWarning) = ("Catching up", true)
        case .serverUnreachable: (text, isWarning) = ("Offline", true)
        case .ampUnavailable: (text, isWarning) = ("Data offline", true)
        case .noAmpConfigured: (text, isWarning) = ("No data", true)
        case .rejected: (text, isWarning) = ("Error", true)
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
            switch shows {
            case .icon:
                (text, isWarning) = (portfolio.mode == .demo ? "Demo" : "", false)
            case .value:
                guard let value = portfolio.totalValueText else {
                    (text, isWarning) = (prefix + Wording.valueUnavailable, true)
                    return
                }
                (text, isWarning) = (prefix + value, portfolio.isValuePartial)
            case .pnl:
                guard let pnl = portfolio.totalPnlText else {
                    (text, isWarning) = (prefix + Wording.pnlUnavailable, true)
                    return
                }
                (text, isWarning) = (prefix + pnl, portfolio.pnlStatus == .partial)
            }
        }
    }
}

extension FeedState {
    /// What's wrong, in a sentence that says numbers shown alongside it are old. nil when nothing is.
    public func staleNotice(serverURL: URL, portfolio: Portfolio?) -> String? {
        let problem: String
        switch self {
        case .noWallet, .reading, .live: return nil
        // These numbers are still updating, up to where the dataset has reached.
        case .catchingUp: return portfolio.flatMap(Wording.catchingUp)
        case .behind(let seconds): problem = "The newest data is \(Self.age(seconds)) old."
        case .serverUnreachable: problem = "Can't reach the server at \(serverURL.absoluteString)."
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): problem = message
        }
        guard let portfolio, portfolio.progress.started else { return problem }
        return "\(problem) \(Wording.stale(lastUpdate: portfolio.latest.date.map(Format.time) ?? portfolio.latest.timestamp))"
    }

    /// `staleNotice` in a few words, for the menu bar's view. nil when nothing is wrong.
    public func shortProblem(portfolio: Portfolio?) -> String? {
        switch self {
        case .noWallet, .reading, .live: nil
        case .catchingUp: portfolio.flatMap(Wording.shortCatchingUp)
        case .behind(let seconds): "Data is \(Self.age(seconds)) old"
        case .serverUnreachable: "Can't reach the server"
        case .ampUnavailable: "Can't reach the data"
        case .noAmpConfigured: "No data source"
        case .rejected: "Couldn't read this wallet"
        }
    }

    private static func age(_ seconds: Int) -> String {
        if seconds < 3600 { return "\(max(1, seconds / 60)) min" }
        return "\(seconds / 3600) h"
    }
}
