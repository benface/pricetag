import Foundation
import KeyVault
import Observation
import PricetagKit

/// What a camera read, or someone pasted. Only a plain address counts, on its own or as `ethereum:<address>`, with a chain number at most.
/// A payment request's address can be a token's contract rather than a wallet, so anything after that means it isn't one of these. It's
/// all dropped without being shown, since a code on a hardware wallet's screen can be private.
public enum ScannedAddress: Equatable, Sendable {
    case address(EthereumAddress)
    /// Keystone's code for connecting a wallet, which isn't the one on its receive screen.
    case connectCode
    case somethingElse

    public init(text: String) {
        var clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.lowercased().hasPrefix("ur:") {
            self = .connectCode
            return
        }
        if clean.lowercased().hasPrefix("ethereum:") {
            clean = String(clean.dropFirst("ethereum:".count))
            if let at = clean.firstIndex(of: "@") {
                guard clean[clean.index(after: at)...].wholeMatch(of: /[0-9]+/) != nil else {
                    self = .somethingElse
                    return
                }
                clean = String(clean[..<at])
            }
        }
        self = EthereumAddress(clean).map(Self.address) ?? .somethingElse
    }
}

/// "Add a Savings Wallet", one step at a time. The device's own screen stays the only proof: however an address gets here, nothing's
/// added until the person says it matches, and a new address always takes that answer back.
@MainActor
@Observable
public final class AddSavingsModel {
    public enum Device: String, CaseIterable, Sendable {
        case ledger, keystone, other

        var defaultName: String {
            switch self {
            case .ledger: "Ledger"
            case .keystone: "Keystone"
            case .other: ""
            }
        }

        /// Only for its wording. Anyone can make a link, and the person still compares the address.
        init(named name: String) {
            self = Self.allCases.first { $0.defaultName.lowercased() == name.lowercased() } ?? .other
        }
    }

    public enum Step: Equatable, Sendable {
        case pick
        case ledgerPlugIn, ledgerApp, ledgerQuit, ledgerBrowser
        case keystoneUnlock, keystoneReceive, keystoneScan
        case paste, check, finished
    }

    public private(set) var device: Device?
    public private(set) var step = Step.pick
    public private(set) var link: AddSavingsLink?
    public private(set) var isWaitingForBrowser = false
    public private(set) var scanProblem: String?
    public private(set) var added: EthereumAddress?
    /// Whether adding it may have given something waiting somewhere to go, as far as could be told then.
    public private(set) var startedSweeps = false
    public var name = ""
    public var address = "" {
        didSet { if address != oldValue { takeBackAnswers() } }
    }
    public var matches = false
    public var acceptedAccounts: Set<String> = []

    private let wallet: HotWallet
    private var earlier: [Step] = []

    public init(wallet: HotWallet) {
        self.wallet = wallet
    }

    /// Starts partway through, for a link that arrives on its own, or a test scene.
    public init(wallet: HotWallet, device: Device?, step: Step, address: String = "", waitingForBrowser: Bool = false) {
        self.wallet = wallet
        self.device = device
        self.step = step
        self.address = address
        isWaitingForBrowser = waitingForBrowser
        name = device?.defaultName ?? ""
    }

    public var parsed: EthereumAddress? {
        if case .address(let address) = ScannedAddress(text: address) { address } else { nil }
    }

    public var problem: String? {
        guard let parsed else { return nil }
        if wallet.settings.coldWallets.contains(where: { $0.address == parsed }) { return AddSavingsWording.alreadyAdded }
        return switch wallet.problem(addingColdWallet: parsed) {
        case .notAnAddress, .isZero: "That isn't a wallet anyone can use."
        case .isThisHotWallet: "That's this Mac's spending money, not a savings wallet."
        case .isARetiredKey: "That's an old key from this Mac, whose private key is gone."
        case nil: nil
        }
    }

    public var canAdd: Bool { parsed != nil && problem == nil && matches }

    /// The first savings wallet becomes where sweeps go, and they run by themselves. This wallet already has something it wants to sweep,
    /// or hasn't read its balance yet, so it can't say that it doesn't. Adding doesn't wait for that read, and a sweep can follow right after it.
    public var wouldStartSweeps: Bool {
        guard wallet.settings.sweepDestination == nil else { return false }
        guard let plan = wallet.plan else { return true }
        return plan.blockers.contains(.noDestination)
    }

