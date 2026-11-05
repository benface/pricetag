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
            accounts: linkedWallets,
            saved: savedWallets,
            current: address,
            offersDemo: WalletList.offersDemo
        )
    }
}

/// A name being typed. It's kept outside the list, because a popover's content isn't reliably told when it closes.
@Observable
final class PendingWalletName {
    var address: String?
    var text: String

    init(address: String? = nil, text: String = "") {
        self.address = address
        self.text = text
    }
}

extension PortfolioStore {
    /// Savings wallets keep their name with the rest of what makes them savings.
    func save(_ pending: PendingWalletName, hotWallet: HotWallet?) {
        guard let address = pending.address, let entry = walletList(hotWallet: hotWallet).entry(for: address) else { return }
        pending.address = nil
        if entry.kind == .savings, let savings = EthereumAddress(address) {
            hotWallet?.renameColdWallet(savings, to: pending.text)
        } else {
            renameWallet(address, to: pending.text)
        }
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

/// The current wallet, in the toolbar. It's what to click to get to another one, and it always says whose this is.
struct WalletButton: View {
    let store: PortfolioStore
    let hotWallet: HotWallet?
    @Bindable var navigation: Navigation
    /// Past what the toolbar has room for, it hides the whole button behind its overflow menu. A long name gives way instead.
    var maxWidth: CGFloat = 300

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
            .frame(maxWidth: maxWidth)
            .fixedSize()
        }
        .help(current.map { $0.shortAddress == nil ? "Switch wallet (⌘L)" : "\($0.address)\nSwitch wallet (⌘L)" } ?? "Add a wallet (⌘L)")
        .accessibilityLabel(current.map { [$0.title, $0.badge].compactMap(\.self).joined(separator: ", ") } ?? "Add Wallet")
        .accessibilityHint("Switches wallet")
        .popover(isPresented: $navigation.isSwitchingWallet, arrowEdge: .bottom) {
            WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: navigation.pendingWalletName, onOpenSpendingMoney: { navigation.section = .spendingMoney }, onProve: { navigation.provingWallet = $0 }) { navigation.isSwitchingWallet = false }
        }
    }
}

