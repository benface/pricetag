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
            // Its own colors rather than a tint, as on the window's banner.
            Button(action: openHotWallet) {
                Text("Review")
                    .fontWeight(.semibold)
                    .foregroundStyle(.black)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 4)
                    .background(.white, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
            }
            .buttonStyle(.plain)
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
                    FeedBadge(feed: store.feed, portfolio: portfolio)
                        .fixedSize()
                }
            }
            switch (store.feed, portfolio) {
            case (.noWallet, _):
                HStack {
                    Text("No wallet yet").foregroundStyle(.secondary)
                    Spacer()
                    Button("Add Wallet…") { openOverview() }
                        .controlSize(.small)
                }
            case (_, let portfolio?) where !portfolio.progress.started:
                Text("No data for this wallet yet")
                    .foregroundStyle(.secondary)
                    .help(Wording.notStarted)
            case (_, let portfolio?) where portfolio.isEmpty:
                Text("No activity so far").foregroundStyle(.secondary)
            case (_, let portfolio?):
                headline(portfolio)
            case (.reading, nil):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading this wallet…").foregroundStyle(.secondary)
                }
                .help("The first read can take a minute.")
            default:
                EmptyView()
            }
            if let problem = store.feed.shortProblem(portfolio: portfolio) {
                ProblemRow(
                    problem,
                    detail: portfolio.flatMap(lastUpdate),
                    help: store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) ?? problem,
                    // Catching up is still updating, so there's nothing to retry.
                    actionTitle: isCatchingUp ? nil : "Retry",
                    action: store.start
                )
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
                    .font(.caption2.weight(.semibold))
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

    private func lastUpdate(_ portfolio: Portfolio) -> String? {
        guard !isCatchingUp, portfolio.progress.started else { return nil }
        return "Last update \(portfolio.latest.date.map(Format.time) ?? portfolio.latest.timestamp)"
    }

    /// The value, with its currency because a bare "$" doesn't say which, and how it's done right under it.
    private func headline(_ portfolio: Portfolio) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { open(.total(.value)) } label: {
                HStack(alignment: .lastTextBaseline, spacing: 5) {
                    if let value = portfolio.totalValueText {
                        LiveNumber(value)
                            .font(.system(size: 30, weight: .semibold))
                            .lineLimit(1)
                            .minimumScaleFactor(0.5)
                        Text(portfolio.currency.rawValue)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        // As readable as what it qualifies, because it changes what the number means.
                        if portfolio.isValuePartial {
                            Text("partial")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    } else {
                        Text("Value unavailable")
                            .font(.title3.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(NumberButtonStyle())
            .help(portfolio.partialValueReason ?? "")
            .accessibilityLabel("Value, \(portfolio.totalValueText ?? "unavailable")\(portfolio.isValuePartial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
            Button { open(.total(.pnl)) } label: {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    if let pnl = portfolio.totalPnlText {
                        LiveNumber(pnl, tone: isLive ? portfolio.totalPnlTone : .neutral)
                            .fontWeight(.medium)
                        Text("PnL").foregroundStyle(.secondary)
                        // As readable as what it qualifies, because it changes what the number means.
                        if portfolio.pnlStatus == .partial {
                            Text("partial").fontWeight(.medium).foregroundStyle(.secondary)
                        }
                    } else {
                        Text(Wording.pnlUnavailable).foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(NumberButtonStyle())
            .help(Wording.pnlHelp)
            .accessibilityLabel("Total PnL, \(portfolio.totalPnlText ?? Wording.pnlUnavailable)\(portfolio.pnlStatus == .partial ? ", partial" : "")")
            .accessibilityHint("Shows the activity behind this number")
        }
        .opacity(isLive ? 1 : 0.55)
        .animation(.easeOut(duration: 0.15), value: isLive)
    }

    private func attentionRow(_ text: String, _ portfolio: Portfolio) -> some View {
        let count = portfolio.questions.count
        return ProblemRow(
            text,
            help: portfolio.attention.map { ([$0.title] + $0.details).joined(separator: "\n") } ?? text,
            actionTitle: count > 0 ? "Answer \(count)" : "See Why"
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
                        .background {
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(.primary.opacity(highlighted == position.asset ? 0.09 : 0))
                        }
                }
                .buttonStyle(.plain)
                .onHover { highlighted = $0 ? position.asset : nil }
                .accessibilityHint("Shows this token's activity")
            }
            let more = portfolio.listedPositions.count - holdings.count
            if more > 0 {
                Button { openOverview() } label: {
                    Text("\(more) more")
                        .font(.caption)
                        .foregroundStyle(.secondary)
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
        } else if let plan = hotWallet.plan {
            Text("\(hotWallet.usd(plan.valueUsdMicros)) of \(hotWallet.usd(hotWallet.settings.capUsdMicros))")
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .help(plan.gasKeptWei > 0 ? HotWalletWording.keptOutOfCap(plan.gasKeptWei) : "")
        } else {
            Text("Reading…").foregroundStyle(.secondary)
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
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(Tone.warning.style)
                .accessibilityLabel("Warning")
            VStack(alignment: .leading, spacing: 1) {
                Text(title)
                    .monospacedDigit()
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                if let detail {
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .minimumScaleFactor(0.85)
                }
            }
            Spacer(minLength: 0)
            if let actionTitle {
                Button(actionTitle, action: action)
                    .controlSize(.small)
                    .fixedSize()
            }
        }
        .font(.callout)
        .help(help)
    }
}
