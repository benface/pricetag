import AppKit
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

extension PortfolioStore {
    func walletList(hotWallet: HotWallet?) -> WalletList {
        WalletList(
            spending: hotWallet?.address.map { NamedWallet(address: $0.lowercased, name: HotWalletWording.title) },
            savings: hotWallet?.settings.coldWallets.map { NamedWallet(address: $0.address.lowercased, name: $0.name) } ?? [],
            linked: book.linkedWallets,
            saved: savedWallets,
            current: address,
            offersDemo: WalletList.offersDemo
        )
    }
}

extension WalletList {
    /// For trying things while building the app. A fixture has no place in a release build, and scenes show what one looks like.
    static var offersDemo: Bool {
        #if DEBUG
        !TestMode.isRunning
        #else
        false
        #endif
    }
}

extension WalletKind {
    var symbol: String {
        switch self {
        case .spendingMoney: "banknote.fill"
        case .savings: "lock.fill"
        case .yours: "person.fill"
        case .watching: "eye.fill"
        case .demo: "sparkles"
        }
    }

    /// Green for money this Mac can move, blue for the user's own, and quiet for what's only being looked at.
    var tint: Color {
        switch self {
        case .spendingMoney: .green
        case .savings, .yours: .blue
        case .watching, .demo: .secondary
        }
    }
}

/// The current wallet, in the toolbar. It's what to click to get to another one, and it always says whose this is.
struct WalletButton: View {
    let store: PortfolioStore
    let hotWallet: HotWallet?
    @Bindable var navigation: Navigation

    var body: some View {
        let list = store.walletList(hotWallet: hotWallet)
        let current = list.entry(for: store.address)
        Button { navigation.isSwitchingWallet.toggle() } label: {
            HStack(spacing: 6) {
                Image(systemName: current?.kind.symbol ?? "plus")
                    .foregroundStyle(current?.kind.tint ?? .secondary)
                Text(current?.title ?? "Add Wallet")
                    .lineLimit(1)
                    .truncationMode(.middle)
                // Never cut off: a long name mustn't hide that this is only being watched.
                if let badge = current?.badge {
                    Text(badge)
                        .foregroundStyle(.secondary)
                        .fixedSize()
                }
                Image(systemName: "chevron.down")
                    .imageScale(.small)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 4)
            .frame(maxWidth: 300)
            .fixedSize()
        }
        .help(current.map { $0.shortAddress == nil ? "Switch wallet (⌘L)" : "\($0.address)\nSwitch wallet (⌘L)" } ?? "Add a wallet (⌘L)")
        .accessibilityLabel(current.map { [$0.title, $0.badge].compactMap(\.self).joined(separator: ", ") } ?? "Add Wallet")
        .accessibilityHint("Switches wallet")
        .popover(isPresented: $navigation.isSwitchingWallet, arrowEdge: .bottom) {
            WalletSwitcher(store: store, hotWallet: hotWallet, onOpenSpendingMoney: { navigation.section = .spendingMoney }) { navigation.isSwitchingWallet = false }
        }
    }
}

