#if DEBUG
import AppKit
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// What a scene is, in one place. Only what's different from most scenes gets said.
struct SceneSpec {
    /// What it draws.
    enum Screen {
        case main(CGSize = .regular)
        /// Help > Welcome from another section, with no wallet.
        case welcomeFromHelp(AppSection)
        /// What it says about a contract, arriving after its numbers.
        case welcomeWarningOfContract
        case mainOpeningFirstProof
        case mainAtItsEnd
        case welcomeAgain
        case chart(ChartPlay)
        case motionSend, motionPurchase, motionCostKnown, motionDetails, motionWalletUndo
        case contrast
        case resolve(height: CGFloat = 560)
        case resolveSkipping(ResolveSkip)
        case resolvePublishingFromDevice
        case holdComparison
        case route(Route)
        case walletSwitcher
        case taxReport, taxReportWithWallets
        case spendingMoneySetupSheet, spendingMoneySetup
        case popover
        case invitePrompt
        case menuBarLabel
        case settings
        case spendingMoney, spendingMoneyPurchases
        case addSavings, receive, buy, send
        case topUp(TopUpRead = .readsFirst)
        case security, revoke, sweep, sweepStopped
        case siteScreen, siteWindow
        case publishCost, publishFromDevice
        case ruleComparison
    }

    enum ChartPlay { case scrubbed(Int), scrubbedToAGap, drawing, changingRange, changingMetric, scrubbing }
    enum ResolveSkip { case toKnownExchange, everything }
    enum TopUpRead { case readsFirst, readsAfterItOpens, neverReads }
    /// What the menu bar's buttons do. Each fails unless it gets where it promises.
    enum Route { case send, topUp, buy, receive, addSavings, export, find, topUpCancelled, holdings, addWallet, details, answer, removeFromSavings }
    enum Browsers { case chromeOnly, safariAndChrome, safariOnly }
    enum SavedWallets { case three, longName, many }
    enum Answers { case none, recipientIsSomeoneElse, everyKind, emptyWalletIsMine, treasuryIsMine, treasuryAndRecentAreMine, unreadable }
    enum Purchases { case none, all, inCAD, lastThree }

    var screen: Screen
    var chrome = TestScene.Chrome.titled
    var feed = FixtureSource.Feed.demo
    var rulesAnswer = FixtureSource.RulesAnswer.rules
    var readProgress: FirstReadProgress?
    var hasWallet = true
    var usesDemoWallet = true
    var shownWallet: String?
    var listsWallets = false
    var currency = CurrencyCode.USD
    /// In another main currency, with a server that has no current rate.
    var hasNoRate = false
    var hotWallet = HotWalletFixture.none
    /// For scenes that only differ in the browsers on this Mac.
    var browsers = Browsers.chromeOnly
    /// Before there's a view, which is how it'd be for anyone opening a sheet: a sheet works out what it offers when it appears.
    var readsHotWalletFirst = true
    var section = AppSection.overview
    var chartRange = ChartRange.all
    var holdingsQuery = ""
    /// Once the window has its size, as when someone clicks. Before that it's too small for the details to fit beside the section.
    var opensDetails: ExplainTarget?
    var savedWallets = SavedWallets.three
    var answers = Answers.none
    /// The real app hears about this from the wallet, which these scenes never start.
    var hearsOfLinkedWallets = false
    var purchases = Purchases.none
    var hasTwoRules = false
    /// A read that's only just started, where every other that's going on has been going a while.
    var readJustStarted = false
    var problemIsLong = false
    var confirmsAddingSavings = false
    var inviteWasRefused = false
}

private extension CGSize {
    /// The window's usual sizes.
    nonisolated static let regular = CGSize(width: 1120, height: 760)
    nonisolated static let medium = CGSize(width: 900, height: 640)
    nonisolated static let narrow = CGSize(width: 780, height: 760)
    nonisolated static let smallest = CGSize(width: 780, height: 560)
}

private extension ExplainTarget {
    /// In live scenes, the asset asked for.
    static var aRealizedGain: ExplainTarget { .asset(TestMode.live?.asset ?? "AERO", .realized) }
}

/// What a scene has made by the time its screen is drawn.
@MainActor
private struct SceneParts {
    let defaults: UserDefaults
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    let purchases: PurchaseTracker
    let firstRun: FirstRun
    let isReady: () -> Bool
    let hotWalletHasRead: ReadOnce
    let readHotWallet: @MainActor () async -> Void

    func mainWindow() -> MainWindow {
        MainWindow(store: store, navigation: navigation, hotWallet: hotWallet, siteBridge: SiteBridge(wallet: hotWallet), purchases: purchases, firstRun: firstRun)
    }
}

