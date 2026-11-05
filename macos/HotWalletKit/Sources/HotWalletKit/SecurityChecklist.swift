import Foundation
import PricetagKit

/// One good habit, and whether it's in place. Only what was checked is ever marked done.
public struct SecurityCheck: Identifiable, Equatable, Sendable {
    public enum ID: String, Sendable {
        case savings, cap, approvals, alarm, sites, password, fileVault
    }

    public enum Status: Equatable, Sendable {
        case done
        case todo
        /// It couldn't be checked, so it's neither.
        case unknown
    }

    public enum Fix: Equatable, Sendable {
        case addSavings
        case changeCap
        case showSpendingMoney
        case reviewSites
        case openSettings(SystemSettingsPane)
    }

    public let id: ID
    public let title: String
    public let status: Status
    public let detail: String
    public let fix: Fix?
}

/// The parts of System Settings a fix can open.
public enum SystemSettingsPane: String, Sendable {
    case fileVault = "x-apple.systempreferences:com.apple.preference.security?FileVault"
    case users = "x-apple.systempreferences:com.apple.Users-Groups-Settings.extension"

    public var url: URL { URL(string: rawValue)! }
}

/// What the checklist is worked out from. Nil means it couldn't be read.
public struct SecurityFacts: Equatable, Sendable {
    public enum Alarm: Equatable, Sendable {
        case watching
        case raised
        /// It can't read the chain or the history right now, so it can't tell.
        case cantCheck
    }

    /// Spending Money exists, so its own checks apply.
    public var hasSpendingMoney: Bool
    /// Savings wallets, each confirmed on its device when it was added.
    public var savingsWallets: Int
    public var capUsdMicros: UInt128
    /// The cap, as it's shown in the main currency.
    public var capText: String
    public var alarm: Alarm
    public var connectedSites: Int
    /// The wallet showing, by name, and how many unlimited approvals it has. Nil while they're being read, or when they can't be.
    /// With no wallet showing, there are no approvals to check.
    public var walletTitle: String?
    public var unlimitedApprovals: Int?
    public var approvalsFailed: Bool
    public var hasPassword: Bool?
    public var fileVaultOn: Bool?

    public init(hasSpendingMoney: Bool, savingsWallets: Int, capUsdMicros: UInt128, capText: String, alarm: Alarm, connectedSites: Int, walletTitle: String?, unlimitedApprovals: Int?, approvalsFailed: Bool, hasPassword: Bool?, fileVaultOn: Bool?) {
        self.hasSpendingMoney = hasSpendingMoney
        self.savingsWallets = savingsWallets
        self.capUsdMicros = capUsdMicros
        self.capText = capText
        self.alarm = alarm
        self.connectedSites = connectedSites
        self.walletTitle = walletTitle
        self.unlimitedApprovals = unlimitedApprovals
        self.approvalsFailed = approvalsFailed
        self.hasPassword = hasPassword
        self.fileVaultOn = fileVaultOn
    }
}

public enum SecurityChecklist {
    /// More than this many sites is more than most people use.
    public static let fewSites = 3
    /// The suggested cap. Anything above it is still allowed, and only suggested lower.
    public static let lowCap = WalletSettings.suggestedCap

    public static func checks(_ facts: SecurityFacts) -> [SecurityCheck] {
        var checks: [SecurityCheck] = []
        if facts.hasSpendingMoney {
            checks.append(savings(facts))
            checks.append(cap(facts))
        }
        if let walletTitle = facts.walletTitle { checks.append(approvals(facts, walletTitle)) }
        if facts.hasSpendingMoney {
            checks.append(alarm(facts))
            checks.append(sites(facts))
        }
        checks.append(password(facts))
        checks.append(fileVault(facts))
        return checks
    }

    private static func savings(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "A savings wallet on a hardware device"
        return switch facts.savingsWallets {
        case 0: SecurityCheck(id: .savings, title: title, status: .todo, detail: "Most of your money is safest on a device that never connects to a site.", fix: .addSavings)
        case 1: SecurityCheck(id: .savings, title: title, status: .done, detail: "Checked on its device's screen when you added it.", fix: nil)
        default: SecurityCheck(id: .savings, title: title, status: .done, detail: "\(facts.savingsWallets) of them, each checked on its device's screen.", fix: nil)
        }
    }

