import HotWalletKit
import PricetagKit
import SwiftUI

/// What the menu bar opens: the total, holdings with their cost and PnL, and a way into the window.
struct PopoverView: View {
    let store: PortfolioStore
    let hotWallet: HotWallet
    let navigation: Navigation
    @Environment(\.openWindow) private var openWindow
    @Environment(\.openSettings) private var openSettings
    @Environment(\.dismiss) private var dismiss
    @FocusState private var isFocused: Bool
    @State private var highlighted: String?

    private var portfolio: Portfolio? { store.portfolio }
    private var isLive: Bool { store.feed.isLive }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            if let portfolio, !portfolio.isEmpty {
                holdings(portfolio)
                Divider()
            }
            spendingMoney
            Divider()
            footer
        }
        .frame(width: 380)
        .background(.regularMaterial)
        .focusable()
        .focusEffectDisabled()
        .focused($isFocused)
        .onAppear { isFocused = true }
        .onKeyPress(.downArrow) { moveHighlight(by: 1) }
        .onKeyPress(.upArrow) { moveHighlight(by: -1) }
        .onKeyPress(.return) {
            if let highlighted { open(.asset(highlighted, .amount)) } else { open(nil) }
            return .handled
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                walletMenu
                Spacer()
                FeedBadge(feed: store.feed, portfolio: portfolio)
            }
            if let notice = store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) {
                Notice(.warning, notice)
            }
            switch (store.feed, portfolio) {
            case (.noWallet, _):
                Text("No wallet yet.").foregroundStyle(.secondary)
            case (_, let portfolio?) where !portfolio.progress.started:
                Text(Wording.notStarted).foregroundStyle(.secondary)
            case (_, let portfolio?) where portfolio.isEmpty:
                Text("No activity for this wallet in this time.").foregroundStyle(.secondary)
            case (_, let portfolio?):
                PortfolioSummary(portfolio: portfolio, isLive: isLive, size: 30) { open(.total($0)) }
                PortfolioAttention(portfolio: portfolio, isCompact: true, onOpen: { open($0) }, onResolve: {
                    navigation.resolve()
                    open(nil)
                })
            case (.reading, nil):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading this wallet's history. The first read can take a minute.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            default:
                EmptyView()
            }
        }
        .padding(14)
    }

    /// The same wallets as the window's toolbar, as a menu. Adding or naming one happens there, with room to do it.
    private var walletMenu: some View {
        let list = store.walletList(hotWallet: hotWallet)
        let current = list.entry(for: store.address)
        return Menu {
            WalletPicker(store: store, list: list)
            Divider()
            Button("Add Wallet…") {
                navigation.isSwitchingWallet = true
                open(nil)
            }
        } label: {
            Text(current.map { [$0.title, $0.badge].compactMap(\.self).joined(separator: " · ") } ?? AppName.current)
        }
        .menuStyle(.borderlessButton)
        .controlSize(.small)
        .fixedSize()
        .foregroundStyle(.secondary)
    }

    private func holdings(_ portfolio: Portfolio) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(portfolio.listedPositions) { position in
                    Button { open(.asset(position.asset, .amount)) } label: {
                        HoldingRow(position: position, currency: portfolio.currency, isLive: isLive)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(.primary.opacity(highlighted == position.asset ? 0.09 : 0))
                            }
                    }
                    .buttonStyle(.plain)
                    .onHover { highlighted = $0 ? position.asset : nil }
                    .accessibilityHint("Shows this token's activity")
                }
            }
            .padding(4)
            if let noMarket = Wording.noMarket(portfolio) {
                Text(noMarket)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.bottom, 8)
            }
        }
        .frame(maxHeight: 300)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var spendingMoney: some View {
        Button {
            dismiss()
            openWindow(id: WindowID.hotWallet)
            DockPresence.bringForward()
        } label: {
            HStack(spacing: 8) {
                Image(systemName: hotWallet.needsAttention ? "exclamationmark.triangle.fill" : "banknote")
                    .foregroundStyle(hotWallet.needsAttention ? Tone.warning.style : AnyShapeStyle(.secondary))
                Text(HotWalletWording.title)
                Spacer()
                Text(spendingMoneySummary)
                    .monospacedDigit()
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.right")
                    .font(.caption2.bold())
                    .foregroundStyle(.tertiary)
            }
            .font(.callout)
            .padding(.horizontal, 14)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var spendingMoneySummary: String {
        if hotWallet.alarm != nil { return "Key may be stolen" }
        guard hotWallet.address != nil else { return "Set up" }
        guard let plan = hotWallet.plan else { return "Reading…" }
        return "\(hotWallet.usd(plan.valueUsdMicros)) of \(hotWallet.usd(hotWallet.settings.capUsdMicros))"
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let rule = store.activeRuleName {
                Text("\(Wording.rulesTitle): \(rule)").font(.caption).foregroundStyle(.secondary)
            }
            footerControls
        }
    }

    private var footerControls: some View {
        HStack {
            CostMethodMenu(store: store)
            Spacer()
            Button("Open \(AppName.current)") { open(nil) }
                .keyboardShortcut("o", modifiers: .command)
                .controlSize(.small)
            Menu {
                Button("Settings…") {
                    dismiss()
                    openSettings()
                    DockPresence.bringForward()
                }
                .keyboardShortcut(",", modifiers: .command)
                Button("Quit \(AppName.current)") { NSApp.terminate(nil) }
                    .keyboardShortcut("q", modifiers: .command)
            } label: {
                Image(systemName: "ellipsis")
            }
            .menuStyle(.button)
            .menuIndicator(.hidden)
            .buttonStyle(.borderless)
            .controlSize(.small)
            .fixedSize()
            .accessibilityLabel("More")
        }
        .padding(10)
    }

    private func open(_ target: ExplainTarget?) {
        if let target { navigation.target = target }
        dismiss()
        openWindow(id: WindowID.main)
        DockPresence.bringForward()
    }

    private func moveHighlight(by step: Int) -> KeyPress.Result {
        guard let assets = portfolio?.listedPositions.map(\.asset), !assets.isEmpty else { return .ignored }
        let current = highlighted.flatMap(assets.firstIndex(of:))
        let next = current.map { min(max($0 + step, 0), assets.count - 1) } ?? (step > 0 ? 0 : assets.count - 1)
        highlighted = assets[next]
        return .handled
    }
}
