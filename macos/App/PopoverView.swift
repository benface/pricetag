import PricetagKit
import SwiftUI

/// What the menu bar opens: the total, holdings with their cost and PnL, and a way into the window.
struct PopoverView: View {
    let store: PortfolioStore
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
            footer
        }
        .frame(width: 380)
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
                Text(portfolio.map { $0.mode == .demo ? "Demo wallet" : Format.shortHash($0.address) } ?? AppName.current)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                FeedBadge(feed: store.feed, portfolio: portfolio)
            }
            if let notice = store.feed.staleNotice(serverURL: store.serverURL, portfolio: portfolio) {
                Notice(.warning, notice)
            }
            switch (store.feed, portfolio) {
            case (.noWallet, _):
                Text("No wallet yet. Open the window to add one.").foregroundStyle(.secondary)
            case (_, let portfolio?) where portfolio.isEmpty:
                Text("No movements for this wallet in the blocks read.").foregroundStyle(.secondary)
            case (_, let portfolio?):
                PnlHeadline(portfolio: portfolio, isLive: isLive, size: 30) { open(.total(.pnl)) }
                // Two by two, because four across would cut off anything over $9,999.
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading), GridItem(.flexible(), alignment: .leading)], alignment: .leading, spacing: 8) {
                    ForEach(portfolio.totalStats, id: \.metric) { stat in
                        TotalStat(label: stat.label, text: stat.text, coverage: stat.coverage, isLive: isLive) { open(.total(stat.metric)) }
                    }
                }
            case (.reading, nil):
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Reading this wallet's history from Amp. The first read can take a minute.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
            default:
                EmptyView()
            }
        }
        .padding(14)
    }

    private func holdings(_ portfolio: Portfolio) -> some View {
        ScrollView {
            LazyVStack(spacing: 0) {
                ForEach(portfolio.positions) { position in
                    Button { open(.asset(position.asset, .amount)) } label: {
                        HoldingRow(position: position, isLive: isLive)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background {
                                RoundedRectangle(cornerRadius: 8, style: .continuous)
                                    .fill(.primary.opacity(highlighted == position.asset ? 0.09 : 0))
                            }
                    }
                    .buttonStyle(.plain)
                    .onHover { highlighted = $0 ? position.asset : nil }
                    .accessibilityHint("Opens this position's legs")
                }
            }
            .padding(4)
        }
        .frame(maxHeight: 300)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var footer: some View {
        HStack {
            Picker("Cost method", selection: Binding(get: { store.method }, set: { store.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .controlSize(.small)
            .fixedSize()
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
        guard let assets = portfolio?.positions.map(\.asset), !assets.isEmpty else { return .ignored }
        let current = highlighted.flatMap(assets.firstIndex(of:))
        let next = current.map { min(max($0 + step, 0), assets.count - 1) } ?? (step > 0 ? 0 : assets.count - 1)
        highlighted = assets[next]
        return .handled
    }
}