/// One click to switch. Opening it from the keyboard leaves the cursor in the last row, so ⌘L then ⌘V goes straight to a wallet.
struct WalletSwitcher: View {
    let store: PortfolioStore
    let hotWallet: HotWallet?
    let onOpenSpendingMoney: () -> Void
    let onDone: () -> Void
    @State var renaming: String?
    @State var problem: String?
    @State private var newName = ""
    @State private var highlighted: String?
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case add, rename
    }

    private var list: WalletList { store.walletList(hotWallet: hotWallet) }
    private var offersSpendingMoney: Bool {
        guard let hotWallet else { return false }
        return hotWallet.availability == .ready && hotWallet.address == nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    section("Yours", list.yours)
                    section("Watching", list.watching)
                    section("Recent", list.recent)
                    section(nil, list.demo.map { [$0] } ?? [])
                }
                .padding(6)
            }
            .frame(maxHeight: 440)
            .fixedSize(horizontal: false, vertical: true)
            Divider()
            VStack(alignment: .leading, spacing: 0) {
                if offersSpendingMoney { createSpendingMoney }
                addRow
                if let problem {
                    WarningText(problem)
                        .font(.caption)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.horizontal, 10)
                        .padding(.bottom, 6)
                }
            }
            .padding(6)
        }
        .frame(width: 340)
        .onAppear {
            highlighted = nil
            focus = renaming == nil ? .add : .rename
            if let renaming { newName = list.entry(for: renaming)?.name ?? "" }
        }
        .onKeyPress(.downArrow) { moveHighlight(by: 1) }
        .onKeyPress(.upArrow) { moveHighlight(by: -1) }
        // Clicking away keeps what was typed, as it does in Finder.
        .onChange(of: focus) { old, new in
            if old == .rename, new != .rename, let entry = list.entry(for: renaming) { finishRenaming(entry) }
        }
    }

    @ViewBuilder
    private func section(_ title: String?, _ entries: [WalletEntry]) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                if let title {
                    Text(title)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 3)
                }
                ForEach(entries) { entry in
                    if renaming == entry.address {
                        renameRow(entry)
                    } else {
                        row(entry)
                    }
                }
            }
        }
    }

    private func row(_ entry: WalletEntry) -> some View {
        let isHighlighted = highlighted == entry.address
        return HStack(spacing: 4) {
            Button { choose(entry.address) } label: {
                HStack(spacing: 10) {
                    WalletIcon(kind: entry.kind)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(entry.title)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Text(entry.detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel([entry.title, entry.detail].joined(separator: ", "))
            .accessibilityAddTraits(entry.address == store.address ? .isSelected : [])
            if isHighlighted, entry.kind != .demo {
                Menu {
                    actions(entry)
                } label: {
                    Image(systemName: "ellipsis")
                }
                .menuStyle(.button)
                .menuIndicator(.hidden)
                .buttonStyle(.borderless)
                .fixedSize()
                .accessibilityLabel("More for \(entry.title)")
            }
            if entry.address == store.address {
                Image(systemName: "checkmark")
                    .font(.callout.weight(.semibold))
                    .foregroundStyle(.tint)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background {
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(.primary.opacity(isHighlighted ? 0.09 : 0))
        }
        .onHover { hovering in
            if hovering { highlighted = entry.address } else if highlighted == entry.address { highlighted = nil }
        }
        .contextMenu {
            if entry.kind != .demo { actions(entry) }
        }
    }

    private func renameRow(_ entry: WalletEntry) -> some View {
        HStack(spacing: 10) {
            WalletIcon(kind: entry.kind)
            TextField("Name", text: $newName, prompt: Text(entry.shortAddress ?? ""))
                .textFieldStyle(.roundedBorder)
                .focused($focus, equals: .rename)
                .onSubmit { finishRenaming(entry) }
                .onExitCommand { stopRenaming() }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    @ViewBuilder
    private func actions(_ entry: WalletEntry) -> some View {
        if entry.kind == .spendingMoney {
            Button("Open \(HotWalletWording.title)") {
                onDone()
                onOpenSpendingMoney()
            }
        }
        if entry.canRename {
            Button(entry.name == nil ? "Name…" : "Rename…") {
                newName = entry.name ?? ""
                renaming = entry.address
                focus = .rename
            }
        }
        Button("Copy Address") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(EthereumAddress(entry.address)?.checksummed ?? entry.address, forType: .string)
        }
        if entry.canRemove {
            Divider()
            Button("Remove from List", role: .destructive) {
                store.removeWallet(entry.address, showing: list.next(afterRemoving: entry.address))
            }
        }
    }

    /// In its own section, which says what this is and what can go wrong, and is the only place that makes a key.
    private var createSpendingMoney: some View {
        Button {
            onDone()
            onOpenSpendingMoney()
        } label: {
            HStack(spacing: 10) {
                WalletIcon(kind: .spendingMoney)
                Text("Create \(HotWalletWording.title)…")
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    private var addRow: some View {
        HStack(spacing: 10) {
            Image(systemName: "plus")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .background(.quaternary.opacity(0.6), in: Circle())
                .accessibilityHidden(true)
            WalletAddressField(prompt: "Paste an address to watch it", problem: $problem, onEmptySubmit: {
                if let highlighted { choose(highlighted) } else { onDone() }
            }, onAddress: choose)
            .textFieldStyle(.plain)
            .focused($focus, equals: .add)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    private func choose(_ address: String) {
        store.setWallet(address)
        onDone()
    }

    /// Savings wallets keep their name with the rest of what makes them savings.
    private func finishRenaming(_ entry: WalletEntry) {
        if entry.kind == .savings, let address = EthereumAddress(entry.address) {
            hotWallet?.renameColdWallet(address, to: newName)
        } else {
            store.renameWallet(entry.address, to: newName)
        }
        stopRenaming()
    }

    private func stopRenaming() {
        renaming = nil
        focus = .add
    }

    private func moveHighlight(by step: Int) -> KeyPress.Result {
        let addresses = list.all.map(\.address)
        guard !addresses.isEmpty, renaming == nil else { return .ignored }
        // From the wallet showing the first time, because that's where the eye is.
        let current = (highlighted ?? store.address).flatMap(addresses.firstIndex(of:))
        let next = current.map { min(max($0 + step, 0), addresses.count - 1) } ?? (step > 0 ? 0 : addresses.count - 1)
        highlighted = addresses[next]
        return .handled
    }
}

private struct WalletIcon: View {
    let kind: WalletKind

    var body: some View {
        Image(systemName: kind.symbol)
            .font(.caption.weight(.medium))
            .foregroundStyle(kind.tint)
            .frame(width: 26, height: 26)
            .background(kind.tint.opacity(0.15), in: Circle())
            .accessibilityHidden(true)
    }
}

/// Addresses only: nothing in this app ever asks for a key or a recovery phrase, and nothing typed here is kept unless it's an address.
/// A complete address needs no confirming, so it goes straight through.
struct WalletAddressField: View {
    let prompt: String
    @Binding var problem: String?
    var onEmptySubmit: () -> Void = {}
    let onAddress: (String) -> Void
    @State private var input = ""

    var body: some View {
        // Only what's typed is in a code font: a prompt in one reads as a command.
        TextField(prompt, text: $input)
            .font(input.isEmpty ? .body : .body.monospaced())
            .autocorrectionDisabled()
            .onChange(of: input) {
                if let address = WalletAddress.find(in: input) {
                    input = ""
                    problem = nil
                    onAddress(address)
                } else {
                    problem = WalletAddress.isTooLong(input) ? Wording.notAnAddress : nil
                }
            }
            .onSubmit {
                if input.isEmpty { onEmptySubmit() } else { problem = Wording.notAnAddress }
            }
    }
}

/// The same choice, for the menu bar's popover and the Wallet menu, which can't hold a text field or a row's actions.
struct WalletPicker: View {
    let store: PortfolioStore
    let list: WalletList

    var body: some View {
        Picker("Wallet", selection: Binding(get: { store.address }, set: { store.setWallet($0) })) {
            ForEach(list.all) { entry in
                Text([entry.title, entry.badge].compactMap(\.self).joined(separator: " · ")).tag(Optional(entry.address))
            }
        }
        .pickerStyle(.inline)
        .labelsHidden()
    }
}