enum TestScene: String, CaseIterable {
    case main
    /// Answers from a version that knows a currency this one doesn't.
    case mainUnreadableSaved = "main-unreadable-saved"
    case mainUnreadableSavedNoWallet = "main-unreadable-saved-no-wallet"
    case mainUnreadableSavedServerDown = "main-unreadable-saved-server-down"
    /// What a watch-only build asks when its server wants an invite.
    case invitePrompt = "invite-prompt"
    case invitePromptRefused = "invite-prompt-refused"
    /// Someone new. With `PATINA_WATCH_ONLY=1`, what a tester gets.
    case mainWelcome = "main-welcome"
    case mainWelcomeSmallest = "main-welcome-smallest"
    case mainWelcomeChecking = "main-welcome-checking"
    case mainWelcomeInvite = "main-welcome-invite"
    case mainWelcomeInviteRefused = "main-welcome-invite-refused"
    case mainWelcomeServerDown = "main-welcome-server-down"
    case mainWelcomeFirstRead = "main-welcome-first-read"
    case mainWelcomeFirstReadStart = "main-welcome-first-read-start"
    case mainWelcomeFirstReadSmallest = "main-welcome-first-read-smallest"
    /// A server from before it could report how far a read has got.
    case mainWelcomeFirstReadNoSteps = "main-welcome-first-read-no-steps"
    case mainWelcomeFirstReadContract = "main-welcome-first-read-contract"
    case mainWelcomeFirstReadTooSlow = "main-welcome-first-read-too-slow"
    case mainWelcomeFirstReadDown = "main-welcome-first-read-down"
    case mainWelcomeEmpty = "main-welcome-empty"
    case mainWelcomeNumbers = "main-welcome-numbers"
    /// What it says about a contract, arriving after its numbers. The first read is long gone by then.
    case mainWelcomeNumbersContract = "main-welcome-numbers-contract"
    /// Help > Welcome from another section, with no wallet. It has to stay open.
    case mainWelcomeHelpFromTransactions = "main-welcome-help-from-transactions"
    case mainWelcomeHelpFromTaxReport = "main-welcome-help-from-tax-report"
    case resolveFirstQuestion = "resolve-first-question"
    case welcomeAgain = "welcome-again"
    /// ⌘F on the overview, with what was typed, below the chart in a small window.
    case mainHoldingsSearch = "main-holdings-search"
    case mainHoldingsSearchSmall = "main-holdings-search-small"
    case mainHoldingsSearchNarrow = "main-holdings-search-narrow"
    case mainHoldingsSearchNone = "main-holdings-search-none"
    case mainTransactions = "main-transactions"
    case mainAllYours = "main-all-yours"
    case mainAllYoursBehind = "main-all-yours-behind"
    case mainAllYoursTransactions = "main-all-yours-transactions"
    case mainAllYoursDetails = "main-all-yours-details"
    case mainDetails = "main-details"
    case mainDetailsProof = "main-details-proof"
    case mainNarrow = "main-narrow"
    case mainSmall = "main-small"
    case mainMedium = "main-medium"
    case mainHuge = "main-huge"
    // Around where the holdings table changes shape, with the sidebar open.
    case mainWidth660 = "main-width-660"
    case mainWidth760 = "main-width-760"
    case mainWidth860 = "main-width-860"
    case mainWidth960 = "main-width-960"
    case mainWidth1040 = "main-width-1040"
    case mainFirstRunSmall = "main-first-run-small"
    case mainTransactionsSmall = "main-transactions-small"
    /// Spending Money's own transactions, with a send on its way and one that failed, which only this Mac knows about.
    case mainTransactionsSending = "main-transactions-sending"
    /// 65,000 transactions, as many as a busy wallet has.
    case mainTransactionsBusy = "main-transactions-busy"
    case mainSpendingMoney = "main-spending-money"
    case mainSpendingMoneySmall = "main-spending-money-small"
    case mainSpendingMoneyServerDown = "main-spending-money-server-down"
    case mainTaxReport = "main-tax-report"
    case mainSecurity = "main-security"
    case security
    case securitySignedPermits = "security-signed-permits"
    case securitySavings = "security-savings"
    case securityDemo = "security-demo"
    case securityReading = "security-reading"
    case securityStale = "security-stale"
    case securityNoSpendingMoney = "security-no-spending-money"
    case revoke
    case revokeOne = "revoke-one"
    case mainTaxReportSmall = "main-tax-report-small"
    /// The whole page, tall enough that nothing's scrolled out of the picture.
    case taxReport = "tax-report"
    /// The same, showing another wallet, so what's unknown is in a wallet added to the report.
    case taxReportAddedWallet = "tax-report-added-wallet"
    case taxReportOtherWallets = "tax-report-other-wallets"
    case taxReportLeftOver = "tax-report-left-over"
    case mainNoWalletSmall = "main-no-wallet-small"
    case mainNoWalletHasSpendingMoney = "main-no-wallet-has-spending-money"
    case mainNoWalletNotProvisioned = "main-no-wallet-not-provisioned"
    case mainNoWallet = "main-no-wallet"
    case mainNoWalletAfterDeleting = "main-no-wallet-after-deleting"
    case mainNoWalletSaved = "main-no-wallet-saved"
    case mainNoWalletSavedSmall = "main-no-wallet-saved-small"
    case mainReading = "main-reading"
    /// Another wallet's just been picked, or a setting changed: what was last known, while the read runs.
    case mainUpdating = "main-updating"
    case mainUpdatingNarrow = "main-updating-narrow"
    case mainUpdatingSmall = "main-updating-small"
    case mainUpdatingCAD = "main-updating-cad"
    case mainTransactionsUpdating = "main-transactions-updating"
    case mainServerDown = "main-server-down"
    case mainPricesDown = "main-prices-down"
    case mainPricesStop = "main-prices-stop"
    case mainTooSlow = "main-too-slow"
    case mainRetrying = "main-retrying"
    case mainRetryingNumbers = "main-retrying-numbers"
    case mainNotStartedFailing = "main-not-started-failing"
    case mainReadingStart = "main-reading-start"
    /// Another wallet's first read, long after the welcome. The demo wallet in the scenes above has no steps to show.
    case mainLaterRead = "main-later-read"
    case mainLaterReadSmallest = "main-later-read-smallest"
    case mainLaterReadNoSteps = "main-later-read-no-steps"
    case mainLaterReadContract = "main-later-read-contract"
    case mainLaterReadTooSlow = "main-later-read-too-slow"
    case mainLaterReadTransactions = "main-later-read-transactions"
    /// Inside a page that already scrolls, under what only Spending Money can do.
    case mainLaterReadSpendingMoney = "main-later-read-spending-money"
    case mainLaterReadAllYours = "main-later-read-all-yours"
    case mainNotUpdating = "main-not-updating"
    case mainNotUpdatingSmall = "main-not-updating-small"
    case mainLinkedFailed = "main-linked-failed"
    case mainEmpty = "main-empty"
    case mainEmptySmallest = "main-empty-smallest"
    case mainSmallest = "main-smallest"
    case mainSmallestEnd = "main-smallest-end"
    case mainEmptyNotice = "main-empty-notice"
    case mainFirstRun = "main-first-run"
    case mainFirstRunSmallest = "main-first-run-smallest"
    case mainFirstRunDetails = "main-first-run-details"
    case mainNotStarted = "main-not-started"
    case holdComparison = "hold-comparison"
    case mainHoldDetails = "main-hold-details"
    case mainCostWithheld = "main-cost-withheld"
    case mainSmallAmounts = "main-small-amounts"
    case mainSmallAmountsNarrow = "main-small-amounts-narrow"
    case mainLongHistory = "main-long-history"
    case mainChartGaps = "main-chart-gaps"
    case mainChartGapsSmall = "main-chart-gaps-small"
    case mainChartGapsNarrow = "main-chart-gaps-narrow"
    case mainChartWeek = "main-chart-week"
    case mainCAD = "main-cad"
    case mainTransactionsCAD = "main-transactions-cad"
    case mainDetailsCAD = "main-details-cad"
    case resolve
    /// Every question answered: what it was all for.
    case resolveFinished = "resolve-finished"
    /// Nothing left to ask, but it isn't all answered.
    case resolveNothingLeft = "resolve-nothing-left"
    case resolveCostWithheld = "resolve-cost-withheld"
    case resolvePublishFromDevice = "resolve-publish-from-device"
    case resolveAnsweredWallet = "resolve-answered-wallet"
    /// Past the last card with every question skipped.
    case resolveAllSkipped = "resolve-all-skipped"
    /// The card for an address known to be an exchange's, which has no My wallet.
    case resolveKnownExchange = "resolve-known-exchange"
    case walletSwitcher = "wallet-switcher"
    case walletSwitcherAllYours = "wallet-switcher-all-yours"
    case walletSwitcherFirstRun = "wallet-switcher-first-run"
    case walletSwitcherRenaming = "wallet-switcher-renaming"
    case walletSwitcherProblem = "wallet-switcher-problem"
    case walletSwitcherLong = "wallet-switcher-long"
    case walletSwitcherLongSmallDisplay = "wallet-switcher-long-small-display"
    case walletSwitcherAllYoursTwoWallets = "wallet-switcher-all-yours-two-wallets"
    case walletSwitcherNote = "wallet-switcher-note"
    case walletSwitcherNewKey = "wallet-switcher-new-key"
    case spendingMoneySetupSheet = "spending-money-setup-sheet"
    case mainShowingSpendingMoney = "main-showing-spending-money"
    case mainSavings = "main-savings"
    case mainEmptySpendingMoney = "main-empty-spending-money"
    case mainEmptySpendingMoneySmallest = "main-empty-spending-money-smallest"
    case mainEmptySavings = "main-empty-savings"
    case mainWatching = "main-watching"
    case mainWatchingNamed = "main-watching-named"
    case mainWatchingNamedSmallest = "main-watching-named-smallest"
    case popover
    case popoverNoWallet = "popover-no-wallet"
    case popoverNotUpdating = "popover-not-updating"
    case popoverNotStarted = "popover-not-started"
    case popoverFirstRun = "popover-first-run"
    case popoverLongName = "popover-long-name"
    case popoverLongNameReading = "popover-long-name-reading"
    case popoverUnreadableSaved = "popover-unreadable-saved"
    case popoverAllYoursBehind = "popover-all-yours-behind"
    case popoverCAD = "popover-cad"
    case popoverHotWallet = "popover-hot-wallet"
    case popoverHotWalletOverCap = "popover-hot-wallet-over-cap"
    case popoverHotWalletAlarm = "popover-hot-wallet-alarm"
    case popoverHotWalletCAD = "popover-hot-wallet-cad"
    case popoverReading = "popover-reading"
    case popoverUpdating = "popover-updating"
    case popoverServerDown = "popover-server-down"
    case popoverPricesDown = "popover-prices-down"
    case popoverRetrying = "popover-retrying"
    case popoverEmpty = "popover-empty"
    case popoverHotWalletNoSavings = "popover-hot-wallet-no-savings"
    case popoverHotWalletKeyMissing = "popover-hot-wallet-key-missing"
    case popoverNotProvisioned = "popover-not-provisioned"
    case popoverMissingPrice = "popover-missing-price"
    case mainMissingPrice = "main-missing-price"
    case popoverUnreadBalance = "popover-unread-balance"
    /// What the menu bar's buttons do, with the window closed and with it open on another section. Each fails unless its sheet opens.
    case routeSend = "route-send"
    case routeSendOpen = "route-send-open"
    case routeTopUp = "route-top-up"
    case routeTopUpOpen = "route-top-up-open"
    case routeBuy = "route-buy"
    case routeBuyOpen = "route-buy-open"
    case routeReceive = "route-receive"
    case routeReceiveOpen = "route-receive-open"
    case routeAddSavings = "route-add-savings"
    case routeExport = "route-export"
    case routeExportOpen = "route-export-open"
    case routeFind = "route-find"
    case routeFindOpen = "route-find-open"
    case routeTopUpCancelled = "route-top-up-cancelled"
    /// The menu bar's other destinations, starting from another section. Each fails unless it gets there and stays.
    case routeHoldings = "route-holdings"
    case routeHoldingsOpen = "route-holdings-open"
    case routeAddWallet = "route-add-wallet"
    case routeAddWalletOpen = "route-add-wallet-open"
    case routeDetails = "route-details"
    case routeDetailsOpen = "route-details-open"
    case routeAnswer = "route-answer"
    case routeAnswerOpen = "route-answer-open"
    case routeRemoveFromSavingsOpen = "route-remove-from-savings-open"
    case menuBarLabel = "menu-bar-label"
    case settings
    case settingsRules = "settings-rules"
    case settingsSmallDisplay = "settings-small-display"
    case settingsServer = "settings-server"
    case settingsServerProblem = "settings-server-problem"
    case settingsCAD = "settings-cad"
    case settingsAnswers = "settings-answers"
    case settingsAnswersEmpty = "settings-answers-empty"
    case settingsNotificationsOff = "settings-notifications-off"
    case settingsLoginItemOff = "settings-login-item-off"
    case hotWalletSetup = "hot-wallet-setup"
    case hotWalletNotProvisioned = "hot-wallet-not-provisioned"
    case hotWalletUnreadable = "hot-wallet-unreadable"
    case hotWallet = "hot-wallet"
    case hotWalletCAD = "hot-wallet-cad"
    case hotWalletNetworkProblem = "hot-wallet-network-problem"
    case hotWalletNoRate = "hot-wallet-no-rate"
    case hotWalletTwoSavings = "hot-wallet-two-savings"
    case hotWalletNoSavings = "hot-wallet-no-savings"
    case hotWalletNoSavingsCAD = "hot-wallet-no-savings-cad"
    case hotWalletNoPrice = "hot-wallet-no-price"
    case hotWalletNothingToSweep = "hot-wallet-nothing-to-sweep"
    case hotWalletOverCap = "hot-wallet-over-cap"
    case hotWalletOverCapCAD = "hot-wallet-over-cap-cad"
    case hotWalletOverCapNoSavings = "hot-wallet-over-cap-no-savings"
    case hotWalletKeyMissing = "hot-wallet-key-missing"
    case hotWalletAlarm = "hot-wallet-alarm"
    case hotWalletReplacingKey = "hot-wallet-replacing-key"
    case hotWalletReplacingKeyStuck = "hot-wallet-replacing-key-stuck"
    case hotWalletReplacingKeyMissing = "hot-wallet-replacing-key-missing"
    case hotWalletSites = "hot-wallet-sites"
    case hotWalletAddSavings = "hot-wallet-add-savings"
    case hotWalletAddSavingsFilled = "hot-wallet-add-savings-filled"
    case hotWalletAddSavingsFromDevice = "hot-wallet-add-savings-from-device"
    case addSavingsLedgerPlugIn = "add-savings-ledger-plug-in"
    case addSavingsLedgerPlugInTrouble = "add-savings-ledger-plug-in-trouble"
    case addSavingsLedgerApp = "add-savings-ledger-app"
    case addSavingsLedgerQuit = "add-savings-ledger-quit"
    case addSavingsLedgerQuitStillOpen = "add-savings-ledger-quit-still-open"
    case addSavingsLedgerBrowser = "add-savings-ledger-browser"
    case addSavingsLedgerBrowserSafari = "add-savings-ledger-browser-safari"
    case addSavingsLedgerBrowserNone = "add-savings-ledger-browser-none"
    case addSavingsLedgerWaiting = "add-savings-ledger-waiting"
    case addSavingsLedgerPaste = "add-savings-ledger-paste"
    case addSavingsLedgerCheckTrouble = "add-savings-ledger-check-trouble"
    case addSavingsKeystoneUnlock = "add-savings-keystone-unlock"
    case addSavingsKeystoneReceive = "add-savings-keystone-receive"
    case addSavingsKeystoneReceiveTrouble = "add-savings-keystone-receive-trouble"
    case addSavingsKeystoneScan = "add-savings-keystone-scan"
    case addSavingsKeystoneScanDenied = "add-savings-keystone-scan-denied"
    case addSavingsKeystoneScanNoCamera = "add-savings-keystone-scan-no-camera"
    case addSavingsKeystoneType = "add-savings-keystone-type"
    case addSavingsKeystoneCheck = "add-savings-keystone-check"
    case addSavingsKeystoneWalked = "add-savings-keystone-walked"
    case addSavingsOtherPaste = "add-savings-other-paste"
    case addSavingsPicked = "add-savings-picked"
    case addSavingsPickedCheck = "add-savings-picked-check"
    case addSavingsCheckStartsSweeps = "add-savings-check-starts-sweeps"
    case addSavingsCheckBalanceUnread = "add-savings-check-balance-unread"
    case addSavingsCheckFirstWallet = "add-savings-check-first-wallet"
    case addSavingsFinished = "add-savings-finished"
    case addSavingsFinishedSweeping = "add-savings-finished-sweeping"
    case addSavingsFinishedElsewhere = "add-savings-finished-elsewhere"
    case hotWalletPurchases = "hot-wallet-purchases"
    case hotWalletPurchasesCAD = "hot-wallet-purchases-cad"
    case hotWalletPurchasesCantCheck = "hot-wallet-purchases-cant-check"
    /// What clicking a notification opens: its row, lit up.
    case hotWalletPurchaseShown = "hot-wallet-purchase-shown"
    case hotWalletRecordShown = "hot-wallet-record-shown"
    /// A notification from before the key was replaced, whose row went with the old key.
    case hotWalletReplacedKeyShown = "hot-wallet-replaced-key-shown"
    case receive
    case receiveNoSavings = "receive-no-savings"
    case receiveCAD = "receive-cad"
    case receiveNotSetUp = "receive-not-set-up"
    case receiveAlarm = "receive-alarm"
    case buy
    case buyCAD = "buy-cad"
    case buyCADAboveRoom = "buy-cad-above-room"
    case buyCADTooLittle = "buy-cad-too-little"
    case buyNoRate = "buy-no-rate"
    case buyAboveRoom = "buy-above-room"
    case buyLarge = "buy-large"
    case buyAtCap = "buy-at-cap"
    case buyUSDCNoGas = "buy-usdc-no-gas"
    case buyNoWallet = "buy-no-wallet"
    case buyTooLittle = "buy-too-little"
    case buyNegative = "buy-negative"
    case buyNoSavings = "buy-no-savings"
    case buyNoSavingsAboveRoom = "buy-no-savings-above-room"
    case buyNoSavingsAtCap = "buy-no-savings-at-cap"
    case buyNoSavingsCAD = "buy-no-savings-cad"
    case buyFirstRead = "buy-first-read"
    case buyReading = "buy-reading"
    case buyNoSavingsFirstRead = "buy-no-savings-first-read"
    case buyNoSavingsAtCapFirstRead = "buy-no-savings-at-cap-first-read"
    case buyNotSetUp = "buy-not-set-up"
    case buyCantReachProvider = "buy-cant-reach-provider"
    case buyRefused = "buy-refused"
    case hotWalletTopUp = "hot-wallet-top-up"
    case hotWalletTopUpFirstRead = "hot-wallet-top-up-first-read"
    case hotWalletTopUpReading = "hot-wallet-top-up-reading"
    case hotWalletTopUpReadingSafari = "hot-wallet-top-up-reading-safari"
    case hotWalletTopUpNoGas = "hot-wallet-top-up-no-gas"
    case hotWalletTopUpOneDollar = "hot-wallet-top-up-one-dollar"
    case hotWalletTopUpAtCap = "hot-wallet-top-up-at-cap"
    case hotWalletTopUpNoSavings = "hot-wallet-top-up-no-savings"
    case hotWalletTopUpNoSavingsAtCap = "hot-wallet-top-up-no-savings-at-cap"
    case hotWalletTopUpCAD = "hot-wallet-top-up-cad"
    case hotWalletTopUpSafari = "hot-wallet-top-up-safari"
    case hotWalletTopUpNoChromium = "hot-wallet-top-up-no-chromium"
    case send
    case sendCAD = "send-cad"
    case sendKnown = "send-known"
    case sendPicking = "send-picking"
    case sendSearching = "send-searching"
    case sendPicked = "send-picked"
    case sendTypo = "send-typo"
    case sendShortened = "send-shortened"
    case sendTyping = "send-typing"
    case sendWaiting = "send-waiting"
    /// With VoiceOver on, Touch ID waits for the user to say they've heard it.
    case sendReviewing = "send-reviewing"
    case sendWhichUnits = "send-which-units"
    case sendWhichUnitsReviewing = "send-which-units-reviewing"
    case sendGoing = "send-going"
    case sendSent = "send-sent"
    case sendStopped = "send-stopped"
    case sendMoney = "send-money"
    case sendMoneyCAD = "send-money-cad"
    case sendLookalike = "send-lookalike"
    case sendLookalikeChecked = "send-lookalike-checked"
    case sendRefused = "send-refused"
    case sweep
    case sweepCAD = "sweep-cad"
    case sweepStopped = "sweep-stopped"
    case siteSend = "site-send"
    case siteSendToken = "site-send-token"
    case siteLongAmount = "site-long-amount"
    case siteCall = "site-call"
    case siteApprove = "site-approve"
    case siteUnlimited = "site-unlimited"
    case siteUnlimitedAcknowledged = "site-unlimited-acknowledged"
    case siteMessage = "site-message"
    case siteMessageUnreadable = "site-message-unreadable"
    case siteStopped = "site-stopped"
    case siteNext = "site-next"
    case siteBehind = "site-behind"
    case siteRefocused = "site-refocused"
    case siteSending = "site-sending"
    case siteSent = "site-sent"
    case siteSigning = "site-signing"
    case siteSigned = "site-signed"
    case siteFailure = "site-failure"
    case siteFailureMessage = "site-failure-message"
    case publishCost = "publish-cost"
    case publishCAD = "publish-cost-cad"
    case publishWaiting = "publish-cost-waiting"
    case publishFromDevice = "publish-from-device"
    case publishFromDeviceSafari = "publish-from-device-safari"
    case publishFromDeviceNoChromium = "publish-from-device-no-chromium"
    case ruleComparison = "rule-comparison"
    case ruleComparisonCAD = "rule-comparison-cad"
    case siteConnect = "site-connect"
    case siteTransaction = "site-transaction"
    case siteTransactionCAD = "site-transaction-cad"
    case sitePreview = "site-preview"
    case sitePreviewUnknown = "site-preview-unknown"
    case sitePreviewLong = "site-preview-long"
    case siteUnlimitedApproval = "site-unlimited-approval"
    case siteTypedPermit = "site-typed-permit"
    case sitePermit2 = "site-permit2"
    case sitePermitRemoval = "site-permit-removal"

    /// Set from inside the page, because the setting doesn't pass through the window's own panes.
    case increasedContrast = "increased-contrast"
    case chartHover = "chart-hover"
    case chartGapsHover = "chart-gaps-hover"
    /// Each plays something after the window appears, for `shot.sh --frames`. Hovering can't be done from here, so `motion-chart-scrub` moves what hovering moves.
    case motionChartDraw = "motion-chart-draw"
    case motionChartRange = "motion-chart-range"
    case motionChartMetric = "motion-chart-metric"
    case motionChartScrub = "motion-chart-scrub"
    case motionSend = "motion-send"
    case motionPurchase = "motion-purchase"
    case motionCostKnown = "motion-cost-known"
    case motionDetails = "motion-details"
    case motionWalletUndo = "motion-wallet-undo"

    var isAboutMotion: Bool { rawValue.hasPrefix("motion") }
    /// Someone who's never been here, and only in these scenes, so every other one looks as it would for anyone else.
    private var isAboutWelcome: Bool { rawValue.hasPrefix("main-welcome") || self == .resolveFirstQuestion }

    enum Chrome { case titled, hiddenTitleBar, none }

    var chrome: Chrome { spec.chrome }

    /// Rendering draws the inspector's text in the wrong color in dark mode, and leaves out the title bar the site window leaves room for, so these only come from a real window.
    var needsRealWindow: Bool { isAboutMotion || chrome == .hiddenTitleBar || rawValue.hasPrefix("main") || rawValue.hasPrefix("settings") || rawValue.hasPrefix("route") }

