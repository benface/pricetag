import HotWalletKit
import PricetagKit
import SwiftUI

/// What the menu bar opens: a glance, not a small main window. What you have and how it's done, your largest holdings, and spending money.
/// Problems get a few words and one action here, with the whole sentence in a tooltip and in the window.
struct PopoverView: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var highlighted: String?

    private static let holdingsShown = 5

    private var portfolio: Portfolio? { store.portfolio }
    private var isLive: Bool { store.feed.isLive }
    private var holdings: [Position] {
        guard let portfolio, portfolio.progress.started else { return [] }
        return portfolio.largestHoldings(Self.holdingsShown)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if hotWallet.alarm != nil { alarmBanner }
            header
            if let portfolio, !holdings.isEmpty {
                Divider()
                holdingsList(portfolio)
            }
            // A build that can't hold a key has nothing to offer here.
            if hotWallet.availability != .notProvisioned {
                Divider()
                spendingMoney
            }
            Divider()
            footer
        }
        .environment(\.updatingNote, store.updatingNote)
        .environment(\.walletNames, store.walletList(hotWallet: hotWallet).names)
        .frame(width: 320)
        .background(.regularMaterial)
        .focusable()
        .focusEffectDisabled()
        .focused($isFocused)
        .onAppear {
            isFocused = true
            StatusItemMenu.shared.closePopover = { dismiss() }
        }
        .onDisappear { StatusItemMenu.shared.closePopover = nil }
        .onKeyPress(.downArrow) { moveHighlight(by: 1) }
        .onKeyPress(.upArrow) { moveHighlight(by: -1) }
        .onKeyPress(.return) {
            if let highlighted { open(.asset(highlighted, .amount)) } else { open(nil) }
            return .handled
        }
    }

    /// Above everything, in a color nothing else here uses. A possibly stolen key can't be something to scroll or squint for.
    private var alarmBanner: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.octagon.fill")
                .font(.title2)
                .accessibilityHidden(true)
            Text(HotWalletWording.alarmShort)
                .font(.headline)
            Spacer(minLength: 0)
            Button("Review", action: openHotWallet)
                .buttonStyle(AlarmButtonStyle())
        }
        .foregroundStyle(.white)
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(.red)
        .help(HotWalletWording.alarmAdvice)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                walletHeader
                Spacer(minLength: 8)
                if showsBadge {
                    FeedBadge(feed: store.feed, portfolio: portfolio, readingSince: store.readingSince)
                        .fixedSize()
                }
            }
            switch (store.feed, portfolio) {
            case (.noWallet, _):
                HStack {
                    Text("No wallet yet").secondaryText()
                    Spacer()
                    Button("Add Wallet…") { openOverview() }
                        .controlSize(.small)
                }
            case (_, let portfolio?) where !portfolio.progress.started:
                Text("No data for this wallet yet")
                    .secondaryText()
                    .help(Wording.notStarted)
            case (_, let portfolio?) where portfolio.isEmpty:
                Text("No activity so far").secondaryText()
            case (_, let portfolio?):
                headline(portfolio)
            case (.reading, nil):
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    ProgressView().controlSize(.small)
                    ReadingClock(since: store.readingSince ?? .now) { seconds in
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Reading this wallet…")
                            // Once it's taking a while, it says how long so far, without promising when it ends.
                            if seconds >= FeedState.longReadSeconds {
                                Text("\(Format.elapsed(seconds: seconds)) so far")
                                    .font(.caption)
                                    .monospacedDigit()
                                    .contentTransition(.numericText())
                            }
                        }
                        .secondaryText()
                        .help(Wording.stillReading(seconds: seconds))
                    }
                }
            default:
                EmptyView()
            }
            if let problem = store.feed.shortProblem(portfolio: portfolio) {
                // A retry that's taking a while says so in place of the second line, which comes back if it fails again.
                if store.feed.isStale, let since = store.readingSince {
                    ReadingClock(since: since) { problemRow(problem, retrying: $0 >= FeedState.longReadSeconds ? $0 : nil) }
                } else {
                    problemRow(problem, retrying: nil)
                }
            }
            if let portfolio, portfolio.progress.started, !portfolio.isEmpty, let attention = portfolio.shortAttention {
                attentionRow(attention, portfolio)
            }
        }
        .padding(14)
    }

    /// The same wallets as the window's toolbar, as a menu. Adding or naming one happens there, with room to do it.
    /// With no wallets, there's nothing for a menu to offer that the button below doesn't.
    @ViewBuilder
    private var walletHeader: some View {
        if store.walletList(hotWallet: hotWallet).all.isEmpty {
            Text(AppName.current)
                .font(.callout)
                .foregroundStyle(.secondary)
        } else {
            walletMenu
        }
    }

    private var walletMenu: some View {
        let list = store.walletList(hotWallet: hotWallet)
        let current = list.entry(for: store.address)
        return Menu {
            WalletPicker(store: store, list: list)
            Divider()
            Button("Add Wallet…") {
                navigation.switchWallet()
                open(nil)
            }
        } label: {
            // A long name gives way, and what kind of wallet this is doesn't.
            HStack(spacing: 4) {
                Text(current?.title ?? AppName.current)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if let badge = current?.badge {
                    Text(badge)
                        .fixedSize()
                }
                Image(systemName: "chevron.down")
                    .font(.caption.weight(.semibold))
            }
            .font(.callout)
            .foregroundStyle(.secondary)
        }
        .menuStyle(.button)
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
    }

    /// Not when the line beside it or under it already says the same: "Demo wallet", "No wallet yet", or "Reading this wallet…".
    private var showsBadge: Bool {
        switch store.feed {
        case .noWallet: false
        case .reading: portfolio != nil
        case .live: portfolio?.mode != .demo
        default: true
        }
    }

    private var isCatchingUp: Bool {
        if case .catchingUp = store.feed { true } else { false }
    }

    private func problemRow(_ problem: String, retrying seconds: Int?) -> some View {
        let full = store.feed.problem(serverURL: store.serverURL, portfolio: portfolio)
        // With no numbers here, nothing says how old they are, so it says what matters most instead.
        // A retry keeps how old the numbers are, and the badge above has its count.
        let last = portfolio.flatMap(lastUpdate)
        let detail = seconds.map { seconds in last.map { "\($0) · trying again" } ?? "Trying again · \(Format.elapsed(seconds: seconds))" } ?? last ?? (full == nil ? nil : Wording.moneyUnaffected)
        return ProblemRow(
            problem,
            detail: detail,
            help: full.map { [$0.message, $0.detail].compactMap { $0 }.joined(separator: "\n\n") } ?? store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) ?? problem,
            // Catching up is still updating, so there's nothing to retry.
            actionTitle: isCatchingUp ? nil : "Retry",
            action: store.refresh
        )
    }

    private func lastUpdate(_ portfolio: Portfolio) -> String? {
        guard !isCatchingUp, portfolio.progress.started else { return nil }
        return "Last update \(portfolio.latest.date.map(Format.time) ?? portfolio.latest.timestamp)"
    }

    /// The value, with its currency because a bare "$" doesn't say which, and how it's done right under it.
    /// What they leave out is said once, in the attention row below, the same as in the window.
    private func headline(_ portfolio: Portfolio) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { open(.total(.value)) } label: {
                HStack(alignment: .lastTextBaseline, spacing: 5) {
                    if let value = portfolio.totalValueText {
                        DisplayNumber(value, size: 30)
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                        Text(portfolio.currency.rawValue)
                            .font(.caption)
                            .secondaryText()
                    } else {
                        Text("Value unavailable")
                            .font(.title3.weight(.semibold))
                            .secondaryText()
                    }
                }
                .updatingMark(.trailing)
            }
            .buttonStyle(NumberButtonStyle())
            .help(portfolio.partialValueReason ?? "")
            .accessibilityLabel(Spoken.number("Value", portfolio.spokenValueText, isPartial: portfolio.isValuePartial, isLive: isLive))
            .accessibilityHint("Shows the activity behind this number")
            Button { open(.total(.pnl)) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if let pnl = portfolio.totalPnlText {
                        LiveNumber(pnl, tone: isLive ? portfolio.totalPnlTone : .neutral)
                            .fontWeight(.medium)
                        Text("PnL").secondaryText()
                    } else {
                        Text(Wording.pnlUnavailable).secondaryText()
                    }
                }
            }
            .buttonStyle(NumberButtonStyle())
            .help(Wording.pnlHelp)
            .accessibilityLabel(Spoken.number("Total PnL", portfolio.spokenPnlText, isPartial: portfolio.pnlStatus == .partial, isLive: isLive))
            .accessibilityHint("Shows the activity behind this number")
        }
        .stale(!isLive)
        .motion(Motion.state, value: portfolio.pnlStatus == .partial)
    }

    private func attentionRow(_ text: String, _ portfolio: Portfolio) -> some View {
        let count = portfolio.questions.count
        return ProblemRow(
            text,
            help: portfolio.attention.map { ([$0.title] + $0.details).joined(separator: "\n") } ?? text,
            actionTitle: count > 0 ? Wording.answerQuestions(count) : Wording.showMissing
        ) {
            if count > 0 {
                navigation.resolve()
                open(nil)
            } else {
                open(portfolio.attentionTarget)
            }
        }
    }

    private func holdingsList(_ portfolio: Portfolio) -> some View {
        VStack(spacing: 0) {
            ForEach(holdings) { position in
                Button { open(.asset(position.asset, .amount)) } label: {
                    HoldingRow(position: position, currency: portfolio.currency, isLive: isLive)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .buttonStyle(RowButtonStyle(isHighlighted: highlighted == position.asset))
                .onHover { highlighted = $0 ? position.asset : nil }
                .accessibilityHint("Shows this token's activity")
            }
            let more = portfolio.listedPositions.count - holdings.count
            if more > 0 {
                Button { openOverview() } label: {
                    Text("\(more) more")
                        .font(.caption)
                        .secondaryText()
                }
                .buttonStyle(NumberButtonStyle())
                .accessibilityHint("Shows every token in the window")
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 8)
                .padding(.vertical, 2)
            }
        }
        .padding(6)
    }

    private var spendingMoney: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(HotWalletWording.title)
                    .fontWeight(.medium)
                Spacer()
                spendingMoneyTrailing
            }
            if hotWallet.address != nil, let plan = hotWallet.plan {
                // Only a picture of the numbers above, which are what's real.
                Gauge(value: min(1, Double(plan.valueUsdMicros) / Double(hotWallet.settings.capUsdMicros)), in: 0...1) {}
                    .gaugeStyle(.accessoryLinearCapacity)
                    .tint(plan.excessUsdMicros > 0 ? .orange : .accentColor)
                    .controlSize(.small)
                    .accessibilityHidden(true)
                    .motion(Motion.number, value: plan.valueUsdMicros)
            }
            if case .unavailable(let message) = hotWallet.availability {
                ProblemRow("Can't open this wallet", help: message, actionTitle: "Review", action: openHotWallet)
            }
            // The alarm has its banner, and only the window can act on it.
            if hotWallet.alarm == nil, let notice = hotWallet.notices.first(where: { $0.kind == .warning }) {
                ProblemRow(notice.short ?? notice.text, help: notice.text, actionTitle: "Review", action: openHotWallet)
            }
            if hotWallet.canSend {
                HStack(spacing: 8) {
                    Button {
                        navigation.isBuying = true
                        openHotWallet()
                    } label: {
                        Label("Buy", systemImage: "plus").frame(maxWidth: .infinity)
                    }
                    Button {
                        navigation.isReceiving = true
                        openHotWallet()
                    } label: {
                        Label("Receive", systemImage: "qrcode").frame(maxWidth: .infinity)
                    }
                    Button {
                        navigation.send()
                        openHotWallet()
                    } label: {
                        Label("Send", systemImage: "arrow.up").frame(maxWidth: .infinity)
                    }
                    Button {
                        navigation.topUp()
                        openHotWallet()
                    } label: {
                        Label("Top Up", systemImage: "arrow.down").frame(maxWidth: .infinity)
                    }
                }
                // Four don't fit with their icons, and words alone say more than icons alone.
                .labelStyle(.titleOnly)
            }
        }
        .padding(14)
    }

    @ViewBuilder
    private var spendingMoneyTrailing: some View {
        if hotWallet.availability != .ready {
            EmptyView()
        } else if hotWallet.address == nil {
            Button("Set Up…", action: openHotWallet)
                .controlSize(.small)
        } else if let plan = hotWallet.plan, let value = hotWallet.valueUsdMicros {
            Text("\(hotWallet.money(value)) of \(hotWallet.capText)")
                .monospacedDigit()
                .secondaryText()
                .contentTransition(.numericText(value: Double(value)))
                .motion(Motion.number, value: value)
                .help(plan.gasKeptWei > 0 ? HotWalletWording.keptOutOfCap(plan.gasKeptWei) : "")
        } else {
            Text("Reading…").secondaryText()
        }
    }

    private var footer: some View {
        HStack(spacing: 12) {
            Button("Open \(AppName.current)") { open(nil) }
                .keyboardShortcut("o", modifiers: .command)
            Spacer()
            Button("Settings…", systemImage: "gearshape") {
                dismiss()
                openSettings()
                DockPresence.bringForward()
            }
            .keyboardShortcut(",", modifiers: .command)
            .labelStyle(.iconOnly)
            .help("Settings (⌘,)")
            Button("Quit \(AppName.current)", systemImage: "power") { NSApp.terminate(nil) }
                .keyboardShortcut("q", modifiers: .command)
                .labelStyle(.iconOnly)
                .help("Quit \(AppName.current) (⌘Q)")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
    }

    private func open(_ target: ExplainTarget?) {
        if let target { navigation.explain(target) }
        dismiss()
        openWindow(id: WindowID.main)
        DockPresence.bringForward()
    }

    /// `open(nil)` goes back to whichever section was showing, which suits Open but not something that promises the holdings or the wallet form.
    private func openOverview() {
        navigation.showOverview()
        open(nil)
    }

    private func openHotWallet() {
        navigation.showSpendingMoney()
        dismiss()
        openWindow(id: WindowID.main)
        DockPresence.bringForward()
    }

    private func moveHighlight(by step: Int) -> KeyPress.Result {
        let assets = holdings.map(\.asset)
        guard !assets.isEmpty else { return .ignored }
        let current = highlighted.flatMap(assets.firstIndex(of:))
        let next = current.map { min(max($0 + step, 0), assets.count - 1) } ?? (step > 0 ? 0 : assets.count - 1)
        highlighted = assets[next]
        return .handled
    }
}

/// A problem in a few words, with one thing to do about it. The whole sentence is in the tooltip.
private struct ProblemRow: View {
    let title: String
    var detail: String?
    let help: String
    var actionTitle: String?
    let action: () -> Void

    init(_ title: String, detail: String? = nil, help: String, actionTitle: String? = nil, action: @escaping () -> Void = {}) {
        self.title = title
        self.detail = detail
        self.help = help
        self.actionTitle = actionTitle
        self.action = action
    }

    var body: some View {
        // Beside the words when both fit, and under them when they don't, so a button's whole name never costs the warning its own.
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                icon
                words
                Spacer(minLength: 0)
                button
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    icon
                    words
                    Spacer(minLength: 0)
                }
                button.padding(.leading, 24)
            }
        }
        .font(.callout)
        .help(help)
    }

    private var icon: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .foregroundStyle(Tone.warning.style)
            .accessibilityLabel("Warning")
    }

    private var words: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(title)
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.85)
            if let detail {
                Text(detail)
                    .font(.caption)
                    .secondaryText()
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
            }
        }
    }

    @ViewBuilder
    private var button: some View {
        if let actionTitle {
            Button(actionTitle, action: action)
                .controlSize(.small)
                .fixedSize()
        }
    }
}
