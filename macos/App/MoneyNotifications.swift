import AppKit
import HotWalletKit
import Observation
import PricetagKit
import UserNotifications

/// Tells someone who isn't looking when money moves: sweeps, purchases, and what didn't go through. Quietly: no sound, and nothing that
/// breaks through Do Not Disturb or a Focus. A possibly stolen key isn't this one's job. The alarm stays as loud as it is.
@Observable
final class MoneyNotifications: NSObject, UNUserNotificationCenterDelegate {
    private static let category = "money-moved"
    private static let key = "notifiesWhenMoneyMoves"
    private static let toldKey = "purchaseNewsTold"
    /// Long enough for a sweep's ETH and USDC to land as one notification, and short enough to still be news.
    private static let gathering = Duration.seconds(3)

    /// The switch in Settings. It's on unless turned off, but nothing shows until the system has asked.
    private(set) var isOn: Bool
    /// What the system allows, read again whenever the app or Settings comes forward.
    private(set) var authorization: UNAuthorizationStatus = .notDetermined

    /// Nil in test scenes, which must never ask anything of the system, or show anything.
    @ObservationIgnored private let center: UNUserNotificationCenter?
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var heard: [HotWalletNews] = []
    @ObservationIgnored private var gathering: Task<Void, Never>?
    @ObservationIgnored private var watching: [Task<Void, Never>] = []
    /// Whether what a notification is about is already on screen in front of the person.
    @ObservationIgnored var isLookingAtSpendingMoney: () -> Bool = { false }
    @ObservationIgnored var onOpen: ((String) -> Void)?

    /// `authorization` is for test scenes, which have no center to ask.
    init(center: UNUserNotificationCenter? = .current(), defaults: UserDefaults = .standard, authorization: UNAuthorizationStatus = .notDetermined) {
        self.center = center
        self.defaults = defaults
        self.authorization = authorization
        isOn = defaults.object(forKey: Self.key) as? Bool ?? true
        super.init()
    }

    /// Here and not in a view, because sweeps and purchases finish with nothing open. The center's delegate is set before launch
    /// finishes, so a click that launches the app still gets here.
    func start(hotWallet: HotWallet, purchases: PurchaseTracker) {
        guard let center else { return }
        center.delegate = self
        // A locked screen shows what happened and not how much, unless the person has chosen to show everything there.
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [], intentIdentifiers: [], hiddenPreviewsBodyPlaceholder: MoneyNotice.hiddenBody, options: .hiddenPreviewsShowTitle)])
        Task { await refreshAuthorization() }
        hotWallet.onNews = { [weak self] in self?.hear($0, from: hotWallet) }
        watching = [
            // Every value, the first included, which is how a purchase from before this kept track is taken note of without a word.
            watch({ Self.phases(purchases) }, from: true) { [weak self] _, _ in self?.purchasesChanged(purchases, display: hotWallet.display.main) },
            // The first send, sweep or purchase is when this is first useful, so that's when the system asks. Never at launch.
            watch({ hotWallet.records.count + purchases.purchases.count }) { [weak self] earlier, now in
                if now > earlier ?? now { self?.askIfNeverAsked() }
            },
        ]
    }

    func setOn(_ value: Bool) {
        isOn = value
        defaults.set(value, forKey: Self.key)
        if value { askIfNeverAsked() }
    }

    func refreshAuthorization() async {
        guard let center else { return }
        authorization = await center.notificationSettings().authorizationStatus
    }

    /// Where the person turns them back on, once they've said no to the system's question.
    func openSystemSettings() {
        let id = Bundle.main.bundleIdentifier ?? ""
        if let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(id)") { NSWorkspace.shared.open(url) }
    }

    private func askIfNeverAsked() {
        guard isOn, let center else { return }
        Task {
            await refreshAuthorization()
            guard authorization == .notDetermined else { return }
            // Banners only. No sound and no badge, so it stays quiet.
            _ = try? await center.requestAuthorization(options: [.alert])
            await refreshAuthorization()
        }
    }

    // MARK: - What happened

    private func hear(_ news: HotWalletNews, from wallet: HotWallet) {
        heard.append(news)
        guard gathering == nil else { return }
        gathering = Task { [weak self] in
            try? await Task.sleep(for: Self.gathering)
            guard let self else { return }
            let news = heard
            heard = []
            gathering = nil
            let names = Dictionary(wallet.settings.coldWallets.map { ($0.address, $0.name) }, uniquingKeysWith: { first, _ in first })
            HotWalletWording.notices(for: news, savingsName: { names[$0] }, in: wallet.display).forEach(post)
        }
    }

    private static func phases(_ purchases: PurchaseTracker) -> [String: PurchasePhase] {
        Dictionary(purchases.purchases.map { ($0.ref, purchases.phase(of: $0)) }, uniquingKeysWith: { _, last in last })
    }

    /// A phase can step back while a wallet's numbers reload, or another wallet is chosen, so what's been told is kept, across launches too, and only what's further is said.
    private func purchasesChanged(_ purchases: PurchaseTracker, display main: CurrencyCode) {
        var news = defaults.data(forKey: Self.toldKey).flatMap { try? JSONDecoder().decode(PurchaseNews.self, from: $0) } ?? PurchaseNews()
        let before = news
        let notices = news.update(purchases.purchases.map { ($0, purchases.phase(of: $0)) }, beside: main)
        if news != before { defaults.set(try? JSONEncoder().encode(news), forKey: Self.toldKey) }
        notices.forEach(post)
    }

    private func post(_ notice: MoneyNotice) {
        guard isOn, let center else { return }
        let content = UNMutableNotificationContent()
        content.title = notice.title
        content.body = notice.body
        content.categoryIdentifier = Self.category
        content.threadIdentifier = Self.category
        content.userInfo = ["row": notice.row]
        // Shown, and held by Do Not Disturb and Focus like anything else. Never time-sensitive.
        content.interruptionLevel = .active
        center.add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
    }

    /// Calls `changed` with what something was and is, each time it changes, starting from what it is now. `from` also calls it with what it is to begin with.
    private func watch<Value: Equatable & Sendable>(_ value: @escaping @MainActor @Sendable () -> Value, from first: Bool = false, changed: @escaping (Value?, Value) -> Void) -> Task<Void, Never> {
        Task {
            var last: Value?
            for await next in Observations(value) {
                if let last { if last != next { changed(last, next) } } else if first { changed(nil, next) }
                last = next
            }
        }
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// Nothing about what the person is already looking at, which includes anything they just did there.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        await MainActor.run { isLookingAtSpendingMoney() ? [] : [.banner, .list] }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard response.actionIdentifier == UNNotificationDefaultActionIdentifier, let row = response.notification.request.content.userInfo["row"] as? String else { return }
        await MainActor.run { onOpen?(row) }
    }
}