    private static func cap(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "A low cap on \(HotWalletWording.title)"
        return facts.capUsdMicros <= lowCap
            ? SecurityCheck(id: .cap, title: title, status: .done, detail: "\(facts.capText), so that's the most a stolen key could reach.", fix: nil)
            : SecurityCheck(id: .cap, title: title, status: .todo, detail: "It's \(facts.capText). A lower cap keeps less within reach of a stolen key.", fix: .changeCap)
    }

    private static func approvals(_ facts: SecurityFacts, _ walletTitle: String) -> SecurityCheck {
        let title = "No unlimited approvals"
        guard let count = facts.unlimitedApprovals else {
            return SecurityCheck(id: .approvals, title: title, status: .unknown, detail: facts.approvalsFailed ? "Couldn't read \(walletTitle)'s approvals." : "Reading \(walletTitle)'s approvals…", fix: nil)
        }
        return count == 0
            ? SecurityCheck(id: .approvals, title: title, status: .done, detail: "None found on \(walletTitle).", fix: nil)
            : SecurityCheck(id: .approvals, title: title, status: .todo, detail: "\(count == 1 ? "One approval" : "\(count) approvals") on \(walletTitle) \(count == 1 ? "has" : "have") no limit. They're below.", fix: nil)
    }

    private static func alarm(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "The stolen-key alarm on"
        return switch facts.alarm {
        case .watching: SecurityCheck(id: .alarm, title: title, status: .done, detail: "It checks every transaction while \(SiteWording.appName) is open.", fix: nil)
        case .raised: SecurityCheck(id: .alarm, title: title, status: .todo, detail: "It went off. \(HotWalletWording.title) shows what it found.", fix: .showSpendingMoney)
        case .cantCheck: SecurityCheck(id: .alarm, title: title, status: .unknown, detail: "It can't check right now, because the network isn't answering.", fix: nil)
        }
    }

    private static func sites(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "Only the sites you use"
        let count = facts.connectedSites
        if count > fewSites {
            return SecurityCheck(id: .sites, title: title, status: .todo, detail: "\(count) sites can ask \(HotWalletWording.title) to sign. Disconnect the ones you don't use.", fix: .reviewSites)
        }
        return SecurityCheck(id: .sites, title: title, status: .done, detail: count == 0 ? "No sites are connected." : "\(count == 1 ? "One site is" : "\(count) sites are") connected.", fix: count == 0 ? nil : .reviewSites)
    }

    private static func password(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "A login password on this Mac"
        return switch facts.hasPassword {
        case true?: SecurityCheck(id: .password, title: title, status: .done, detail: "It's needed to unlock this Mac and to approve anything here.", fix: nil)
        case false?: SecurityCheck(id: .password, title: title, status: .todo, detail: "Without one, anyone at this Mac can use it.", fix: .openSettings(.users))
        case nil: SecurityCheck(id: .password, title: title, status: .unknown, detail: "Couldn't check from here.", fix: .openSettings(.users))
        }
    }

    private static func fileVault(_ facts: SecurityFacts) -> SecurityCheck {
        let title = "FileVault on"
        return switch facts.fileVaultOn {
        case true?: SecurityCheck(id: .fileVault, title: title, status: .done, detail: "This Mac's disk is encrypted.", fix: nil)
        case false?: SecurityCheck(id: .fileVault, title: title, status: .todo, detail: "It keeps what's on this Mac unreadable if it's lost.", fix: .openSettings(.fileVault))
        case nil: SecurityCheck(id: .fileVault, title: title, status: .unknown, detail: "Couldn't check from here, so look in System Settings.", fix: .openSettings(.fileVault))
        }
    }
}

extension HotWallet {
    /// What the alarm can say right now.
    public var alarmFact: SecurityFacts.Alarm {
        if alarm != nil { return .raised }
        return chainProblem != nil ? .cantCheck : .watching
    }
}