/// One click to switch. Opening it from the keyboard leaves the cursor in the last row, so ⌘L then ⌘V goes straight to a wallet.
struct WalletSwitcher: View {
    let store: PortfolioStore
    let hotWallet: HotWallet?
    @Bindable var pendingName: PendingWalletName
    let onOpenSpendingMoney: () -> Void
    let onProve: (WalletProof) -> Void
    let onDone: () -> Void
    @State var input = ""
    @State private var highlighted: String?
    /// Where the pointer was when the arrows last moved. Rows scrolling under a still pointer report a hover that nobody made.
    @State private var pointerAtLastKey: CGPoint?
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case add, rename
    }

    private static let top = "top"

    private var list: WalletList { store.walletList(hotWallet: hotWallet) }
    private var offersSpendingMoney: Bool {
        guard let hotWallet else { return false }
        return hotWallet.availability == .ready && hotWallet.address == nil
    }

    var body: some View {
        ScrollViewReader { proxy in
            content
                .onKeyPress(.downArrow) { moveHighlight(by: 1, proxy) }
                .onKeyPress(.upArrow) { moveHighlight(by: -1, proxy) }
                // Opens where the wallet showing is, however long the list.
                .task { if let shown = pendingName.address ?? store.address { proxy.scrollTo(shown) } }
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            // With nothing to list, there's nothing for the rest to sit below.
            if !list.all.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        section("Yours", list.yours)
                        section("Watching", list.watching)
                        section("Recent", list.recent)
                        section(nil, list.demo.map { [$0] } ?? [])
                    }
                    .padding(6)
                    .id(Self.top)
                }
                .frame(maxHeight: 440)
                .fixedSize(horizontal: false, vertical: true)
                Divider()
            }
            VStack(alignment: .leading, spacing: 0) {
                if offersSpendingMoney { createSpendingMoney }
                addRow
            }
            .padding(6)
        }
        .frame(width: 340)
        .onAppear {
            highlighted = nil
            focus = pendingName.address == nil ? .add : .rename
        }
        // Clicking away keeps what was typed, as it does in Finder.
        .onChange(of: focus) { old, new in
            if old == .rename, new != .rename { store.save(pendingName, hotWallet: hotWallet) }
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
                    if pendingName.address == entry.address {
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
            if let pointerAtLastKey, pointerAtLastKey == NSEvent.mouseLocation { return }
            pointerAtLastKey = nil
            if hovering { highlighted = entry.address } else if highlighted == entry.address { highlighted = nil }
        }
        .contextMenu {
            if entry.kind != .demo { actions(entry) }
        }
    }

    private func renameRow(_ entry: WalletEntry) -> some View {
        HStack(spacing: 10) {
            WalletIcon(kind: entry.kind)
            TextField("Name", text: $pendingName.text, prompt: Text(entry.shortAddress ?? ""))
                .textFieldStyle(.roundedBorder)
                .focused($focus, equals: .rename)
                .onSubmit {
                    store.save(pendingName, hotWallet: hotWallet)
                    focus = .add
                }
                .onExitCommand {
                    pendingName.address = nil
                    focus = .add
                }
        }
        // As tall as the row it replaces, so the list doesn't jump.
        .frame(minHeight: 30)
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
                store.save(pendingName, hotWallet: hotWallet)
                pendingName.text = entry.name ?? ""
                pendingName.address = entry.address
                focus = .rename
            }
        }
        Button("Copy Address") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(EthereumAddress(entry.address)?.checksummed ?? entry.address, forType: .string)
        }
        if entry.canProve {
            Button("This Is My Wallet…") {
                onDone()
                onProve(list.proof(of: entry, current: store.address))
            }
        }
        if entry.canRemove {
            Divider()
            Button("Remove from List", role: .destructive) {
                store.removeWallet(entry.address, showing: list.next(afterRemoving: entry.address))
            }
        }
        if entry.canUnlink {
            Divider()
            Button("Not My Wallet", role: .destructive) { store.unlinkWallet(entry.address) }
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
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "plus")
                .font(.callout.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 26, height: 26)
                .background(.quaternary.opacity(0.6), in: Circle())
                .accessibilityHidden(true)
            // The list above is what there is to pick from, so this doesn't repeat it.
            AddressField(prompt: "Paste an address to watch it", text: $input, read: AddressText.readAnywhere, focus: $focus, equals: .add, onSubmit: {
                if let highlighted { choose(highlighted) } else { onDone() }
            }, onAddress: choose)
            .textFieldStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    private func choose(_ address: String) {
        store.setWallet(address)
        onDone()
    }

    private func moveHighlight(by step: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        let addresses = list.all.map(\.address)
        guard !addresses.isEmpty, pendingName.address == nil else { return .ignored }
        // From the wallet showing the first time, because that's where the eye is.
        let current = (highlighted ?? store.address).flatMap(addresses.firstIndex(of:))
        let next = current.map { min(max($0 + step, 0), addresses.count - 1) } ?? (step > 0 ? 0 : addresses.count - 1)
        highlighted = addresses[next]
        pointerAtLastKey = NSEvent.mouseLocation
        // The first row goes all the way up, to show its section's title too.
        if next == 0 { proxy.scrollTo(Self.top, anchor: .top) } else { proxy.scrollTo(addresses[next]) }
        return .handled
    }
}

/// The same choice, for the menu bar's popover and the Wallet menu, which can't hold a text field or a row's actions.
struct WalletPicker: View {
    let store: PortfolioStore
    let list: WalletList
    let navigation: Navigation
    var onChoose: () -> Void = {}

    /// Spending Money shows this Mac's wallet whichever one is chosen, so choosing another leaves that section, or nothing would seem to happen.
    func choose(_ address: String?) {
        store.setWallet(address)
        navigation.showChosenWallet()
        onChoose()
    }

    var body: some View {
        Picker("Wallet", selection: Binding(get: { store.address }, set: choose)) {
            ForEach(list.all) { entry in
                Text([entry.title, entry.badge].compactMap(\.self).joined(separator: " · ")).tag(Optional(entry.address))
            }
        }
        .pickerStyle(.inline)
        .labelsHidden()
    }
}