    /// What adding this does to sweeps, if anything. Only the first one changes where they go, and even with nothing to sweep now, more can arrive.
    public var sweepNotice: String? {
        guard wallet.settings.sweepDestination == nil else { return nil }
        guard wouldStartSweeps else { return AddSavingsWording.firstWallet }
        return wallet.plan == nil ? AddSavingsWording.balanceUnread : AddSavingsWording.startsSweeps
    }

    /// Whether money may be moving here by itself by now, whatever could be told when it was added.
    public var mayBeSweeping: Bool {
        guard let added, added == wallet.settings.sweepDestination else { return false }
        return startedSweeps || wallet.plan?.transfers.isEmpty == false || wallet.records.contains { $0.reason == .aboveCap && $0.to == added }
    }
    public var canGoBack: Bool { !earlier.isEmpty && step != .finished }

    /// Where this is among the device's steps, for the dots.
    public var progress: (current: Int, total: Int)? {
        guard let device, let current = sequence(device).firstIndex(of: step) else { return nil }
        return (current, sequence(device).count)
    }

    /// Only while this is the wallet the link named, which is all it can be said to know about.
    public var suggestedAccounts: [String] {
        guard let link, address.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == link.address.lowercased() else { return [] }
        return link.linked
    }

    public var sweepsGoHere: Bool { added != nil && added == wallet.settings.sweepDestination }
    public var sweepDestinationName: String? { wallet.settings.coldWallets.first { $0.address == wallet.settings.sweepDestination }?.name }
    public var canSendTest: Bool { wallet.canSend && !mayBeSweeping }

    public func choose(_ device: Device) {
        self.device = device
        name = device.defaultName
        move(to: sequence(device)[0])
    }

    public func next() {
        guard let device, let current = sequence(device).firstIndex(of: step), current + 1 < sequence(device).count else { return }
        move(to: sequence(device)[current + 1])
    }

    public func back() {
        guard canGoBack, let previous = earlier.popLast() else { return }
        // It came from the device or a link, and going back means getting it again. A pasted one can be fixed where it was pasted.
        if step == .check, previous != .paste {
            address = ""
            link = nil
        }
        takeBackAnswers()
        scanProblem = nil
        isWaitingForBrowser = false
        step = previous
    }

    public func wentToBrowser() {
        isWaitingForBrowser = true
    }

    /// For when the device's own route won't do, like a Mac with no camera.
    public func enterByHand() {
        move(to: .paste)
    }

    /// What the camera read. Repeats are fine, since it keeps reading whatever's in front of it.
    public func read(_ text: String) {
        guard step == .keystoneScan else { return }
        switch ScannedAddress(text: text) {
        case .address(let scanned):
            scanProblem = nil
            address = scanned.checksummed
            move(to: .check)
        case .connectCode: scanProblem = AddSavingsWording.scannedConnectCode
        case .somethingElse: scanProblem = AddSavingsWording.scannedSomethingElse
        }
    }

    /// The web app's answer. Anyone can send one at any time, so it always starts the check over, even in the middle of this.
    public func receive(_ link: AddSavingsLink) {
        let cameBackFromBrowser = step == .ledgerBrowser
        if !cameBackFromBrowser { device = Device(named: link.name) }
        earlier = cameBackFromBrowser ? earlier + [.ledgerBrowser] : []
        self.link = link
        address = link.address
        takeBackAnswers()
        name = link.name.isEmpty ? device?.defaultName ?? "" : link.name
        scanProblem = nil
        added = nil
        startedSweeps = false
        isWaitingForBrowser = false
        step = .check
    }

    public func add() throws(HotWallet.ColdWalletProblem) {
        guard canAdd, let parsed else { return }
        let startsSweeps = wouldStartSweeps
        try wallet.addColdWallet(address: parsed.checksummed, name: name)
        wallet.linkDeviceAccounts(link?.accountsToLink(accepted: acceptedAccounts, adding: address) ?? [])
        added = parsed
        startedSweeps = startsSweeps
        earlier = []
        step = .finished
    }

