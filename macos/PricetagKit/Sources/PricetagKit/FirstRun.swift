import Foundation
import Observation

/// What someone new is still to be shown. Each part happens once, can be skipped, and never comes back by itself.
/// An install that was already in use when this arrived has seen it all, so nothing here ever appears on it.
@MainActor
@Observable
public final class FirstRun {
    /// There's no wallet with numbers yet, so the window is about getting to one.
    public private(set) var isWelcoming: Bool
    /// The first numbers haven't been explained yet.
    public private(set) var explainsNumbers: Bool
    /// The first question hasn't said why it's asking yet.
    public private(set) var explainsQuestions: Bool
    /// The address a first read found to be a contract, so what's shown for it can say so. Only for the wallet that's showing.
    public var contractWallet: String?
    @ObservationIgnored private let defaults: UserDefaults?

    /// For anything with nothing to show someone new, like a wallet that's already set up.
    public static let finished = FirstRun()

    private init() {
        defaults = nil
        isWelcoming = false
        explainsNumbers = false
        explainsQuestions = false
    }

    /// `isExistingInstall` only counts the first time this runs. After that, what's been seen is what's saved.
    public init(defaults: UserDefaults = .standard, isExistingInstall: Bool) {
        self.defaults = defaults
        if defaults.object(forKey: Keys.started) == nil {
            defaults.set(true, forKey: Keys.started)
            if isExistingInstall {
                for key in [Keys.welcomed, Keys.explainedNumbers, Keys.explainedQuestions] { defaults.set(true, forKey: key) }
            }
        }
        isWelcoming = !defaults.bool(forKey: Keys.welcomed)
        explainsNumbers = !defaults.bool(forKey: Keys.explainedNumbers)
        explainsQuestions = !defaults.bool(forKey: Keys.explainedQuestions)
    }

    public func finishWelcome() {
        guard isWelcoming else { return }
        isWelcoming = false
        defaults?.set(true, forKey: Keys.welcomed)
    }

    public func finishNumbers() {
        guard explainsNumbers else { return }
        explainsNumbers = false
        defaults?.set(true, forKey: Keys.explainedNumbers)
    }

    public func finishQuestions() {
        guard explainsQuestions else { return }
        explainsQuestions = false
        defaults?.set(true, forKey: Keys.explainedQuestions)
    }

    /// All of it, for good.
    public func skip() {
        finishWelcome()
        finishNumbers()
        finishQuestions()
    }

    /// Asked for from the Help menu. With a wallet already showing, there's nothing to get to, so only the explanations come back.
    public func showAgain(hasWallet: Bool) {
        guard defaults != nil else { return }
        for key in [Keys.explainedNumbers, Keys.explainedQuestions] { defaults?.set(false, forKey: key) }
        explainsNumbers = true
        explainsQuestions = true
        if !hasWallet {
            defaults?.set(false, forKey: Keys.welcomed)
            isWelcoming = true
        }
    }

    private enum Keys {
        static let started = "firstRun.started"
        static let welcomed = "firstRun.welcomed"
        static let explainedNumbers = "firstRun.explainedNumbers"
        static let explainedQuestions = "firstRun.explainedQuestions"
    }
}

/// How far the server has got with a wallet's first read. It's what the server reports, not an estimate.
public struct FirstReadProgress: Decodable, Equatable, Sendable {
    public enum Stage: String, Decodable, Sendable {
        case waiting, transfers, prices, checking, costs
    }

    public struct Step: Equatable, Identifiable, Sendable {
        public enum State: Sendable { case done, now, later }
        public let id: Stage
        public let title: String
        public let state: State
    }

    public let stage: Stage
    public let transfers: Int?
    /// Nil when the node didn't say.
    public let isContract: Bool?

    public init(stage: Stage, transfers: Int? = nil, isContract: Bool? = nil) {
        self.stage = stage
        self.transfers = transfers
        self.isContract = isContract
    }

    public var steps: [Step] {
        let order: [Stage] = [.transfers, .prices, .checking, .costs]
        let reached = order.firstIndex(of: stage) ?? 0
        return order.enumerated().map { index, stage in
            let state: Step.State = index < reached ? .done : index == reached ? .now : .later
            return Step(id: stage, title: Self.title(of: stage, state: state, transfers: transfers), state: state)
        }
    }

    private static func title(of stage: Stage, state: Step.State, transfers: Int?) -> String {
        switch stage {
        case .waiting, .transfers:
            guard state == .done, let transfers else { return "Finding transfers" }
            return transfers == 0 ? "No transfers found" : "Found \(transfers.formatted()) \(transfers == 1 ? "transfer" : "transfers")"
        case .prices: return "Looking up their prices"
        case .checking: return "Checking balances against Base"
        case .costs: return "Working out what it paid"
        }
    }
}

extension Wording {
    public static let welcomeTitle = "Know What You Paid"
    public static func welcomePitch(appName: String) -> String {
        "\(appName) puts a price on your wallet's transfers on Base, so it can finally tell you what you paid and how you've done. When it can't tell, it says so. It never guesses."
    }
    public static let watchHint = "This only reads what's public. Nothing here can move your money."
    public static let savingsSummary = "A hardware wallet for what you keep. It starts with Spending Money, which sends what's over its cap here."
    public static let readingTitle = "Reading This Wallet"
    public static let readTakingLong = "This wallet is taking longer than most. It keeps going by itself, so you can leave this open or choose another wallet."
    public static let contractNotice = "This address is a smart contract. If it's a smart wallet, that's fine. If it's a token or an app, its numbers won't mean much, and a busy one can take minutes to read."
    public static let emptyOnFirstRead = "History only goes back that far, so this doesn't mean the wallet is empty."

    public static func firstNumbers(_ portfolio: Portfolio) -> String {
        "Click any number to see where it came from. History goes back about \(Format.duration(ms: BlockTime.msBetween(portfolio.coverage.fromBlock, portfolio.coverage.toBlock))), and prices cover ETH and a short list of tokens. Anything else says unknown, and is never counted as $0."
    }

    public static let firstQuestion = "Base shows money arriving, but not always what it cost you, so a few answers fill that in. Skip any you're not sure of. Your answers stay on this Mac, and the server only uses them to work out your numbers."
}