    /// Everything about each scene, on its one line. The compiler says when a new one's missing here, and `SceneSpec` has what's left out.
    var spec: SceneSpec {
        switch self {
        case .main: SceneSpec(screen: .main())
        case .mainUnreadableSaved: SceneSpec(screen: .main(), answers: .unreadable)
        case .mainUnreadableSavedNoWallet: SceneSpec(screen: .main(), hasWallet: false, answers: .unreadable)
        case .mainUnreadableSavedServerDown: SceneSpec(screen: .main(), feed: .notStartedFails, answers: .unreadable)
        case .invitePrompt: SceneSpec(screen: .invitePrompt, chrome: .none)
        case .invitePromptRefused: SceneSpec(screen: .invitePrompt, chrome: .none)
        case .mainWelcome: SceneSpec(screen: .main(), hasWallet: false)
        case .mainWelcomeSmallest: SceneSpec(screen: .main(MainWindow.minimumSize), hasWallet: false)
        case .mainWelcomeChecking: SceneSpec(screen: .main(), rulesAnswer: .never, hasWallet: false)
        case .mainWelcomeInvite: SceneSpec(screen: .main(), rulesAnswer: .needsInvite, hasWallet: false)
        case .mainWelcomeInviteRefused: SceneSpec(screen: .main(), rulesAnswer: .needsInvite, hasWallet: false, inviteWasRefused: true)
        case .mainWelcomeServerDown: SceneSpec(screen: .main(), rulesAnswer: .unreachable, hasWallet: false)
        case .mainWelcomeFirstRead: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), usesDemoWallet: false)
        case .mainWelcomeFirstReadStart: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .transfers), usesDemoWallet: false, readJustStarted: true)
        case .mainWelcomeFirstReadSmallest: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), usesDemoWallet: false)
        case .mainWelcomeFirstReadNoSteps: SceneSpec(screen: .main(), feed: .neverAnswers, usesDemoWallet: false)
        case .mainWelcomeFirstReadContract: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .transfers, isContract: true), usesDemoWallet: false)
        case .mainWelcomeFirstReadTooSlow: SceneSpec(screen: .main(), feed: .tooSlow, readProgress: FirstReadProgress(stage: .checking, transfers: 48210, isContract: false), usesDemoWallet: false)
        case .mainWelcomeFirstReadDown: SceneSpec(screen: .main(), feed: .serverDown, usesDemoWallet: false)
        case .mainWelcomeEmpty: SceneSpec(screen: .main(), feed: .empty, usesDemoWallet: false)
        case .mainWelcomeNumbers: SceneSpec(screen: .main())
        case .mainWelcomeNumbersContract: SceneSpec(screen: .welcomeWarningOfContract, feed: .firstRun, readProgress: FirstReadProgress(stage: .transfers, isContract: true), usesDemoWallet: false)
        case .mainWelcomeHelpFromTransactions: SceneSpec(screen: .welcomeFromHelp(.transactions), hasWallet: false)
        case .mainWelcomeHelpFromTaxReport: SceneSpec(screen: .welcomeFromHelp(.taxReport), hasWallet: false)
        case .resolveFirstQuestion: SceneSpec(screen: .resolve(height: 640), chrome: .none)
        case .welcomeAgain: SceneSpec(screen: .welcomeAgain, chrome: .none)
        case .mainHoldingsSearch: SceneSpec(screen: .main(), holdingsQuery: "e")
        case .mainHoldingsSearchSmall: SceneSpec(screen: .main(MainWindow.minimumSize), holdingsQuery: "e")
        case .mainHoldingsSearchNarrow: SceneSpec(screen: .main(.narrow), holdingsQuery: "e")
        case .mainHoldingsSearchNone: SceneSpec(screen: .main(), holdingsQuery: "nothing like this")
        case .mainTransactions: SceneSpec(screen: .main(), section: .transactions)
        case .mainAllYours: SceneSpec(screen: .main(), feed: .allYours, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .mainAllYoursBehind: SceneSpec(screen: .main(), feed: .allYoursBehind, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .mainAllYoursTransactions: SceneSpec(screen: .main(), feed: .allYours, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, section: .transactions, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .mainAllYoursDetails: SceneSpec(screen: .main(), feed: .allYours, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, opensDetails: .total(.pnl), answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .mainDetails: SceneSpec(screen: .main(), opensDetails: .aRealizedGain)
        case .mainDetailsProof: SceneSpec(screen: .mainOpeningFirstProof, opensDetails: .aRealizedGain)
        case .mainNarrow: SceneSpec(screen: .main(.narrow))
        case .mainSmall: SceneSpec(screen: .main(MainWindow.minimumSize))
        case .mainMedium: SceneSpec(screen: .main(.medium))
        case .mainHuge: SceneSpec(screen: .main(CGSize(width: 2200, height: 1300)))
        case .mainWidth660: SceneSpec(screen: .main(CGSize(width: 660, height: 760)))
        case .mainWidth760: SceneSpec(screen: .main(CGSize(width: 760, height: 760)))
        case .mainWidth860: SceneSpec(screen: .main(CGSize(width: 860, height: 760)))
        case .mainWidth960: SceneSpec(screen: .main(CGSize(width: 960, height: 760)))
        case .mainWidth1040: SceneSpec(screen: .main(CGSize(width: 1040, height: 760)))
        case .mainFirstRunSmall: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .firstRun, usesDemoWallet: false)
        case .mainTransactionsSmall: SceneSpec(screen: .main(MainWindow.minimumSize), section: .transactions)
        case .mainTransactionsSending: SceneSpec(screen: .main(), shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded, section: .transactions)
        case .mainTransactionsBusy: SceneSpec(screen: .main(), feed: .busy, section: .transactions)
        case .mainSpendingMoney: SceneSpec(screen: .main(.medium), shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .mainSpendingMoneySmall: SceneSpec(screen: .main(MainWindow.minimumSize), shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .mainSpendingMoneyServerDown: SceneSpec(screen: .main(.medium), feed: .serverDown, shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .mainTaxReport: SceneSpec(screen: .main(.medium), section: .taxReport)
        case .mainSecurity: SceneSpec(screen: .main(CGSize(width: 1120, height: 900)), shownWallet: HotWalletFixture.spending.lowercased, listsWallets: true, hotWallet: .funded, section: .security)
        case .security: SceneSpec(screen: .security, shownWallet: HotWalletFixture.spending.lowercased, listsWallets: true, hotWallet: .funded)
        case .securitySignedPermits: SceneSpec(screen: .security, shownWallet: HotWalletFixture.spending.lowercased, listsWallets: true, hotWallet: .signedPermits)
        case .securitySavings: SceneSpec(screen: .security, shownWallet: HotWalletFixture.savings.lowercased, listsWallets: true, hotWallet: .funded)
        case .securityDemo: SceneSpec(screen: .security, hotWallet: .funded)
        case .securityReading: SceneSpec(screen: .security, shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .securityStale: SceneSpec(screen: .security, shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .securityNoSpendingMoney: SceneSpec(screen: .security)
        case .revoke: SceneSpec(screen: .revoke, chrome: .none, hotWallet: .funded)
        case .revokeOne: SceneSpec(screen: .revoke, chrome: .none, hotWallet: .funded)
        case .mainTaxReportSmall: SceneSpec(screen: .main(MainWindow.minimumSize), section: .taxReport)
        case .taxReport: SceneSpec(screen: .taxReport, chrome: .none)
        case .taxReportAddedWallet: SceneSpec(screen: .taxReport, chrome: .none, shownWallet: Self.namedWallet)
        case .taxReportOtherWallets: SceneSpec(screen: .taxReportWithWallets, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, answers: .treasuryAndRecentAreMine)
        case .taxReportLeftOver: SceneSpec(screen: .taxReportWithWallets, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, answers: .treasuryAndRecentAreMine)
        case .mainNoWalletSmall: SceneSpec(screen: .main(MainWindow.minimumSize), hasWallet: false)
        case .mainNoWalletHasSpendingMoney: SceneSpec(screen: .main(), hasWallet: false, hotWallet: .funded)
        case .mainNoWalletNotProvisioned: SceneSpec(screen: .main(), hasWallet: false, hotWallet: .notProvisioned)
        case .mainNoWallet: SceneSpec(screen: .main(), hasWallet: false)
        case .mainNoWalletAfterDeleting: SceneSpec(screen: .main(), hasWallet: false, hotWallet: .deleted, hearsOfLinkedWallets: true)
        case .mainNoWalletSaved: SceneSpec(screen: .main(), hasWallet: false, listsWallets: true)
        case .mainNoWalletSavedSmall: SceneSpec(screen: .main(MainWindow.minimumSize), hasWallet: false, listsWallets: true)
        case .mainReading: SceneSpec(screen: .main(), feed: .neverAnswers)
        case .mainUpdating: SceneSpec(screen: .main(), feed: .updating)
        case .mainUpdatingNarrow: SceneSpec(screen: .main(.narrow), feed: .updating)
        case .mainUpdatingSmall: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .updating)
        case .mainUpdatingCAD: SceneSpec(screen: .main(), feed: .updating, currency: .CAD)
        case .mainTransactionsUpdating: SceneSpec(screen: .main(), feed: .updating, section: .transactions)
        case .mainServerDown: SceneSpec(screen: .main(), feed: .serverDown)
        case .mainPricesDown: SceneSpec(screen: .main(), feed: .pricesDown)
        case .mainPricesStop: SceneSpec(screen: .main(), feed: .pricesStop)
        case .mainTooSlow: SceneSpec(screen: .main(), feed: .tooSlow)
        case .mainRetrying: SceneSpec(screen: .main(), feed: .retrying)
        case .mainRetryingNumbers: SceneSpec(screen: .main(), feed: .retryingWithNumbers, problemIsLong: true)
        case .mainNotStartedFailing: SceneSpec(screen: .main(), feed: .notStartedFails, usesDemoWallet: false)
        case .mainReadingStart: SceneSpec(screen: .main(), feed: .neverAnswers, readJustStarted: true)
        case .mainLaterRead: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadSmallest: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadNoSteps: SceneSpec(screen: .main(), feed: .neverAnswers, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadContract: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .transfers, isContract: true), shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadTooSlow: SceneSpec(screen: .main(), feed: .tooSlow, readProgress: FirstReadProgress(stage: .checking, transfers: 48210, isContract: false), shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadTransactions: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false, section: .transactions)
        case .mainLaterReadSpendingMoney: SceneSpec(screen: .main(), feed: .neverAnswers, readProgress: FirstReadProgress(stage: .prices, transfers: 1284, isContract: false), shownWallet: HotWalletFixture.spending.lowercased, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false)
        case .mainLaterReadAllYours: SceneSpec(screen: .main(), feed: .neverAnswers, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, readsHotWalletFirst: false, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .mainNotUpdating: SceneSpec(screen: .main(), feed: .stopsAnswering)
        case .mainNotUpdatingSmall: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .stopsAnswering)
        case .mainLinkedFailed: SceneSpec(screen: .main(), feed: .linkedFails)
        case .mainEmpty: SceneSpec(screen: .main(), feed: .empty, usesDemoWallet: false)
        case .mainEmptySmallest: SceneSpec(screen: .main(.smallest), feed: .empty, usesDemoWallet: false)
        case .mainSmallest: SceneSpec(screen: .main(.smallest))
        case .mainSmallestEnd: SceneSpec(screen: .mainAtItsEnd)
        case .mainEmptyNotice: SceneSpec(screen: .main(), feed: .emptyReadingLinked, usesDemoWallet: false)
        case .mainFirstRun: SceneSpec(screen: .main(), feed: .firstRun, usesDemoWallet: false)
        case .mainFirstRunSmallest: SceneSpec(screen: .main(.smallest), feed: .firstRun, usesDemoWallet: false)
        case .mainFirstRunDetails: SceneSpec(screen: .main(), feed: .firstRun, usesDemoWallet: false, opensDetails: .asset("ETH", .onchain))
        case .mainNotStarted: SceneSpec(screen: .main(), feed: .notStarted, usesDemoWallet: false)
        case .holdComparison: SceneSpec(screen: .holdComparison, chrome: .none)
        case .mainHoldDetails: SceneSpec(screen: .main(), opensDetails: .holdComparison)
        case .mainCostWithheld: SceneSpec(screen: .main(), feed: .costWithheld)
        case .mainSmallAmounts: SceneSpec(screen: .main(), feed: .smallAmounts)
        case .mainSmallAmountsNarrow: SceneSpec(screen: .main(.narrow), feed: .smallAmounts)
        case .mainLongHistory: SceneSpec(screen: .main(), feed: .longHistory)
        case .mainChartGaps: SceneSpec(screen: .main(), feed: .chartGaps)
        case .mainChartGapsSmall: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .chartGaps)
        case .mainChartGapsNarrow: SceneSpec(screen: .main(.narrow), feed: .chartGaps)
        case .mainChartWeek: SceneSpec(screen: .main(), feed: .longHistory, chartRange: .week)
        case .mainCAD: SceneSpec(screen: .main(), currency: .CAD)
        case .mainTransactionsCAD: SceneSpec(screen: .main(), currency: .CAD, section: .transactions)
        case .mainDetailsCAD: SceneSpec(screen: .main(), currency: .CAD, opensDetails: .aRealizedGain)
        case .resolve: SceneSpec(screen: .resolve(), chrome: .none)
        case .resolveFinished: SceneSpec(screen: .resolve(), feed: .allAnswered)
        case .resolveNothingLeft: SceneSpec(screen: .resolve(), feed: .nothingLeft)
        case .resolveCostWithheld: SceneSpec(screen: .resolve(), chrome: .none, feed: .costWithheld)
        case .resolvePublishFromDevice: SceneSpec(screen: .resolvePublishingFromDevice, chrome: .none, feed: .costOnSavings)
        case .resolveAnsweredWallet: SceneSpec(screen: .resolve(), chrome: .none, feed: .answeredWallet, answers: .emptyWalletIsMine)
        case .resolveAllSkipped: SceneSpec(screen: .resolveSkipping(.everything))
        case .resolveKnownExchange: SceneSpec(screen: .resolveSkipping(.toKnownExchange))
        case .walletSwitcher: SceneSpec(screen: .walletSwitcher, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded)
        case .walletSwitcherAllYours: SceneSpec(screen: .walletSwitcher, chrome: .none, feed: .allYours, shownWallet: WalletAddress.allYours, listsWallets: true, hotWallet: .funded, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .walletSwitcherFirstRun: SceneSpec(screen: .walletSwitcher, chrome: .none, hasWallet: false)
        case .walletSwitcherRenaming: SceneSpec(screen: .walletSwitcher, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded)
        case .walletSwitcherProblem: SceneSpec(screen: .walletSwitcher, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded)
        case .walletSwitcherLong: SceneSpec(screen: .walletSwitcher, chrome: .none, shownWallet: Self.manyWallets.last?.address, listsWallets: true, hotWallet: .funded, savedWallets: .many)
        case .walletSwitcherLongSmallDisplay: SceneSpec(screen: .walletSwitcher, chrome: .none, shownWallet: Self.manyWallets[9].address, listsWallets: true, hotWallet: .funded, savedWallets: .many)
        case .walletSwitcherAllYoursTwoWallets: SceneSpec(screen: .walletSwitcher, chrome: .none, feed: .allYours, shownWallet: WalletAddress.allYours, hotWallet: .funded, hearsOfLinkedWallets: true)
        case .walletSwitcherNote: SceneSpec(screen: .walletSwitcher, chrome: .none)
        case .walletSwitcherNewKey: SceneSpec(screen: .walletSwitcher, chrome: .none, listsWallets: true, hotWallet: .replacingKeyStuck, hearsOfLinkedWallets: true)
        case .spendingMoneySetupSheet: SceneSpec(screen: .spendingMoneySetupSheet, chrome: .none)
        case .mainShowingSpendingMoney: SceneSpec(screen: .main(), feed: .firstRun, shownWallet: HotWalletFixture.spending.lowercased, listsWallets: true, hotWallet: .funded)
        case .mainSavings: SceneSpec(screen: .main(), feed: .firstRun, shownWallet: HotWalletFixture.savings.lowercased, listsWallets: true, hotWallet: .funded)
        case .mainEmptySpendingMoney: SceneSpec(screen: .main(), feed: .empty, shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .noSavings)
        case .mainEmptySpendingMoneySmallest: SceneSpec(screen: .main(.smallest), feed: .empty, shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .noSavings)
        case .mainEmptySavings: SceneSpec(screen: .main(), feed: .empty, shownWallet: HotWalletFixture.savings.lowercased, hotWallet: .funded)
        case .mainWatching: SceneSpec(screen: .main(), feed: .firstRun, shownWallet: Self.recentWallet, listsWallets: true, hotWallet: .funded)
        case .mainWatchingNamed: SceneSpec(screen: .main(), feed: .firstRun, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded)
        case .mainWatchingNamedSmallest: SceneSpec(screen: .main(MainWindow.minimumSize), feed: .firstRun, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded, savedWallets: .longName)
        case .popover: SceneSpec(screen: .popover, chrome: .none)
        case .popoverNoWallet: SceneSpec(screen: .popover, chrome: .none, hasWallet: false)
        case .popoverNotUpdating: SceneSpec(screen: .popover, chrome: .none, feed: .stopsAnswering)
        case .popoverNotStarted: SceneSpec(screen: .popover, chrome: .none, feed: .notStarted, usesDemoWallet: false)
        case .popoverFirstRun: SceneSpec(screen: .popover, chrome: .none, feed: .firstRun, usesDemoWallet: false)
        case .popoverLongName: SceneSpec(screen: .popover, chrome: .none, feed: .firstRun, shownWallet: Self.namedWallet, listsWallets: true, savedWallets: .longName)
        case .popoverLongNameReading: SceneSpec(screen: .popover, chrome: .none, feed: .neverAnswers, shownWallet: Self.namedWallet, listsWallets: true, savedWallets: .longName)
        case .popoverUnreadableSaved: SceneSpec(screen: .popover, chrome: .none, answers: .unreadable)
        case .popoverAllYoursBehind: SceneSpec(screen: .popover, feed: .allYoursBehind, shownWallet: WalletAddress.allYours, listsWallets: true, answers: .treasuryIsMine, hearsOfLinkedWallets: true)
        case .popoverCAD: SceneSpec(screen: .popover, chrome: .none, currency: .CAD)
        case .popoverHotWallet: SceneSpec(screen: .popover, chrome: .none, hotWallet: .funded)
        case .popoverHotWalletOverCap: SceneSpec(screen: .popover, chrome: .none, hotWallet: .overCap)
        case .popoverHotWalletAlarm: SceneSpec(screen: .popover, chrome: .none, hotWallet: .alarm)
        case .popoverHotWalletCAD: SceneSpec(screen: .popover, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .popoverReading: SceneSpec(screen: .popover, chrome: .none, feed: .neverAnswers)
        case .popoverUpdating: SceneSpec(screen: .popover, chrome: .none, feed: .updating)
        case .popoverServerDown: SceneSpec(screen: .popover, chrome: .none, feed: .serverDown)
        case .popoverPricesDown: SceneSpec(screen: .popover, chrome: .none, feed: .pricesDown)
        case .popoverRetrying: SceneSpec(screen: .popover, chrome: .none, feed: .retryingWithNumbers)
        case .popoverEmpty: SceneSpec(screen: .popover, chrome: .none, feed: .empty, usesDemoWallet: false)
        case .popoverHotWalletNoSavings: SceneSpec(screen: .popover, chrome: .none, hotWallet: .noSavings)
        case .popoverHotWalletKeyMissing: SceneSpec(screen: .popover, chrome: .none, hotWallet: .keyMissing)
        case .popoverNotProvisioned: SceneSpec(screen: .popover, chrome: .none, hotWallet: .notProvisioned)
        case .popoverMissingPrice: SceneSpec(screen: .popover, chrome: .none, feed: .missingPrice)
        case .mainMissingPrice: SceneSpec(screen: .main(), feed: .missingPrice)
        case .popoverUnreadBalance: SceneSpec(screen: .popover, chrome: .none, feed: .unreadBalance)
        case .routeSend: SceneSpec(screen: .route(.send), hotWallet: .funded)
        case .routeSendOpen: SceneSpec(screen: .route(.send), hotWallet: .funded)
        case .routeTopUp: SceneSpec(screen: .route(.topUp), hotWallet: .funded)
        case .routeTopUpOpen: SceneSpec(screen: .route(.topUp), hotWallet: .funded)
        case .routeBuy: SceneSpec(screen: .route(.buy), hotWallet: .funded)
        case .routeBuyOpen: SceneSpec(screen: .route(.buy), hotWallet: .funded)
        case .routeReceive: SceneSpec(screen: .route(.receive), hotWallet: .funded)
        case .routeReceiveOpen: SceneSpec(screen: .route(.receive), hotWallet: .funded)
        case .routeAddSavings: SceneSpec(screen: .route(.addSavings), hotWallet: .funded)
        case .routeExport: SceneSpec(screen: .route(.export))
        case .routeExportOpen: SceneSpec(screen: .route(.export))
        case .routeFind: SceneSpec(screen: .route(.find))
        case .routeFindOpen: SceneSpec(screen: .route(.find))
        case .routeTopUpCancelled: SceneSpec(screen: .route(.topUpCancelled))
        case .routeHoldings: SceneSpec(screen: .route(.holdings))
        case .routeHoldingsOpen: SceneSpec(screen: .route(.holdings))
        case .routeAddWallet: SceneSpec(screen: .route(.addWallet), hasWallet: false)
        case .routeAddWalletOpen: SceneSpec(screen: .route(.addWallet), hasWallet: false)
        case .routeDetails: SceneSpec(screen: .route(.details))
        case .routeDetailsOpen: SceneSpec(screen: .route(.details))
        case .routeAnswer: SceneSpec(screen: .route(.answer))
        case .routeAnswerOpen: SceneSpec(screen: .route(.answer))
        case .routeRemoveFromSavingsOpen: SceneSpec(screen: .route(.removeFromSavings), shownWallet: HotWalletFixture.spending.lowercased, hotWallet: .funded)
        case .menuBarLabel: SceneSpec(screen: .menuBarLabel, chrome: .none)
        case .settings: SceneSpec(screen: .settings)
        case .settingsRules: SceneSpec(screen: .settings, hasTwoRules: true)
        case .settingsSmallDisplay: SceneSpec(screen: .settings, hasTwoRules: true)
        case .settingsServer: SceneSpec(screen: .settings)
        case .settingsServerProblem: SceneSpec(screen: .settings)
        case .settingsCAD: SceneSpec(screen: .settings, currency: .CAD)
        case .settingsAnswers: SceneSpec(screen: .settings, listsWallets: true, answers: .everyKind)
        case .settingsAnswersEmpty: SceneSpec(screen: .settings)
        case .settingsNotificationsOff: SceneSpec(screen: .settings)
        case .settingsLoginItemOff: SceneSpec(screen: .settings)
        case .hotWalletSetup: SceneSpec(screen: .spendingMoneySetup)
        case .hotWalletNotProvisioned: SceneSpec(screen: .spendingMoneySetup, hotWallet: .notProvisioned)
        case .hotWalletUnreadable: SceneSpec(screen: .spendingMoneySetup, hotWallet: .unreadableRecords)
        case .hotWallet: SceneSpec(screen: .spendingMoney, hotWallet: .funded)
        case .hotWalletCAD: SceneSpec(screen: .spendingMoney, currency: .CAD, hotWallet: .funded)
        case .hotWalletNetworkProblem: SceneSpec(screen: .spendingMoney, hotWallet: .funded)
        case .hotWalletNoRate: SceneSpec(screen: .spendingMoney, currency: .CAD, hasNoRate: true, hotWallet: .funded)
        case .hotWalletTwoSavings: SceneSpec(screen: .spendingMoney, hotWallet: .twoSavings)
        case .hotWalletNoSavings: SceneSpec(screen: .spendingMoney, hotWallet: .noSavings)
        case .hotWalletNoSavingsCAD: SceneSpec(screen: .spendingMoney, currency: .CAD, hotWallet: .noSavings)
        case .hotWalletNoPrice: SceneSpec(screen: .spendingMoney, hotWallet: .noPrice)
        case .hotWalletNothingToSweep: SceneSpec(screen: .spendingMoney, hotWallet: .nothingToSweep)
        case .hotWalletOverCap: SceneSpec(screen: .spendingMoney, hotWallet: .overCap)
        case .hotWalletOverCapCAD: SceneSpec(screen: .spendingMoney, currency: .CAD, hotWallet: .overCap)
        case .hotWalletOverCapNoSavings: SceneSpec(screen: .spendingMoney, hotWallet: .overCapNoSavings)
        case .hotWalletKeyMissing: SceneSpec(screen: .spendingMoney, hotWallet: .keyMissing)
        case .hotWalletAlarm: SceneSpec(screen: .spendingMoney, hotWallet: .alarm)
        case .hotWalletReplacingKey: SceneSpec(screen: .spendingMoney, hotWallet: .replacingKey)
        case .hotWalletReplacingKeyStuck: SceneSpec(screen: .spendingMoney, hotWallet: .replacingKeyStuck)
        case .hotWalletReplacingKeyMissing: SceneSpec(screen: .spendingMoney, hotWallet: .replacingKeyMissing)
        case .hotWalletSites: SceneSpec(screen: .spendingMoney, hotWallet: .usedBySites)
        case .hotWalletAddSavings: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .hotWalletAddSavingsFilled: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .hotWalletAddSavingsFromDevice: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerPlugIn: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerPlugInTrouble: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerApp: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerQuit: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerQuitStillOpen: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerBrowser: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerBrowserSafari: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerBrowserNone: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerWaiting: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsLedgerPaste: SceneSpec(screen: .addSavings, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .addSavingsLedgerCheckTrouble: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneUnlock: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneReceive: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneReceiveTrouble: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneScan: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneScanDenied: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneScanNoCamera: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneType: SceneSpec(screen: .addSavings, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .addSavingsKeystoneCheck: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsKeystoneWalked: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded)
        case .addSavingsOtherPaste: SceneSpec(screen: .addSavings, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .addSavingsPicked: SceneSpec(screen: .addSavings, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .addSavingsPickedCheck: SceneSpec(screen: .addSavings, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .addSavingsCheckStartsSweeps: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .overCapNoSavings)
        case .addSavingsCheckBalanceUnread: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .noSavings, readsHotWalletFirst: false)
        case .addSavingsCheckFirstWallet: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .noSavings)
        case .addSavingsFinished: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .noSavings, confirmsAddingSavings: true)
        case .addSavingsFinishedSweeping: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .overCapNoSavings, confirmsAddingSavings: true)
        case .addSavingsFinishedElsewhere: SceneSpec(screen: .addSavings, chrome: .none, hotWallet: .funded, confirmsAddingSavings: true)
        case .hotWalletPurchases: SceneSpec(screen: .spendingMoneyPurchases, hotWallet: .funded, purchases: .all)
        case .hotWalletPurchasesCAD: SceneSpec(screen: .spendingMoneyPurchases, currency: .CAD, hotWallet: .funded, purchases: .inCAD)
        case .hotWalletPurchasesCantCheck: SceneSpec(screen: .spendingMoneyPurchases, hotWallet: .funded, purchases: .lastThree)
        case .hotWalletPurchaseShown: SceneSpec(screen: .spendingMoneyPurchases, hotWallet: .funded, purchases: .all)
        case .hotWalletRecordShown: SceneSpec(screen: .spendingMoney, hotWallet: .funded)
        case .hotWalletReplacedKeyShown: SceneSpec(screen: .spendingMoneyPurchases, hotWallet: .replaced, purchases: .all)
        case .receive: SceneSpec(screen: .receive, chrome: .none, hotWallet: .funded)
        case .receiveNoSavings: SceneSpec(screen: .receive, chrome: .none, hotWallet: .noSavings)
        case .receiveCAD: SceneSpec(screen: .receive, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .receiveNotSetUp: SceneSpec(screen: .receive, chrome: .none)
        case .receiveAlarm: SceneSpec(screen: .receive, chrome: .none, hotWallet: .alarm)
        case .buy: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyCAD: SceneSpec(screen: .buy, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .buyCADAboveRoom: SceneSpec(screen: .buy, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .buyCADTooLittle: SceneSpec(screen: .buy, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .buyNoRate: SceneSpec(screen: .buy, chrome: .none, currency: .CAD, hasNoRate: true, hotWallet: .funded)
        case .buyAboveRoom: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyLarge: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyAtCap: SceneSpec(screen: .buy, chrome: .none, hotWallet: .overCap)
        case .buyUSDCNoGas: SceneSpec(screen: .buy, chrome: .none, hotWallet: .noGas)
        case .buyNoWallet: SceneSpec(screen: .buy, chrome: .none)
        case .buyTooLittle: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyNegative: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyNoSavings: SceneSpec(screen: .buy, chrome: .none, hotWallet: .noSavings)
        case .buyNoSavingsAboveRoom: SceneSpec(screen: .buy, chrome: .none, hotWallet: .noSavings)
        case .buyNoSavingsAtCap: SceneSpec(screen: .buy, chrome: .none, hotWallet: .overCapNoSavings)
        case .buyNoSavingsCAD: SceneSpec(screen: .buy, chrome: .none, currency: .CAD, hotWallet: .noSavings)
        case .buyFirstRead: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded, readsHotWalletFirst: false)
        case .buyReading: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded, readsHotWalletFirst: false)
        case .buyNoSavingsFirstRead: SceneSpec(screen: .buy, chrome: .none, hotWallet: .noSavings, readsHotWalletFirst: false)
        case .buyNoSavingsAtCapFirstRead: SceneSpec(screen: .buy, chrome: .none, hotWallet: .overCapNoSavings, readsHotWalletFirst: false)
        case .buyNotSetUp: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyCantReachProvider: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .buyRefused: SceneSpec(screen: .buy, chrome: .none, hotWallet: .funded)
        case .hotWalletTopUp: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .funded)
        case .hotWalletTopUpFirstRead: SceneSpec(screen: .topUp(.readsAfterItOpens), chrome: .none, hotWallet: .funded, readsHotWalletFirst: false)
        case .hotWalletTopUpReading: SceneSpec(screen: .topUp(.neverReads), hotWallet: .funded, readsHotWalletFirst: false)
        case .hotWalletTopUpReadingSafari: SceneSpec(screen: .topUp(.neverReads), hotWallet: .funded, browsers: .safariAndChrome, readsHotWalletFirst: false)
        case .hotWalletTopUpNoGas: SceneSpec(screen: .topUp(), hotWallet: .noGas)
        case .hotWalletTopUpOneDollar: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .nearCap)
        case .hotWalletTopUpAtCap: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .overCap)
        case .hotWalletTopUpNoSavings: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .noSavings)
        case .hotWalletTopUpNoSavingsAtCap: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .overCapNoSavings)
        case .hotWalletTopUpCAD: SceneSpec(screen: .topUp(), chrome: .none, currency: .CAD, hotWallet: .funded)
        case .hotWalletTopUpSafari: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .funded, browsers: .safariAndChrome)
        case .hotWalletTopUpNoChromium: SceneSpec(screen: .topUp(), chrome: .none, hotWallet: .funded, browsers: .safariOnly)
        case .send: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendCAD: SceneSpec(screen: .send, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .sendKnown: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded, answers: .recipientIsSomeoneElse)
        case .sendPicking: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendSearching: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendPicked: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendTypo: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendShortened: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendTyping: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendWaiting: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendReviewing: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendWhichUnits, .sendWhichUnitsReviewing: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendGoing: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendSent: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendStopped: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendMoney: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sendMoneyCAD: SceneSpec(screen: .send, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .sendLookalike: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendLookalikeChecked: SceneSpec(screen: .send, chrome: .none, listsWallets: true, hotWallet: .funded)
        case .sendRefused: SceneSpec(screen: .send, chrome: .none, hotWallet: .funded)
        case .sweep: SceneSpec(screen: .sweep, chrome: .none, hotWallet: .funded)
        case .sweepCAD: SceneSpec(screen: .sweep, chrome: .none, currency: .CAD, hotWallet: .funded)
        case .sweepStopped: SceneSpec(screen: .sweepStopped, chrome: .none, hotWallet: .funded)
        case .siteSend: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteSendToken: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteLongAmount: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteCall: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteApprove: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteUnlimited: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteUnlimitedAcknowledged: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteMessage: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteMessageUnreadable: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteStopped: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteNext: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteBehind: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteRefocused: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteSending: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteSent: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteSigning: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteSigned: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteFailure: SceneSpec(screen: .siteScreen, chrome: .none)
        case .siteFailureMessage: SceneSpec(screen: .siteScreen, chrome: .none)
        case .publishCost: SceneSpec(screen: .publishCost, chrome: .none)
        case .publishCAD: SceneSpec(screen: .publishCost, chrome: .none, currency: .CAD)
        case .publishWaiting: SceneSpec(screen: .publishCost, chrome: .none)
        case .publishFromDevice: SceneSpec(screen: .publishFromDevice, chrome: .none)
        case .publishFromDeviceSafari: SceneSpec(screen: .publishFromDevice, chrome: .none, browsers: .safariAndChrome)
        case .publishFromDeviceNoChromium: SceneSpec(screen: .publishFromDevice, chrome: .none, browsers: .safariOnly)
        case .ruleComparison: SceneSpec(screen: .ruleComparison, chrome: .none)
        case .ruleComparisonCAD: SceneSpec(screen: .ruleComparison, chrome: .none, currency: .CAD)
        case .siteConnect: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .funded)
        case .siteTransaction: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .siteTransactionCAD: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, currency: .CAD, hotWallet: .connectedToSite)
        case .sitePreview: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .sitePreviewUnknown: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .sitePreviewLong: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .siteUnlimitedApproval: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .siteTypedPermit: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .sitePermit2: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .sitePermitRemoval: SceneSpec(screen: .siteWindow, chrome: .hiddenTitleBar, hotWallet: .connectedToSite)
        case .increasedContrast: SceneSpec(screen: .contrast)
        case .chartHover: SceneSpec(screen: .chart(.scrubbed(6)), chrome: .none)
        case .chartGapsHover: SceneSpec(screen: .chart(.scrubbedToAGap), chrome: .none, feed: .chartGaps)
        case .motionChartDraw: SceneSpec(screen: .chart(.drawing), chrome: .none)
        case .motionChartRange: SceneSpec(screen: .chart(.changingRange), chrome: .none, feed: .longHistory)
        case .motionChartMetric: SceneSpec(screen: .chart(.changingMetric), chrome: .none)
        case .motionChartScrub: SceneSpec(screen: .chart(.scrubbing), chrome: .none)
        case .motionSend: SceneSpec(screen: .motionSend, chrome: .none)
        case .motionPurchase: SceneSpec(screen: .motionPurchase, chrome: .none)
        case .motionCostKnown: SceneSpec(screen: .motionCostKnown, feed: .costBecomesKnown)
        case .motionDetails: SceneSpec(screen: .motionDetails)
        case .motionWalletUndo: SceneSpec(screen: .motionWalletUndo, chrome: .none, shownWallet: Self.namedWallet, listsWallets: true, hotWallet: .funded)
        }
    }

    /// Says what's there, and fails if a scene tries to open one.
    private func browsers(defaultBrowser: InstalledBrowser, installed: [InstalledBrowser]) -> DeviceBrowsers {
        DeviceBrowsers(choice: { LedgerBrowserChoice(defaultBrowser: defaultBrowser, installed: installed) }, open: { _, _ in TestMode.fail("A scene tried to open a browser.") })
    }

    private static let chrome = InstalledBrowser(bundleID: "com.google.Chrome", name: "Google Chrome", url: URL(filePath: "/Applications/Google Chrome.app"))
    private static let safari = InstalledBrowser(bundleID: "com.apple.Safari", name: "Safari", url: URL(filePath: "/Applications/Safari.app"))

    private var deviceBrowsers: DeviceBrowsers {
        switch spec.browsers {
        case .chromeOnly: browsers(defaultBrowser: Self.chrome, installed: [Self.chrome])
        case .safariAndChrome: browsers(defaultBrowser: Self.safari, installed: [Self.safari, Self.chrome])
        case .safariOnly: browsers(defaultBrowser: Self.safari, installed: [Self.safari])
        }
    }

    /// A read that's been going a while, so these show how a long one looks. The store's clock is only behind for scenes that never finish a read.
    private var readStartedAgo: TimeInterval {
        guard TestMode.live == nil, !spec.readJustStarted else { return 0 }
        return switch spec.feed {
        case .neverAnswers, .updating, .retrying, .retryingWithNumbers: 72
        default: 0
        }
    }

    private func registeredDefaults() -> [String: Any] {
        let spec = spec
        var registered: [String: Any] = ["currency": (TestMode.liveCurrency ?? spec.currency).rawValue]
        if spec.hasWallet { registered["wallet"] = TestMode.live?.wallet ?? spec.shownWallet ?? (spec.usesDemoWallet ? WalletAddress.demo : Self.emptyWallet) }
        if spec.listsWallets {
            // The longest name anyone's likely to give, where there's the least room for it.
            let wallets = switch spec.savedWallets {
            case .three: Self.savedWallets
            case .longName: [SavedWallet(address: Self.namedWallet, name: "The Long-Term Family Treasury Wallet on Base", lastSeen: .distantPast)]
            case .many: Self.manyWallets
            }
            registered["savedWallets"] = try? JSONEncoder().encode(wallets)
        }
        switch spec.answers {
        case .none: break
        case .recipientIsSomeoneElse: registered["answers"] = try? JSONEncoder().encode(Book().answering(Self.recipient, .someoneElse, focus: nil))
        case .everyKind:
            registered["answers"] = try? JSONEncoder().encode(Self.answers)
            registered["answerDetails"] = try? JSONEncoder().encode(Self.answerDetails)
        case .emptyWalletIsMine: registered["answers"] = try? JSONEncoder().encode(Book().answering(Self.emptyWallet, .mine, focus: nil))
        // Treasury is the user's too, and it's the wallet All Yours is still reading.
        case .treasuryIsMine: registered["answers"] = try? JSONEncoder().encode(Book().answering(Self.namedWallet, .mine, focus: nil))
        // The tax report covers both together, without anyone typing them in.
        case .treasuryAndRecentAreMine: registered["answers"] = try? JSONEncoder().encode(Book().answering(Self.recentWallet, .mine, focus: Self.namedWallet).answering("0x0000000000000000000000000000000000c0ffee", .mine, focus: nil))
        // Answers from a version that knows a currency this one doesn't.
        case .unreadable: registered["answers"] = Data(#"{"senders":{},"costs":{"a:b":{"micros":"1","currency":"NEW"}},"withdrawals":[]}"#.utf8)
        }
        switch spec.purchases {
        case .none: break
        case .all: registered["purchases"] = try? JSONEncoder().encode(Self.purchases())
        case .inCAD: registered["purchases"] = try? JSONEncoder().encode(Self.purchases(inCAD: true))
        case .lastThree: registered["purchases"] = try? JSONEncoder().encode(Array(Self.purchases().suffix(3)))
        }
        return registered
    }

    func make() -> TestScreen {
        let spec = spec
        // Registered values stay in memory, so this never reads or writes anyone's settings, as long as nothing here changes one.
        // Its own name, so what another branch saved under the old one can't hide what's registered here.
        let defaults = SceneDefaults(suiteName: "com.benface.pricetag.mac.test-mode.scenes")!
        defaults.register(defaults: registeredDefaults())
        if spec.inviteWasRefused { defaults.register(defaults: ["serverInvites": [PortfolioStore.origin(of: PortfolioStore.defaultServerURL): "not-this-one"]]) }
        let source: any PortfolioSource = TestMode.live.map { PricetagClient(serverURL: $0.server) } ?? FixtureSource(feed: spec.feed, hasRate: !spec.hasNoRate, rules: spec.hasTwoRules ? Self.twoRules : [], rulesAnswer: spec.rulesAnswer, progress: spec.readProgress, progressDelay: self == .mainWelcomeNumbersContract ? .seconds(1) : .zero)
        let readStarted = readStartedAgo
        let store = PortfolioStore(defaults: defaults, makeSource: { _ in source }, now: { Date().addingTimeInterval(-readStarted) }, reachableDelay: TestMode.live == nil ? .milliseconds(50) : .seconds(30), unreachableDelay: .seconds(30), longProblem: spec.problemIsLong ? .seconds(60) : .zero)
        store.start()
        let hotWallet = spec.hotWallet.make(source: source, costMethod: { store.method }, moneyDisplay: { store.moneyDisplay }, confirmsAddingSavings: spec.confirmsAddingSavings)
        if !spec.hasWallet, TestMode.live == nil, store.address != nil { TestMode.fail("This scene should start with no wallet, but it's showing \(store.address ?? "").") }
        // Never started, so it reads nothing, and only what these scenes registered is there.
        let purchases = PurchaseTracker(store: store, defaults: defaults, matchOf: { Self.purchaseMatches[$0] })
        let hotWalletHasRead = ReadOnce()
        let readHotWallet: @MainActor () async -> Void = {
            await store.readRate()
            await hotWallet.tick()
            await hotWallet.readHistory()
            hotWalletHasRead.isDone = true
        }
        if spec.readsHotWalletFirst {
            Task { await readHotWallet() }
            let deadline = Date.now.addingTimeInterval(TestMode.readyTimeout)
            while !hotWalletHasRead.isDone {
                guard Date.now < deadline else { TestMode.fail("This scene's hot wallet never finished reading.") }
                RunLoop.main.run(until: .now.addingTimeInterval(0.01))
            }
        }
        if spec.hearsOfLinkedWallets { store.setLinkedWallets(hotWallet.linkedWallets) }
        let navigation = Navigation(store: store, hotWallet: hotWallet)
        navigation.chartRange = spec.chartRange
        navigation.holdingsQuery = spec.holdingsQuery
        navigation.chartMetric = TestMode.chartMetric
        navigation.section = spec.section
        if let opened = spec.opensDetails { DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { navigation.target = opened } }
        let isReady = Self.isReady(feed: spec.feed, store: store)
        let parts = SceneParts(defaults: defaults, store: store, hotWallet: hotWallet, navigation: navigation, purchases: purchases, firstRun: isAboutWelcome ? FirstRun(defaults: defaults, isExistingInstall: false) : .finished, isReady: isReady, hotWalletHasRead: hotWalletHasRead, readHotWallet: readHotWallet)
        return screen(spec.screen, parts)
    }

    private static func isReady(feed: FixtureSource.Feed, store: PortfolioStore) -> () -> Bool {
        {
            if TestMode.live != nil { return store.feed == .noWallet || store.portfolio != nil }
            return switch feed {
            case .demo, .allYours, .allYoursBehind, .costBecomesKnown, .missingPrice, .unreadBalance, .linkedFails, .costWithheld, .costOnSavings, .smallAmounts, .longHistory, .chartGaps, .busy, .answeredWallet, .allAnswered, .nothingLeft, .empty, .emptyReadingLinked, .notStarted, .firstRun: store.feed == .noWallet || store.portfolio != nil
            case .updating: store.portfolio != nil
            case .neverAnswers: true
            case .serverDown: store.feed == .serverUnreachable
            case .pricesDown: store.feed.isStale
            case .pricesStop: store.feed.isStale && store.portfolio != nil
            case .tooSlow: store.feed == .tooSlow
            case .retrying: store.feed.isStale && store.readingSince != nil
            case .retryingWithNumbers: store.feed.isStale && store.readingSince != nil && store.portfolio != nil
            case .notStartedFails: store.feed.isStale && store.portfolio != nil
            case .stopsAnswering: store.feed == .serverUnreachable && store.portfolio != nil
            }
        }
    }

    private func screen(_ screen: SceneSpec.Screen, _ parts: SceneParts) -> TestScreen {
        let store = parts.store
        let hotWallet = parts.hotWallet
        let navigation = parts.navigation
        let purchases = parts.purchases
        let firstRun = parts.firstRun
        let isReady = parts.isReady
        let currency = spec.currency
        switch screen {
        case .main(let size):
            return TestScreen(view: AnyView(parts.mainWindow()), size: size, isReady: isReady)
        case .welcomeFromHelp(let section):
            let appeared = Date.now
            firstRun.skip()
            navigation.section = section
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { navigation.showWelcome(firstRun) }
            // Long after Help, so a welcome that closes itself again fails this instead of being caught on its way out.
            return TestScreen(view: AnyView(parts.mainWindow()), size: .regular, isReady: { Date.now > appeared.addingTimeInterval(1) && firstRun.isWelcoming && navigation.section == .overview })
        case .welcomeWarningOfContract:
            return TestScreen(view: AnyView(parts.mainWindow()), size: .regular, isReady: { isReady() && firstRun.warnsOfContract(store.address) })
        case .mainOpeningFirstProof:
            return TestScreen(view: AnyView(parts.mainWindow().environment(\.opensFirstProof, true)), size: .regular, isReady: isReady)
        case .mainAtItsEnd:
            // Starts at the end of the page, because a screenshot can't scroll to it.
            return TestScreen(view: AnyView(parts.mainWindow().defaultScrollAnchor(.bottom)), size: .smallest, isReady: isReady)
        case .welcomeAgain:
            return TestScreen(view: AnyView(WelcomeAgain()), isReady: isReady)
        case .chart(let play):
            return chartScreen(play, parts)
        case .motionSend:
            let cue = MotionCue()
            return TestScreen(view: AnyView(MotionSendScene(cue: cue)), isReady: { true }, play: {
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    cue.stage = .onItsWay
                    try? await Task.sleep(for: .seconds(0.8))
                    cue.stage = .finished("Sent")
                }
            })
        case .motionPurchase:
            let cue = MotionCue()
            return TestScreen(view: AnyView(MotionPurchaseScene(cue: cue)), isReady: { true }, play: {
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    cue.purchase = .arriving
                    try? await Task.sleep(for: .seconds(0.8))
                    cue.purchase = .recorded(Money(micros: "25810000", currency: .USD))
                }
            })
        case .motionCostKnown:
            return TestScreen(view: AnyView(parts.mainWindow()), size: CGSize(width: 1120, height: 820), isReady: isReady, play: {
                FixtureSource.costIsKnown.withLock { $0 = true }
                store.start()
            })
        case .motionDetails:
            return TestScreen(view: AnyView(parts.mainWindow()), size: .regular, isReady: isReady, play: {
                navigation.target = .asset("AERO", .realized)
            })
        case .motionWalletUndo:
            store.changeWallet(Self.namedWallet, name: "Move to Yours") { store.moveToYours(Self.namedWallet) }
            let switcher = WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: PendingWalletName(), onOpenSpendingMoney: {}, onRemoveFromSavings: { _ in }, onDeleteSpendingMoney: {}, onDone: {})
            return TestScreen(view: AnyView(switcher.background(.background)), size: CGSize(width: 340, height: 480), isReady: isReady, play: {
                // What the Edit menu's Undo and Redo call, with nothing around them.
                Task {
                    try? await Task.sleep(for: .seconds(0.4))
                    store.undo()
                    try? await Task.sleep(for: .seconds(0.8 * Motion.slowdown))
                    store.redo()
                }
            })
        case .contrast:
            return TestScreen(view: AnyView(ContrastScene(store: store)), isReady: isReady)
        case .resolve(let height):
            return TestScreen(view: AnyView(ResolveFlow(store: store, firstRun: firstRun)), size: CGSize(width: 520, height: height), isReady: isReady)
        case .resolveSkipping(let skip):
            let model = ResolveModel(store: store)
            return TestScreen(view: AnyView(ResolveFlow(store: store, model: model)), size: CGSize(width: 520, height: 560), isReady: {
                guard isReady() else { return false }
                switch skip {
                // The card for an address known to be an exchange's, which has no My wallet.
                case .toKnownExchange: while let question = model.current, question.known == nil { model.skip() }
                case .everything: while model.current != nil { model.skip() }
                }
                return true
            })
        case .resolvePublishingFromDevice:
            return TestScreen(view: AnyView(ResolveFlow(store: store, noteWriter: SavingsNoteWriter()) { AnyView(PublishFromDeviceButton(link: $0, browsers: deviceBrowsers)) }), size: CGSize(width: 520, height: 560), isReady: isReady)
        case .holdComparison:
            return TestScreen(view: AnyView(HoldComparisonScene()), isReady: { true })
        case .route(let route):
            return routeScreen(route, parts)
        case .walletSwitcher:
            let switcher = WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: self == .walletSwitcherRenaming ? PendingWalletName(address: Self.namedWallet, text: "Treasury") : PendingWalletName(), onOpenSpendingMoney: {}, onRemoveFromSavings: { _ in }, onDeleteSpendingMoney: {}, onDone: {}, input: self == .walletSwitcherProblem ? "0x1234…abcd" : "", note: self == .walletSwitcherNote ? WalletListNote(text: Wording.movedToYours, undo: {}) : nil, displayRoom: self == .walletSwitcherLongSmallDisplay ? 240 : nil)
            return TestScreen(view: AnyView(switcher.background(.background)), isReady: isReady)
        case .taxReport:
            let view = TaxReportView(store: store, model: TaxReportModel(defaults: parts.defaults, currency: store.currency, fetch: { try await store.taxReport($0) }), onResolve: { _ in }, onOpen: { _ in })
            return TestScreen(view: AnyView(view.frame(width: 640, height: 1240).background(.background)), isReady: isReady)
        case .taxReportWithWallets:
            let view = TaxReportView(store: store, wallets: store.walletList(hotWallet: hotWallet).pickable, readAddress: AddressText.readAnywhere, addingWallet: self == .taxReportLeftOver ? "0x2222 0x33zz" : "", model: TaxReportModel(defaults: parts.defaults, currency: store.currency, fetch: { try await store.taxReport($0) }))
            return TestScreen(view: AnyView(view.frame(width: 640, height: 640).background(.background)), isReady: isReady)
        case .spendingMoneySetupSheet:
            return TestScreen(view: AnyView(SpendingMoneySetup(wallet: hotWallet, store: store, onDone: {}).frame(width: 480, height: 400)), isReady: isReady)
        case .spendingMoneySetup:
            return TestScreen(view: AnyView(SpendingMoneySetup(wallet: hotWallet, store: store)), size: CGSize(width: 560, height: 720), isReady: isReady)
        case .popover:
            return TestScreen(view: AnyView(PopoverView(store: store, hotWallet: hotWallet, navigation: navigation)), isReady: isReady)
        case .invitePrompt:
            return TestScreen(view: AnyView(InvitePrompt(store: store, decline: {}, isRefused: self == .invitePromptRefused)), isReady: isReady)
        case .menuBarLabel:
            return TestScreen(view: AnyView(MenuBarLabelScene(portfolio: { store.portfolio })), isReady: isReady)
        case .settings:
            let pane: SettingsView.Pane = switch self {
            case .settingsServer, .settingsServerProblem: .server
            case .settingsAnswers, .settingsAnswersEmpty: .answers
            default: .general
            }
            let view = SettingsView(
                store: store,
                notifications: MoneyNotifications(center: nil, defaults: parts.defaults, authorization: self == .settingsNotificationsOff ? .denied : .authorized),
                launchAtLogin: LaunchAtLogin(service: nil, state: self == .settingsLoginItemOff ? .needsApproval : .off),
                tab: .constant(pane),
                server: self == .settingsServerProblem ? "localhost 8787" : "",
                serverError: self == .settingsServerProblem ? WebAddress.problem(example: PortfolioStore.defaultServerURL) : nil,
                displayRoom: self == .settingsSmallDisplay ? 240 : nil
            )
            return TestScreen(view: AnyView(view), isReady: isReady)
        case .spendingMoney:
            // The real page, as choosing this wallet opens it. Taller than it opens, because a screenshot can't scroll to the activity and the settings at the bottom.
            navigation.showSpendingMoney()
            // The manual sweep, which is a row in the middle of the activity.
            if self == .hotWalletRecordShown { navigation.show(row: MoneyNotice.recordRow("0xde4" + String(repeating: "0", count: 59) + "20")) }
            var page = parts.mainWindow()
            page.showsOnlyPage = true
            let typed = self == .hotWalletNetworkProblem ? (typed: "base rpc", problem: WebAddress.problem(example: Base.publicRPC)) : nil
            return TestScreen(view: AnyView(page.environment(\.sceneNetworkAddress, typed)), size: CGSize(width: 560, height: 2800), isReady: isReady)
        case .spendingMoneyPurchases:
            navigation.showSpendingMoney()
            if self == .hotWalletPurchaseShown { navigation.show(row: MoneyNotice.purchaseRow("recorded")) }
            // The old key's manual sweep, which isn't shown anymore.
            if self == .hotWalletReplacedKeyShown { navigation.show(row: MoneyNotice.recordRow("0xde4" + String(repeating: "0", count: 59) + "20")) }
            // It keeps few enough that checking has nothing to trim, because that would save over what's registered here.
            if purchases.purchases.isEmpty { TestMode.fail("This scene's purchases weren't read. Something saved over them.") }
            var page = parts.mainWindow()
            page.showsOnlyPage = true
            return TestScreen(view: AnyView(page.task { if self == .hotWalletPurchasesCantCheck { await purchases.check() } }), size: CGSize(width: 780, height: 900), isReady: isReady)
        case .addSavings:
            return TestScreen(view: addSavingsSheet(hotWallet, wallets: store.walletList(hotWallet: hotWallet).pickable), isReady: isReady)
        case .receive:
            return TestScreen(view: AnyView(ReceiveSheet(wallet: hotWallet) {}), isReady: isReady)
        case .buy:
            return buyScreen(parts)
        case .topUp(let read):
            let sheet = TopUpSheet(wallet: hotWallet, server: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers)
            switch read {
            case .readsFirst: return TestScreen(view: AnyView(sheet), isReady: isReady)
            // The sheet opens first here, so the read has to change what it worked out.
            case .readsAfterItOpens: return TestScreen(view: AnyView(sheet.task { await parts.readHotWallet() }), isReady: { parts.hotWalletHasRead.isDone })
            // Never read, to show what it says while it waits.
            case .neverReads: return TestScreen(view: AnyView(sheet), isReady: { true })
            }
        case .send:
            return sendScreen(parts)
        case .security:
            return securityScreen(parts)
        case .revoke:
            guard let approvals: WalletApprovals = try? FixtureSource.decode("demo-approvals") else { TestMode.fail("There's no approvals fixture.") }
            let revocations = approvals.approvals.compactMap(Revocation.init)
            let quote = RevocationQuote(feeWei: 4_000_000_000_000, feeUsdMicros: 14_000, transactions: self == .revokeOne ? 1 : 3)
            return TestScreen(view: AnyView(RevokeSheet(wallet: hotWallet, revocations: self == .revokeOne ? [revocations[0]] : revocations, quote: quote, gate: .scene(.asking))), isReady: isReady)
        case .sweep:
            return TestScreen(view: AnyView(SweepSheet(wallet: hotWallet, gate: .scene(.asking))), isReady: isReady)
        case .sweepStopped:
            let problem = HotWalletWording.sweptOnlySome(onItsWay: ["USDC"], left: ["ETH"], because: "A sweep of ETH didn't go out. \(HotWalletWording.refusal("insufficient funds"))")
            return TestScreen(view: AnyView(SweepSheet(wallet: hotWallet, gate: .scene(.stopped(problem)))), isReady: isReady)
        case .siteScreen:
            return siteScreen(hotWallet: hotWallet, isReady: isReady)
        case .publishCost:
            let draft = CostNoteDraft(wallet: "0x00000000000000000000000000000000000de301", txHash: "0x" + String(repeating: "ab", count: 32), asset: "USDC", decimals: 6, units: "250000000")
            return TestScreen(view: AnyView(PublishCostSheet(draft: draft, currency: currency, typed: "250", publish: { _ in false }, problem: { nil }, isPublishing: { [self] in self == .publishWaiting })), isReady: isReady)
        case .publishFromDevice:
            // What the button's popover holds, because a render has no popovers. The page itself isn't part of this.
            return TestScreen(view: AnyView(PublishFromDeviceOffer(link: URL(string: "http://127.0.0.1:8787")!, browsers: deviceBrowsers, done: {}).background(.background)), isReady: { true })
        case .ruleComparison:
            if TestMode.live != nil { return TestScreen(view: AnyView(RuleComparisonSheet(store: store)), isReady: isReady) }
            guard let comparison: RuleComparison = try? FixtureSource.decode(self == .ruleComparison ? "demo-rule-comparison" : "demo-rule-comparison-cad") else { TestMode.fail("There's no comparison fixture.") }
            return TestScreen(view: AnyView(RuleComparisonTable(comparison: comparison).padding(20).frame(width: 720).background(.background)), isReady: { true })
        case .siteWindow:
            guard let wallet = hotWallet.address?.lowercased else { TestMode.fail("This scene's hot wallet has no address.") }
            let bridge = SiteBridge(wallet: hotWallet)
            let request = siteRequest(from: wallet)
            // Through the real checks and wording, up to the window. Nothing answers it there, so it goes no further.
            _ = bridge.begin(SiteRequest(connection: UUID(), id: "1", origin: HotWalletFixture.site, method: request.method, parameters: request.parameters))
            let armed = ContinuousClock.now + SiteApprovalView.armingDelay
            // The long one as a laptop would show it, whatever screen this runs on.
            let heightLimit: CGFloat? = self == .sitePreviewLong ? 760 : nil
            return TestScreen(view: AnyView(SiteApprovalWindow(bridge: bridge).environment(\.confirmationHeightLimit, heightLimit).navigationTitle(SiteApprovalWindow.title)), isReady: { bridge.current != nil && ContinuousClock.now >= armed })
        }
    }

    private func chartScreen(_ play: SceneSpec.ChartPlay, _ parts: SceneParts) -> TestScreen {
        let cue = MotionCue()
        let view = AnyView(MotionChartScene(store: parts.store, cue: cue))
        let isReady = parts.isReady
        switch play {
        case .scrubbed(let index):
            cue.scrubbed = index
            return TestScreen(view: view, isReady: isReady)
        case .scrubbedToAGap:
            // A point that's unknown on whichever chart this is, whose tooltip has only that to say.
            cue.scrubbed = TestMode.chartMetric == .value ? 5 : 2
            return TestScreen(view: view, isReady: isReady)
        case .drawing:
            return TestScreen(view: view, isReady: isReady, play: {
                forgetDrawnCharts()
                cue.revision += 1
            })
        case .changingRange:
            return TestScreen(view: view, isReady: isReady, play: { cue.range = .week })
        case .changingMetric:
            return TestScreen(view: view, isReady: isReady, play: { cue.metric = cue.metric == .pnl ? .value : .pnl })
        case .scrubbing:
            return TestScreen(view: view, isReady: isReady, play: {
                Task {
                    for index in 2...6 {
                        cue.scrubbed = index
                        try? await Task.sleep(for: .seconds(0.3 * Motion.slowdown))
                    }
                }
            })
        }
    }

    private func routeScreen(_ route: SceneSpec.Route, _ parts: SceneParts) -> TestScreen {
        let store = parts.store
        let hotWallet = parts.hotWallet
        let navigation = parts.navigation
        let isReady = parts.isReady
        let press: () -> Void
        let hasArrived: () -> Bool
        let hasSheet = { NSApp.windows.contains { $0.attachedSheet != nil } }
        let isOnSpendingMoney = { navigation.section == .overview && hotWallet.address != nil && store.address == hotWallet.address?.lowercased }
        switch route {
        case .send:
            press = navigation.send
            hasArrived = { navigation.pending == nil && isOnSpendingMoney() && hasSheet() }
        case .topUp:
            press = navigation.topUp
            hasArrived = { navigation.pending == nil && isOnSpendingMoney() && hasSheet() }
        case .buy:
            press = { navigation.pending = .buy }
            hasArrived = { navigation.pending == nil && hasSheet() }
        case .receive:
            press = { navigation.pending = .receive }
            hasArrived = { navigation.pending == nil && hasSheet() }
        case .addSavings:
            press = navigation.addSavings
            hasArrived = { navigation.pending == nil && isOnSpendingMoney() && hasSheet() }
        case .export:
            press = { navigation.pending = .export }
            hasArrived = { navigation.pending == nil }
        case .find:
            navigation.section = .taxReport
            press = navigation.find
            hasArrived = { navigation.pending == nil && navigation.section == .transactions }
        case .topUpCancelled:
            // There's no spending money, so it asks to make some, and that's cancelled the way the sheet's button does.
            press = {
                navigation.topUp()
                Task {
                    try? await Task.sleep(for: .seconds(0.2))
                    navigation.isSettingUpSpendingMoney = false
                }
            }
            hasArrived = { !navigation.isSettingUpSpendingMoney && navigation.pending == nil && !hasSheet() }
        case .holdings:
            navigation.section = .transactions
            press = navigation.showOverview
            hasArrived = { navigation.section == .overview }
        case .addWallet:
            navigation.section = .transactions
            press = navigation.showOverview
            hasArrived = { navigation.section == .overview && store.feed == .noWallet }
        case .details:
            navigation.section = .transactions
            press = { navigation.explain(.asset("AERO", .amount)) }
            hasArrived = { navigation.section == .overview && navigation.target != nil }
        case .removeFromSavings:
            // As the list's row does it: the list closes in the same moment, and the question still has to appear.
            navigation.section = .overview
            navigation.isSwitchingWallet = true
            press = {
                navigation.isSwitchingWallet = false
                navigation.removingFromSavings = WalletEntry(address: HotWalletFixture.savings.lowercased, name: "Ledger", kind: .savings)
            }
            hasArrived = { !navigation.isSwitchingWallet && navigation.removingFromSavings != nil && hasSheet() }
        case .answer:
            navigation.section = .transactions
            press = { navigation.resolve() }
            hasArrived = { navigation.isResolving && hasSheet() }
        }
        // A closed window has no section on screen yet, so it finds where to go when it appears.
        var pressedAt: Date?
        if !rawValue.hasSuffix("-open") {
            press()
            pressedAt = .now
        }
        return TestScreen(view: AnyView(parts.mainWindow()), size: .medium, isReady: {
            guard isReady() else { return false }
            if pressedAt == nil {
                press()
                pressedAt = .now
            }
            // Long enough for whatever reacts to the change to have run, because arriving doesn't count if something then undoes it.
            return Date.now.timeIntervalSince(pressedAt ?? .now) > 0.5 && hasArrived()
        })
    }

    private func buyScreen(_ parts: SceneParts) -> TestScreen {
        let typed: Int? = switch self {
        case .buyAboveRoom, .buyCADAboveRoom, .buyNoSavingsAboveRoom: 100
        case .buyLarge: 5000
        case .buyAtCap, .buyUSDCNoGas: 50
        case .buyTooLittle, .buyCADTooLittle: 2
        case .buyNegative: -5
        default: nil
        }
        let failure: String? = switch self {
        case .buyNotSetUp: "Buying isn't set up on this server."
        case .buyCantReachProvider: "Coinbase can't be reached right now."
        case .buyRefused: "Coinbase said: This project has reached its trial limit. Complete onboarding to continue."
        default: nil
        }
        let sheet = BuySheet(wallet: parts.hotWallet, purchases: parts.purchases, typed: typed, asset: self == .buyUSDCNoGas ? .usdc : .eth, failure: failure) {} addSavings: {}
        // These open before the first read, so the read has to change the amount it starts at.
        if [.buyFirstRead, .buyNoSavingsFirstRead, .buyNoSavingsAtCapFirstRead].contains(self) {
            return TestScreen(view: AnyView(sheet.task { await parts.readHotWallet() }), isReady: { parts.hotWalletHasRead.isDone })
        }
        // Never read, to show what it says while it waits.
        if self == .buyReading { return TestScreen(view: AnyView(sheet), isReady: { true }) }
        return TestScreen(view: AnyView(sheet), isReady: parts.isReady)
    }

    private func sendScreen(_ parts: SceneParts) -> TestScreen {
        let naming = self == .sendWhichUnits || self == .sendWhichUnitsReviewing
        let model = SendModel(wallet: parts.hotWallet, store: parts.store, canName: naming ? true : nil)
        model.token = Base.tokens.first { $0.symbol == "USDC" }!
        model.amountText = "12.50"
        model.addressText = switch self {
        case .sendPicking: ""
        case .sendSearching: "tre"
        case .sendPicked: Self.namedWallet
        // One letter's case changed in a checksummed address.
        case .sendTypo: "0x52908400098527886e0F7030069857D2E4169EE7"
        case .sendShortened: "0x3762…5D89"
        case .sendTyping: "0x5290840009852788"
        // Starts and ends like Treasury's, the way a poisoned address does.
        case .sendLookalike, .sendLookalikeChecked: "0x0007b3e9a14c5d2f60e8b91a7c3d5e2f4a6c0e01"
        default: Self.recipient
        }
        if self == .sendLookalikeChecked { model.acceptsLookalike = true }
        if naming {
            model.startNaming()
            model.picked = ["2026-02-14T15:20:00.000Z": "10", "2026-06-03T09:45:00.000Z": "2.5"]
        }
        if self == .sendWhichUnitsReviewing {
            return TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(.needsReview), done: {}).frame(width: 460).task {
                while model.held == .reading { try? await Task.sleep(for: .milliseconds(20)) }
                model.confirm()
            }), isReady: { parts.isReady() && model.stage == .confirming })
        }
        if self == .sendMoney || self == .sendMoneyCAD {
            model.switchUnit()
            model.amountText = "25"
        }
        // Touch ID's part never happens here: this only draws what's around it.
        func confirmation(_ phase: ApprovalPrompt.Phase) -> TestScreen {
            TestScreen(view: AnyView(SendConfirmation(model: model, gate: .scene(phase), done: {}).frame(width: 460)), isReady: parts.isReady)
        }
        return switch self {
        case .sendWaiting: confirmation(.asking)
        case .sendReviewing: confirmation(.needsReview)
        case .sendGoing: confirmation(.working)
        case .sendSent: confirmation(.done)
        case .sendStopped: confirmation(.stopped(nil))
        case .sendRefused: confirmation(.stopped(HotWalletWording.notSent("insufficient funds for gas * price + value")))
        default: TestScreen(view: AnyView(SendSheet(model: model, wallets: parts.store.walletList(hotWallet: parts.hotWallet).pickable)), isReady: { parts.isReady() && (!naming || model.held != .reading) })
        }
    }

    private func securityScreen(_ parts: SceneParts) -> TestScreen {
        let store = parts.store
        let isReady = parts.isReady
        guard let address = store.address else { TestMode.fail("This scene has no wallet to show.") }
        let reads = ReadOnce()
        let model = ApprovalsModel(address: address) { [self] in
            if self == .securityReading { try await Task.sleep(for: .seconds(3600)) }
            // The second read fails, so what the first found is what's showing.
            if self == .securityStale, await MainActor.run(body: { reads.isDone }) { throw FetchError.unreachable }
            return try await store.approvals(address: $0)
        }
        if self != .securityReading {
            Task {
                await model.load()
                reads.isDone = true
                if self == .securityStale { await model.load() }
            }
        }
        let page = SecurityPage(store: store, hotWallet: parts.hotWallet, navigation: parts.navigation, readBasics: { MacBasics(hasPassword: true, fileVaultOn: nil) }, approvalsModel: model)
        return TestScreen(view: AnyView(page.frame(width: 860, height: self == .securitySignedPermits ? 2120 : 1560).background(.background)), isReady: { [self] in isReady() && (self == .securityReading || model.approvals != nil) && (self != .securityStale || model.refreshFailure != nil) })
    }


    /// One step of the flow. Nothing here reaches the camera, a browser or another app: `AddSavingsMac` says what's there.
    private func addSavingsSheet(_ wallet: HotWallet, wallets: [WalletEntry]) -> AnyView {
        let other = "0x00000000000000000000000000000000000de304"
        let chrome = Self.chrome
        let safari = Self.safari
        var defaultBrowser = chrome
        var installed = [chrome]
        var ledgerWalletIsOpen = false
        var camera = AddressScanner.State.running
        var showsTrouble = false
        let model: AddSavingsModel
        switch self {
        case .hotWalletAddSavingsFilled: model = AddSavingsModel(wallet: wallet, device: .other, step: .check, address: other)
        case .hotWalletAddSavingsFromDevice:
            model = AddSavingsModel(wallet: wallet)
            model.receive(AddSavingsLink(url: URL(string: "patina://add-savings?address=\(other)&name=Ledger&linked=0x\(String(repeating: "ab", count: 20))")!)!)
        case .addSavingsLedgerPlugIn: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerPlugIn)
        case .addSavingsLedgerPlugInTrouble:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerPlugIn)
            showsTrouble = true
        case .addSavingsLedgerApp: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerApp)
        case .addSavingsLedgerQuit: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerQuit)
        case .addSavingsLedgerQuitStillOpen:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerQuit)
            ledgerWalletIsOpen = true
        case .addSavingsLedgerBrowser: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
        case .addSavingsLedgerBrowserSafari:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
            defaultBrowser = safari
            installed = [safari, chrome]
        case .addSavingsLedgerBrowserNone:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser)
            defaultBrowser = safari
            installed = [safari]
        case .addSavingsLedgerWaiting: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .ledgerBrowser, waitingForBrowser: true)
        case .addSavingsLedgerPaste: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .paste)
        case .addSavingsLedgerCheckTrouble:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
            showsTrouble = true
        case .addSavingsKeystoneUnlock: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneUnlock)
        case .addSavingsKeystoneReceive: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneReceive)
        case .addSavingsKeystoneReceiveTrouble:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneReceive)
            showsTrouble = true
        case .addSavingsKeystoneScan: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
        case .addSavingsKeystoneScanDenied:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
            camera = .denied
        case .addSavingsKeystoneScanNoCamera:
            model = AddSavingsModel(wallet: wallet, device: .keystone, step: .keystoneScan)
            camera = .noCamera
        case .addSavingsKeystoneType: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .paste)
        case .addSavingsKeystoneCheck: model = AddSavingsModel(wallet: wallet, device: .keystone, step: .check, address: other)
        case .addSavingsKeystoneWalked:
            // Every other scene starts on its step, so this is the one that shows Back.
            model = AddSavingsModel(wallet: wallet)
            model.choose(.keystone)
            model.next()
            model.next()
            model.read(other)
            if model.step != .check { TestMode.fail("This scene's walk didn't reach the check.") }
        case .addSavingsOtherPaste: model = AddSavingsModel(wallet: wallet, device: .other, step: .paste)
        case .addSavingsPicked: model = AddSavingsModel(wallet: wallet, device: .other, step: .paste, address: TestScene.namedWallet)
        case .addSavingsPickedCheck: model = AddSavingsModel(wallet: wallet, device: .other, step: .check, address: TestScene.namedWallet)
        case .addSavingsCheckStartsSweeps, .addSavingsCheckBalanceUnread, .addSavingsCheckFirstWallet: model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
        case .addSavingsFinished, .addSavingsFinishedSweeping, .addSavingsFinishedElsewhere:
            model = AddSavingsModel(wallet: wallet, device: .ledger, step: .check, address: other)
            model.matches = true
            Task { try? await model.add() }
            let deadline = Date.now.addingTimeInterval(TestMode.readyTimeout)
            while model.step != .finished {
                guard Date.now < deadline else { TestMode.fail("This scene's wallet wasn't added.") }
                RunLoop.main.run(until: .now.addingTimeInterval(0.01))
            }
        default: model = AddSavingsModel(wallet: wallet)
        }
        let mac = AddSavingsMac(
            browsers: browsers(defaultBrowser: defaultBrowser, installed: installed),
            ledgerWalletIsOpen: { [ledgerWalletIsOpen] in ledgerWalletIsOpen },
            scanner: { [camera] in AddressScanner(fixed: camera) }
        )
        return AnyView(AddColdWalletSheet(model: model, server: URL(string: "http://127.0.0.1:8787")!, mac: mac, showsTrouble: showsTrouble, wallets: wallets))
    }

    private static let twoRules = [
        PricingRule(id: "standard", name: "Standard", summary: "Chainlink prices, and swaps where there's no price.", dataset: "benface/pricetag@0.0.8", hash: "0x8f3a11c27d4e9b05"),
        PricingRule(id: "cautious-eth", name: "Cautious ETH", summary: "The same, with ETH counted 1% lower.", dataset: "benface/pricetag_cautious@0.0.3", hash: "0x2b71c9e04fa6d813"),
    ]

    /// One purchase in each state it can be in.
    private static func purchases(inCAD: Bool = false) -> [TrackedPurchase] {
        let wallet = HotWalletFixture.spending.lowercased
        let hash = "0x" + String(repeating: "ab", count: 32)
        let paid = Money(micros: "25810000", currency: inCAD ? .CAD : .USD)
        func delivered(_ id: String) -> OnrampOrder {
            OnrampOrder(id: id, status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, cost: paid)
        }
        func purchase(_ ref: String, dollars: Int, typed: PricetagKit.Money? = nil, asset: String = "ETH", at age: TimeInterval = 60, _ order: OnrampOrder? = nil) -> TrackedPurchase {
            TrackedPurchase(ref: ref, wallet: wallet, asset: asset, dollars: dollars, typed: typed, startedAt: .now.addingTimeInterval(-age), order: order)
        }
        return [
            purchase("gone", dollars: 10, at: 3 * 60 * 60),
            purchase("no-delivery", dollars: 15, OnrampOrder(id: "no-delivery", status: .failed, failure: .delivery)),
            purchase("no-payment", dollars: 20, asset: "USDC", OnrampOrder(id: "no-payment", status: .failed, failure: .payment)),
            purchase("held", dollars: 25, OnrampOrder(id: "held", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50)),
            purchase("no-rate", dollars: 25, OnrampOrder(id: "no-rate", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, paidIn: "SEK")),
            purchase("different", dollars: 25, delivered("different")),
            purchase("recorded", dollars: 25, delivered("recorded")),
            purchase("recorded-eur", dollars: 25, OnrampOrder(id: "recorded-eur", status: .succeeded, asset: "ETH", units: "8000000000000000", wallet: wallet, network: "base", txHash: hash, blockNum: 50, cost: Money(micros: "23150000", currency: .EUR))),
            purchase("arriving", dollars: 25, delivered("arriving")),
            purchase("going", dollars: 30, typed: inCAD ? Money(micros: "42000000", currency: .CAD) : nil, OnrampOrder(id: "going", status: .pending)),
            purchase("page", dollars: 20, typed: inCAD ? Money(micros: "28000000", currency: .CAD) : nil),
        ]
    }

    private static let purchaseMatches: [String: PurchaseMatch.State] = ["different": .unmatched, "recorded": .recorded, "recorded-eur": .recorded, "arriving": .waiting]

    /// What a site asks for in each of its scenes.
    private func siteRequest(from wallet: String) -> (method: String, parameters: JSONValue?) {
        let spender = "4444444444444444444444444444444444444444"
        guard let usdc = Base.tokens.first(where: { $0.symbol == "USDC" })?.contract?.lowercased else { TestMode.fail("There's no USDC.") }
        func transaction(to: String, value: String, data: String) -> (String, JSONValue?) {
            ("eth_sendTransaction", .array([.object(["from": .string(wallet), "to": .string(to), "value": .string(value), "data": .string(data)])]))
        }
        switch self {
        case .siteTransaction, .siteTransactionCAD:
            return transaction(to: "0x3333333333333333333333333333333333333333", value: "0x71afd498d0000", data: "0x12345678" + String(repeating: "0", count: 24) + spender)
        case .sitePreview:
            return transaction(to: HotWalletFixture.swapRouter, value: "0x0", data: "0x12345678")
        case .sitePreviewUnknown:
            return transaction(to: HotWalletFixture.unknownRouter, value: "0x71afd498d0000", data: "0x12345678")
        case .sitePreviewLong:
            return transaction(to: HotWalletFixture.longRouter, value: "0x0", data: "0x12345678")
        case .siteUnlimitedApproval:
            return transaction(to: usdc, value: "0x0", data: "0x095ea7b3" + String(repeating: "0", count: 24) + spender + String(repeating: "f", count: 64))
        case .siteTypedPermit:
            let permit = #"{"domain":{"name":"USD Coin","version":"2","chainId":8453,"verifyingContract":"\#(usdc)"},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(wallet)","spender":"0x\#(spender)","value":"115792089237316195423570985008687907853269984665640564039457584007913129639935","nonce":"0","deadline":"1793836800"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        case .sitePermitRemoval:
            // A request to take an allowance back to nothing, which only does that if it's sent.
            let permit = #"{"domain":{"name":"USD Coin","version":"2","chainId":8453,"verifyingContract":"\#(usdc)"},"types":{"Permit":[{"name":"owner","type":"address"},{"name":"spender","type":"address"},{"name":"value","type":"uint256"},{"name":"nonce","type":"uint256"},{"name":"deadline","type":"uint256"}]},"primaryType":"Permit","message":{"owner":"\#(wallet)","spender":"0x6ff5693b99212da76ad316178a184ab56d299b43","value":"0","nonce":"1","deadline":"1793838600"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        case .sitePermit2:
            // 250 USDC for Uniswap's router, through Permit2, for 30 days from 2026-11-05.
            let permit = #"{"domain":{"name":"Permit2","chainId":8453,"verifyingContract":"0x000000000022d473030f116ddee9f6b43ac78ba3"},"types":{"PermitSingle":[{"name":"details","type":"PermitDetails"},{"name":"spender","type":"address"},{"name":"sigDeadline","type":"uint256"}],"PermitDetails":[{"name":"token","type":"address"},{"name":"amount","type":"uint160"},{"name":"expiration","type":"uint48"},{"name":"nonce","type":"uint48"}]},"primaryType":"PermitSingle","message":{"details":{"token":"\#(usdc)","amount":"250000000","expiration":"1796428800","nonce":"0"},"spender":"0x6ff5693b99212da76ad316178a184ab56d299b43","sigDeadline":"1793838600"}}"#
            return ("eth_signTypedData_v4", .array([.string(wallet), .string(permit)]))
        default:
            return ("eth_requestAccounts", nil)
        }
    }

    /// The approval window in each state, from what a real request reads as. Its buttons answer nothing, so nothing can get as far as a key.
    private func siteScreen(hotWallet: HotWallet, isReady: @escaping () -> Bool) -> TestScreen {
        let site = "https://app.uniswap.org"
        let usdc = EthereumAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")!
        let friend = EthereumAddress("0x0000000000000000000000000000000000c0ffee")!
        let word = { (bytes: [UInt8]) in [UInt8](repeating: 0, count: 32 - bytes.count) + bytes }
        let address = word(Hex.decode(friend.lowercased) ?? [])
        let transfer = [0xA9, 0x05, 0x9C, 0xBB] + address + word([0x0B, 0xEB, 0xC2, 0x00])
        let limited = [0x09, 0x5E, 0xA7, 0xB3] + address + word([0x02, 0xFA, 0xF0, 0x80])
        let approval: SiteApproval
        var phase = ApprovalPrompt.Phase.asking
        var waitingBehind = 0
        switch self {
        case .siteSendToken, .siteStopped, .siteSending, .siteSent: approval = .sceneTransaction(origin: site, to: usdc, data: transfer)
        case .siteLongAmount: approval = .sceneTransaction(origin: site, to: friend, value: 123_456_789_012_345_678)
        case .siteCall: approval = .sceneTransaction(origin: site, to: friend, value: 1_000_000_000_000_000, data: [0xDE, 0xAD, 0xBE, 0xEF] + address)
        case .siteApprove: approval = .sceneTransaction(origin: site, to: usdc, data: limited)
        case .siteUnlimited, .siteUnlimitedAcknowledged: approval = .sceneUnlimitedApproval(origin: site, token: usdc, spender: friend)
        case .siteMessage, .siteSigning, .siteSigned: approval = .sceneMessage(origin: site, text: "Sign in to Uniswap\n\nThis doesn't cost anything.\nNonce: 8f2a91c4")
        case .siteMessageUnreadable: approval = .sceneUnreadableMessage(origin: site)
        default: approval = .sceneTransaction(origin: site, to: friend, value: 2_000_000_000_000_000)
        }
        if self == .siteStopped { phase = .stopped(nil) }
        if self == .siteBehind { phase = .waiting }
        if self == .siteUnlimited || self == .siteMessageUnreadable { phase = .needsAcknowledgment }
        if self == .siteNext {
            phase = .waiting
            waitingBehind = 2
        }
        // An interruption replaces the prompt. This isn't ready until the system's view on screen is paired with the new one, so if
        // it never is, the scene fails instead of drawing, and a real prompt would have been a dialog over the details.
        if self == .siteRefocused {
            let gate = ApprovalPrompt.scene(.waiting)
            var isReplaced = false
            let view = SiteApprovalView(approval: approval, waitingBehind: 0, money: { hotWallet.money($0) }, gate: gate, connect: {}, reject: {})
            return TestScreen(view: AnyView(view.frame(width: 480).background(.background)), isReady: {
                guard isReady(), gate.isPromptPaired else { return false }
                if isReplaced { return true }
                isReplaced = true
                gate.sceneReplacePrompt()
                return false
            })
        }
        let view: AnyView
        switch self {
        case .siteSending, .siteSent, .siteSigning, .siteSigned:
            view = AnyView(SiteProgressView(work: SiteWork(origin: site, isTransaction: self == .siteSending || self == .siteSent, sceneApproval: approval), money: { hotWallet.money($0) }, isDone: self == .siteSent || self == .siteSigned))
        case .siteFailure:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: true, reason: HotWalletWording.feesRoseAfterApproval), dismiss: {}))
        case .siteFailureMessage:
            view = AnyView(SiteFailureView(failure: SiteFailure(sceneOrigin: site, isTransaction: false, reason: HotWalletWording.keyMissing), dismiss: {}))
        default:
            view = AnyView(SiteApprovalView(approval: approval, waitingBehind: waitingBehind, money: { hotWallet.money($0) }, gate: .scene(phase, isInFront: self != .siteBehind), connect: {}, reject: {}))
        }
        return TestScreen(view: AnyView(view.frame(width: 480).background(.background)), isReady: isReady)
    }

    private static let recipient = "0x0000000000000000000000000000000000c0ffee"
    private static let emptyWallet = "0x00000000000000000000000000000000000de301"
    private static let namedWallet = "0x00000000000000000000000000000000c0ffee01"
    private static let recentWallet = "0x00000000000000000000000000000000c0ffee02"
    /// More than the list has room for, with the wallet showing at the far end.
    private static let manyWallets = (1...20).map { SavedWallet(address: "0x" + String(format: "%040x", 0xc0ffee00 + $0), name: String(format: "Wallet %02d", $0), lastSeen: Date(timeIntervalSince1970: 1_793_750_400)) }
    /// One of each kind of answer: a wallet that's yours, an exchange account with what was paid, someone else, a cost, and an import.
    private static let answers: Book = {
        let exchange = "0x00000000000000000000000000000000c0ffee04"
        // Decoded, because only the server makes these, so they have no initializer outside the package.
        var book = Book().answering(namedWallet, .mine, focus: nil).answering("0x0000000000000000000000000000000000bee5", .someoneElse, focus: nil)
        // Two withdrawals of ETH from the same exchange, each asked about and answered on its own, for the same amount.
        for receipt in exchangeReceipts {
            book = book.enteringExchangeCosts(exchange, receipts: [receipt], amounts: ["ETH": Money(micros: "5100000", currency: .USD)], focus: nil)
        }
        book = book.enteringCost("0x00000000000000000000000000000000000de300:0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e:VIRTUAL", Money(micros: "40000000", currency: .USD))
        book.withdrawals = (1...3).map { try! JSONDecoder().decode(ExchangeWithdrawal.self, from: Data(#"{"exchange":"coinbase","asset":"ETH","units":"\#($0)000000000000000","at":"2026-11-0\#($0)T12:00:00Z","cost":{"micros":"\#($0 * 3_000_000)","currency":"USD"},"toAddress":null}"#.utf8)) }
        return book
    }()
    private static let exchangeReceipts = [("53500120", "2100000000000000"), ("53521400", "1850000000000000")].map { block, units in
        try! JSONDecoder().decode(CostReceipt.self, from: Data(#"{"wallet":"0x00000000000000000000000000000000000de300","legId":"unseen:\#(block):ETH","asset":"ETH","units":"\#(units)"}"#.utf8))
    }
    private static let answerDetails: AnswerDetails = {
        var details = AnswerDetails()
        for (index, entry) in answers.answerEntries.enumerated() {
            details.dates[entry.id] = Date(timeIntervalSince1970: 1_793_750_400 - Double(index) * 5_400)
        }
        let exchange = "0x00000000000000000000000000000000c0ffee04"
        details.about[AnswerEntry.senderID(exchange)] = "0.0021 ETH from Coinbase"
        for (receipt, amount) in zip(exchangeReceipts, ["0.0021 ETH", "0.00185 ETH"]) {
            details.about[AnswerEntry.exchangeCostID(sender: exchange, asset: "ETH", receipts: [receipt])] = amount
        }
        details.about[AnswerEntry.senderID("0x0000000000000000000000000000000000bee5")] = "250 DAI"
        details.about[AnswerEntry.costID("0x00000000000000000000000000000000000de300:0x7d1c0e5a9b3f2e4d6c8a0b1f3e5d7c9a1b3d5f7e9c1a3b5d7f9e1c3a5b7d9f1e:VIRTUAL")] = "50 VIRTUAL"
        return details
    }()

    private static let savedWallets = [
        SavedWallet(address: namedWallet, name: "Treasury", lastSeen: Date(timeIntervalSince1970: 1_793_750_400)),
        SavedWallet(address: recentWallet, lastSeen: Date(timeIntervalSince1970: 1_793_750_300)),
        SavedWallet(address: "0x00000000000000000000000000000000c0ffee03", lastSeen: Date(timeIntervalSince1970: 1_793_750_200)),
    ]
}
#endif