    public func sweepHere() {
        if let added { wallet.setSweepDestination(added) }
    }

    private func sequence(_ device: Device) -> [Step] {
        switch device {
        case .ledger: step == .paste || earlier.contains(.paste) ? [.ledgerPlugIn, .ledgerApp, .ledgerQuit, .ledgerBrowser, .paste, .check] : [.ledgerPlugIn, .ledgerApp, .ledgerQuit, .ledgerBrowser, .check]
        case .keystone: step == .paste || earlier.contains(.paste) ? [.keystoneUnlock, .keystoneReceive, .keystoneScan, .paste, .check] : [.keystoneUnlock, .keystoneReceive, .keystoneScan, .check]
        case .other: [.paste, .check]
        }
    }

    private func move(to next: Step) {
        earlier.append(step)
        step = next
    }

    private func takeBackAnswers() {
        matches = false
        acceptedAccounts = []
    }
}

/// What the flow says, in the device's own words. They come from Ledger's and Keystone's docs and firmware, and `HARDWARE-WALLETS.md` lists where.
public enum AddSavingsWording {
    public struct Trouble: Equatable, Sendable {
        public let when: String
        public let then: String
    }

    public struct Page: Equatable, Sendable {
        public let title: String
        public let body: String
        public var troubles: [Trouble] = []

        /// For when what it says to do can't be done, and something else takes its place.
        public var titleOnly: Page { Page(title: title, body: "") }
    }

    public static let neverAsked = "You'll never need your recovery phrase here. If anything asks for it, stop."
    public static let alreadyAdded = "That's already one of your savings wallets."
    public static let scannedConnectCode = "That's its connect code. Go back to Receive ETH, and show that code instead."
    public static let scannedSomethingElse = "That code isn't an address. Show the one under Receive ETH."
    public static let checkWarning = "Sweeps send real money here, and a compromised computer could show you the wrong address. The device's screen is the only one to trust."
    public static let camera = "Your camera's picture stays on this Mac, and nothing's saved."
    public static let matches = "Every character matches what my device's screen shows"
    public static let startsSweeps = "This Mac's spending money has more than its cap. Once you add this, what's above the cap can move here by itself, right away."
    public static let balanceUnread = "This Mac's spending money hasn't finished reading its balance. Once you add this, anything above the cap can move here by itself, right away."
    public static let firstWallet = "This becomes where sweeps go. From now on, anything above your cap, and any realized gains, can move here by itself."
    public static let sweepsStarted = "What's above your cap may already be on its way here. From now on, it goes here by itself."
    public static let testFirst = "Send a few dollars here first, and make sure they arrive before trusting it with more."
    public static let testAfterSweep = "Make sure it arrives before trusting this wallet with more."

    public static func deviceSubtitle(_ device: AddSavingsModel.Device) -> String {
        switch device {
        case .ledger: "Connects by USB, through your browser"
        case .keystone: "Shows a code to your Mac's camera"
        case .other: "Paste its address"
        }
    }

