// Says in a few words what the feed knows, for the places with room for only that: the menu bar and a status badge.

import Foundation

public struct FeedSummary: Equatable, Sendable {
    /// Empty when there's nothing to say yet, and an icon has to do.
    public let text: String
    public let isWarning: Bool

    /// A number only appears here while the feed is live. Old numbers stay in the popover and the window, labeled as old.
    public init(feed: FeedState, portfolio: Portfolio?) {
        switch feed {
        case .noWallet: (text, isWarning) = ("", false)
        case .reading: (text, isWarning) = ("Reading…", false)
        case .behind: (text, isWarning) = ("Behind", true)
        case .catchingUp: (text, isWarning) = ("Catching up", true)
        case .serverUnreachable: (text, isWarning) = ("Offline", true)
        case .ampUnavailable: (text, isWarning) = ("Amp offline", true)
        case .noAmpConfigured: (text, isWarning) = ("No Amp", true)
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
            guard portfolio.pnlStatus != .unavailable, let pnl = portfolio.totals.pnlMicros else {
                (text, isWarning) = (prefix + Wording.pnlUnavailable, true)
                return
            }
            (text, isWarning) = (prefix + Format.signedMoney(pnl, portfolio.currency), portfolio.pnlStatus == .partial)
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
        case .behind(let seconds): problem = "Amp's newest block is \(Self.age(seconds)) old."
        case .serverUnreachable: problem = "Can't reach the server at \(serverURL.absoluteString)."
        case .ampUnavailable(let message), .noAmpConfigured(let message), .rejected(let message): problem = message
        }
        guard let portfolio, portfolio.progress.started else { return problem }
        return "\(problem) These numbers are through block \(Format.block(portfolio.coverage.toBlock)) and aren't updating."
    }

    private static func age(_ seconds: Int) -> String {
        if seconds < 3600 { return "\(max(1, seconds / 60)) min" }
        return "\(seconds / 3600) h"
    }
}