    public static func page(_ step: AddSavingsModel.Step, device: AddSavingsModel.Device?) -> Page {
        switch step {
        case .pick:
            Page(title: "Add a Savings Wallet", body: "This is where money above your cap goes. What kind of wallet is it?")
        case .ledgerPlugIn:
            Page(title: "Plug in your Ledger", body: "Connect it with its USB cable, then enter your PIN.", troubles: [
                Trouble(when: "Its screen stays dark", then: "Try another cable or port. Some cables only charge."),
                Trouble(when: "You use it over Bluetooth", then: "This needs the cable. A browser can only reach it by USB."),
            ])
        case .ledgerApp:
            Page(title: "Open the Ethereum app", body: "On your Ledger, press the right button until you see Ethereum, then press both buttons. It should say \"app is ready\". Base uses this app too.", troubles: [
                Trouble(when: "There's no Ethereum app", then: "Open Ledger Wallet on this Mac, go to My Ledger, search for Ethereum, and press Install."),
            ])
        case .ledgerQuit:
            Page(title: "Quit Ledger Wallet", body: "Only one app can talk to your Ledger at a time, so it can't be open during this.")
        case .ledgerBrowser:
            Page(title: "Continue in your browser", body: "This Mac app can't reach a Ledger yet, so a browser does this part and sends the address back.", troubles: [
                Trouble(when: "You'd rather not use a browser", then: "In Ledger Wallet, press Receive and choose your Base account. It shows the address there and on your Ledger, and you can paste it here."),
            ])
        case .keystoneUnlock:
            Page(title: "Unlock your Keystone", body: "Wake it up, then use your password, PIN or fingerprint.", troubles: [
                Trouble(when: "It won't wake up", then: "Hold its power button, or charge it for a while."),
            ])
        case .keystoneReceive:
            Page(title: "Show your ETH address", body: "On its home screen, tap ETH. You should see Receive ETH and a code. Base uses this same address, even though it only says ETH.", troubles: [
                Trouble(when: "There's no ETH", then: "Turn it on under Manage Assets."),
                Trouble(when: "It says Attention", then: "Read it, then tap Got It."),
                Trouble(when: "You want another account", then: "Tap Switch Account. Any of them work."),
                Trouble(when: "You changed its path before", then: "Tap ⋯, then Change Derivation Path, and choose BIP 44 Standard. Top Up can only reach those accounts."),
            ])
        case .keystoneScan:
            Page(title: "Show it to your camera", body: "Hold your Keystone's code steady in the frame.", troubles: [
                Trouble(when: "It won't read", then: "Move it back a little, tilt it away from any glare, and turn up its brightness."),
            ])
        case .paste:
            switch device {
            case .ledger: Page(title: "Paste the address", body: "From Ledger Wallet's Receive screen, for your Base account.")
            case .keystone: Page(title: "Type the address", body: "Type what your Keystone shows under Receive ETH.")
            default: Page(title: "Paste its address", body: "Find your wallet's receive address for Base, and copy it here.")
            }
        case .check:
            switch device {
            case .ledger:
                Page(title: "Does your Ledger show this?", body: "It should say Verify Base address, then show the address. Compare every group, then choose Confirm on your Ledger.", troubles: [
                    Trouble(when: "It doesn't match", then: "Stop. Choose Reject on your Ledger, press Cancel here, and don't send anything."),
                    Trouble(when: "Your Ledger shows nothing", then: "Go back to your browser, and press Open the Mac app again. That shows it on your Ledger again too."),
                    Trouble(when: "It just says Verify address", then: "That's an older Ethereum app. The address is the same."),
                ])
            case .keystone:
                Page(title: "Does your Keystone show this?", body: "Compare every group with the address under Receive ETH.", troubles: [
                    Trouble(when: "It doesn't match", then: "Stop. Press Cancel, and don't send anything."),
                ])
            default:
                Page(title: "Does your wallet show this?", body: "Compare every group with your wallet's own screen.", troubles: [
                    Trouble(when: "It doesn't match", then: "Stop. Press Cancel, and don't send anything."),
                ])
            }
        case .finished:
            Page(title: "It's added", body: testFirst)
        }
    }

    /// The Ledger step's waiting list, after the browser opens.
    public static func browserSteps(_ browser: String) -> [String] {
        ["Choose your Ledger in \(browser)'s list.", "Pick an account.", "Press Add to the Mac app, and allow it to open."]
    }

    public static let browserTroubles = [
        Trouble(when: "Your Ledger isn't in the list", then: "Check it's unlocked and Ledger Wallet is closed, then unplug it and plug it back in."),
        Trouble(when: "The page won't load", then: "This app's server has to be running on this Mac."),
    ]

    public static func browserBody(_ browser: String, defaultThatCant: String?) -> String {
        let why = defaultThatCant.map { "\($0) can't reach a Ledger, so this opens \(browser) instead." } ?? "This Mac app can't reach a Ledger yet, so \(browser) does this part."
        return "\(why) It sends the address back here."
    }

    public static func noBrowser(_ defaultThatCant: String?) -> String {
        "\(defaultThatCant ?? "Your browser") can't reach a Ledger. Install Chrome, Brave or Edge, then come back."
    }
}
