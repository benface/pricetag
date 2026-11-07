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
            // A one-use address is only a stop on the way to savings, so it isn't a wallet to pick. Its costs still carry over.
            linked: book.linkedWallets.filter { address in !(hotWallet?.purchaseKeys.contains { $0.lowercased == address } ?? false) },
            replacedKeys: hotWallet?.replacedKeys ?? [],
            newKey: hotWallet?.rotation?.to.lowercased,
            saved: savedWallets,
            current: address,
            offersDemo: WalletList.offersDemo,
            order: walletOrder,
            hidden: hiddenWallets
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

    /// It's still the user's, and what's on it hasn't gone anywhere, so it stays in Yours under its name, and costs keep following its money.
    func removeFromSavings(_ entry: WalletEntry, hotWallet: HotWallet) {
        guard let savings = EthereumAddress(entry.address) else { return }
        hotWallet.removeColdWallet(savings)
        if let name = entry.name { renameWallet(entry.address, to: name) }
        moveToYours(entry.address)
    }

    /// Accounts from a device are only here for their costs, so they go as easily as anything else on the list. Says how to put it back.
    func moveToWatching(_ entry: WalletEntry, hotWallet: HotWallet?) {
        unlinkDeviceAccount(entry, hotWallet: hotWallet)
        moveToWatching(entry.address)
    }

    func remove(_ entry: WalletEntry, showing next: String?, hotWallet: HotWallet?) {
        unlinkDeviceAccount(entry, hotWallet: hotWallet)
        removeWallet(entry.address, showing: next)
    }

    private func unlinkDeviceAccount(_ entry: WalletEntry, hotWallet: HotWallet?) {
        if let account = EthereumAddress(entry.address) { hotWallet?.unlinkDeviceAccount(account) }
    }
}

extension HotWallet {
    func removingFromSavingsMessage(_ address: String) -> String {
        let others = settings.coldWallets.filter { $0.address.lowercased != address }
        return HotWalletWording.removingFromSavings(sweepsNowGoTo: others.first?.name, wasDestination: settings.sweepDestination?.lowercased == address, cap: display.whole(WalletSettings.capCeilingWithoutCold))
    }
}

extension WalletEntry {
    /// What Copy Address copies: this entry's own, with its checksum, so a pasted one can still be checked. Nothing for the demo wallet, which has none.
    var checksummedAddress: String? {
        kind == .demo ? nil : EthereumAddress(address)?.checksummed
    }
}

extension WalletList {
    /// For trying things while building the app, and for a tester with no wallet on Base to try. Otherwise a fixture has no place in a release
    /// build, and scenes show what one looks like.
    static var offersDemo: Bool {
        #if DEBUG
        Build.isForOtherPeople || !TestMode.isRunning
        #else
        Build.isForOtherPeople
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
                        .secondaryText()
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
        // The same as the Wallet menu's. It's this wallet's own address, never another row's.
        .contextMenu {
            if let address = current?.checksummedAddress {
                AddressActions(address: address)
                Divider()
            }
            Button("Switch Wallet…") { navigation.switchWallet() }
        }
        .popover(isPresented: $navigation.isSwitchingWallet, arrowEdge: .bottom) {
            WalletSwitcher(store: store, hotWallet: hotWallet, pendingName: navigation.pendingWalletName, onOpenSpendingMoney: navigation.showSpendingMoney, onRemoveFromSavings: { navigation.removingFromSavings = $0 }, onDeleteSpendingMoney: navigation.deleteSpendingMoney) { navigation.isSwitchingWallet = false }
        }
    }
}

/// One click to switch. Opening it from the keyboard leaves the cursor in the last row, so ⌘L then ⌘V goes straight to a wallet.
struct WalletSwitcher: View {
    let store: PortfolioStore
    let hotWallet: HotWallet?
    @Bindable var pendingName: PendingWalletName
    let onOpenSpendingMoney: () -> Void
    let onRemoveFromSavings: (WalletEntry) -> Void
    let onDeleteSpendingMoney: () -> Void
    let onDone: () -> Void
    @State var input = ""
    /// What the last change did, in words, and the way back. The list stays open for it.
    @State var note: WalletListNote?
    /// Stands in for a small display in a test scene.
    var displayRoom: CGFloat?
    @State private var room = WalletSwitcher.roomOnDisplay
    @State private var rows = ListRows()
    @State private var scrolled = ScrolledEdges()
    @State private var highlighted: String?
    /// Where the pointer was when the arrows last moved. Rows scrolling under a still pointer report a hover that nobody made.
    @State private var pointerAtLastKey: CGPoint?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var focus: Field?

    private enum Field: Hashable {
        case add, rename
    }

    private static let rowHeight: CGFloat = 40
    private static let titleHeight: CGFloat = 28
    private static let leastRoom: CGFloat = 200
    /// How long the fade is at an edge with more past it.
    private static let fadeHeight: CGFloat = 12

    private var list: WalletList { store.walletList(hotWallet: hotWallet) }
    private var offersSpendingMoney: Bool {
        guard let hotWallet else { return false }
        return hotWallet.availability == .ready && hotWallet.address == nil
    }
    private var cantOpenSpendingMoney: Bool {
        if case .unavailable = hotWallet?.availability { true } else { false }
    }
    /// What's left under the window's toolbar down to the bottom of the display, and past what goes under the list, however much a note takes. Larger Text
    /// makes a display smaller, so this is what keeps the list on it there too.
    private static var roomOnDisplay: CGFloat {
        let window = NSApp.mainWindow
        guard let display = (window?.screen ?? NSScreen.main)?.visibleFrame else { return 700 }
        return max((window?.frame.maxY ?? display.maxY) - display.minY - 200, leastRoom)
    }

    /// A first guess for the moment before the list has rows to measure.
    private var estimatedHeight: CGFloat {
        let titles = [list.yours, list.watching, list.recent].filter { !$0.isEmpty }.count
        return CGFloat(list.all.count) * Self.rowHeight + CGFloat(titles) * Self.titleHeight
    }

    /// The list is as tall as its rows, until there's no more room. Then it stops at the end of a row.
    private var listHeight: CGFloat {
        isCapped ? rows.heightEndingOnARow(atMost: displayRoom ?? room) : contentHeight
    }

    private var contentHeight: CGFloat { rows.contentHeight ?? estimatedHeight }
    private var isCapped: Bool { contentHeight > displayRoom ?? room }
    /// Not while the list is still growing to fit a row that came back.
    private var hasMoreBelow: Bool { isCapped && scrolled.hasMoreBelow }

    /// Which rows are in which section, and in what order. It's what the list slides on, so it does whatever moved them: a row's actions, Undo, or the Edit menu.
    private var rowsBySection: [[String]] {
        [list.yours, list.watching, list.recent].map { $0.map(\.address) }
    }

    var body: some View {
        ScrollViewReader { proxy in
            content
                .onKeyPress(.downArrow) { moveHighlight(by: 1, proxy) }
                .onKeyPress(.upArrow) { moveHighlight(by: -1, proxy) }
                // Opens where the wallet showing is, however long the list.
                .task { await scrollToShown(proxy) }
                // Growing to its real height moves what's in view, until someone's using it.
                .onChange(of: listHeight) {
                    guard highlighted == nil else { return }
                    Task { await scrollToShown(proxy) }
                }
        }
    }

    private func scrollToShown(_ proxy: ScrollViewProxy) async {
        guard let shown = pendingName.address ?? store.address else { return }
        // A list only knows where a far row is once it has laid out the rows before it, so this takes a second try.
        proxy.scrollTo(shown, anchor: .center)
        await Task.yield()
        proxy.scrollTo(shown, anchor: .center)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            // With nothing to list, there's nothing for the rest to sit below.
            if !list.all.isEmpty {
                // A list, so dragging a row is what it is everywhere else on a Mac. Sections keep their own order, because moving to another section
                // changes what a wallet is, and that isn't something to do by a slip of the mouse.
                List {
                    section(nil, list.allYours.map { [$0] } ?? [])
                    section("Yours", list.yours, canReorder: true)
                    section("Watching", list.watching, canReorder: true)
                    section("Recent", list.recent)
                    section(nil, list.demo.map { [$0] } ?? [])
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
                .alternatingRowBackgrounds(.disabled)
                .contentMargins(.horizontal, 0, for: .scrollContent)
                .environment(\.defaultMinListRowHeight, Self.rowHeight)
                .scrollBounceBehavior(.basedOnSize)
                .scrollIndicators(.visible)
                .scrollIndicatorsFlash(onAppear: true)
                // Rows that have been laid out can turn out taller than a first guess.
                .onScrollGeometryChange(for: CGFloat.self, of: \.contentSize.height) { _, _ in rows.measure() }
                .onScrollGeometryChange(for: ScrolledEdges.self) { ScrolledEdges(hasMoreAbove: $0.visibleRect.minY > 4, hasMoreBelow: $0.visibleRect.maxY < $0.contentSize.height - 4) } action: { scrolled = $1 }
                .frame(height: listHeight)
                .mask { edgeFades }
                // A scroll bar only shows once it's scrolling, and what's out of sight might be the wallet someone came for.
                .overlay(alignment: .bottomTrailing) {
                    // On the line below, where it's never over a row's name or its actions.
                    if hasMoreBelow { MoreBelowHint().padding(.trailing, 12).offset(y: 19) }
                }
                .zIndex(1)
                Divider()
            }
            VStack(alignment: .leading, spacing: 0) {
                if offersSpendingMoney || cantOpenSpendingMoney { createSpendingMoney }
                addRow
                if let note, note.change.map(store.isLatestChange) ?? true { noteRow(note).arrives() }
            }
            .padding(6)
        }
        .frame(width: 340)
        .motion(Motion.state, value: rowsBySection)
        // The table takes its new rows after this update, and the list changes height along with them.
        .onChange(of: rowsBySection) {
            Task {
                await Task.yield()
                withAnimation(reduceMotion ? nil : Motion.state) { rows.measure() }
            }
        }
        .onAppear {
            highlighted = nil
            focus = pendingName.address == nil ? .add : .rename
        }
        // Clicking away keeps what was typed, as it does in Finder.
        .onChange(of: focus) { old, new in
            if old == .rename, new != .rename { store.save(pendingName, hotWallet: hotWallet) }
        }
    }

    /// Softens the edge something scrolled past goes under.
    private var edgeFades: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [scrolled.hasMoreAbove ? .clear : .black, .black], startPoint: .top, endPoint: .bottom)
                .frame(height: Self.fadeHeight)
            Color.black
            LinearGradient(colors: [.black, hasMoreBelow ? .clear : .black], startPoint: .top, endPoint: .bottom)
                .frame(height: Self.fadeHeight)
        }
    }

    private func noteRow(_ note: WalletListNote) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(note.text)
                .font(.caption)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if let undo = note.undo {
                Button("Undo") {
                    undo()
                    self.note = nil
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private func section(_ title: String?, _ entries: [WalletEntry], canReorder: Bool = false) -> some View {
        if !entries.isEmpty {
            Section {
                ForEach(entries) { entry in
                    Group {
                        if pendingName.address == entry.address {
                            renameRow(entry)
                        } else {
                            row(entry)
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 6))
                    .background { ListRowsReader(rows: rows) }
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }
                .onMove(perform: canReorder && entries.count > 1 ? { store.moveWallets(in: entries.map(\.address), from: $0, to: $1) } : nil)
            } header: {
                if let title {
                    Text(title)
                        .font(.caption.weight(.medium))
                        .secondaryText()
                        .padding(.horizontal, 10)
                }
            }
        }
    }

    private func row(_ entry: WalletEntry) -> some View {
        let isHighlighted = highlighted == entry.address
        return HStack(spacing: 4) {
            HStack(spacing: 10) {
                WalletIcon(kind: entry.kind)
                VStack(alignment: .leading, spacing: 1) {
                    Text(entry.title)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    // All Yours says how many wallets it adds up. Every other row's is a kind and an address.
                    Group {
                        if entry.kind == .allYours {
                            Text(entry.detail)
                                .secondaryText()
                        } else {
                            Text(entry.detail)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .font(.caption)
                    .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
            // A tap and not a button, because a button keeps the mouse to itself, and then the row can't be dragged.
            .onTapGesture { choose(entry.address) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([entry.title, entry.detail].joined(separator: ", "))
            .accessibilityAddTraits(entry.address == store.address ? [.isButton, .isSelected] : .isButton)
            .accessibilityAction { choose(entry.address) }
            if isHighlighted, entry.kind != .demo, entry.kind != .allYours {
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
            if entry.kind != .demo, entry.kind != .allYours { actions(entry) }
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
        if entry.canRename {
            Button(entry.name == nil ? "Name…" : "Rename…") {
                store.save(pendingName, hotWallet: hotWallet)
                pendingName.text = entry.name ?? ""
                pendingName.address = entry.address
                focus = .rename
            }
        }
        if let address = entry.checksummedAddress {
            AddressActions(address: address)
        }
        if let arranged = [list.yours, list.watching].first(where: { $0.contains(entry) && $0.count > 1 }), let index = arranged.firstIndex(of: entry) {
            // For the keyboard and VoiceOver, which can't drag.
            Button("Move Up") { store.moveWallets(in: arranged.map(\.address), from: [index], to: index - 1) }
                .disabled(index == 0)
            Button("Move Down") { store.moveWallets(in: arranged.map(\.address), from: [index], to: index + 2) }
                .disabled(index == arranged.count - 1)
        }
        if entry.canKeep {
            Button("Keep in Watching") { store.keepWallet(entry.address) }
        }
        if entry.canMoveToYours {
            Button("Move to Yours") {
                change(entry, to: Wording.movedToYours, named: "Move to Yours") { store.moveToYours(entry.address) }
            }
        }
        if entry.canMoveToWatching {
            Button("Move to Watching") {
                change(entry, to: Wording.movedToWatching, named: "Move to Watching") { store.moveToWatching(entry, hotWallet: hotWallet) }
            }
        }
        if entry.canRemove {
            Divider()
            Button("Remove from List", role: .destructive) {
                let text = entry.isReplacedKey ? Wording.removedReplacedKey : entry.kind == .yours ? Wording.removedYours : Wording.removedWatching
                change(entry, to: text, named: "Remove from List") { store.remove(entry, showing: list.next(afterRemoving: entry.address), hotWallet: hotWallet) }
            }
        }
        if entry.canStopBeingSavings {
            Divider()
            Button("Remove from Savings…", role: .destructive) {
                onDone()
                onRemoveFromSavings(entry)
            }
            .disabled(hotWallet?.isWorking == true)
        }
        if entry.kind == .spendingMoney {
            Divider()
            // It holds a key, so deleting it is never one click away: its page asks first, and offers to sweep it.
            Button("Delete…", role: .destructive) {
                onDone()
                onDeleteSpendingMoney()
            }
        }
    }

    /// Does it, and says what changed right away, because the numbers change with it. An account from a device comes back with Undo too,
    /// here and in the Edit menu.
    private func change(_ entry: WalletEntry, to text: String, named name: String, _ action: @escaping () -> Void) {
        let account = hotWallet?.settings.deviceAccounts.first { $0.lowercased == entry.address }
        let relink = { [hotWallet] in if let account { hotWallet?.linkDeviceAccounts([account.lowercased]) } }
        let before = store.changeWallet(entry.address, name: name, alsoUndo: relink, action)
        note = WalletListNote(text: text, change: before) { [store] in
            relink()
            store.restore(before)
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
                Text(cantOpenSpendingMoney ? "Can't Open \(HotWalletWording.title)…" : "Create \(HotWalletWording.title)…")
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
        proxy.scrollTo(addresses[next])
        return .handled
    }
}

/// How far a list goes past each edge of what's showing.
private struct ScrolledEdges: Equatable {
    var hasMoreAbove = false
    var hasMoreBelow = false
}

/// The table behind a List, for what SwiftUI doesn't say: where each row and title really is. It also leaves a whole row at the top whenever scrolling stops.
@MainActor
@Observable
private final class ListRows {
    private(set) var scrollView: NSScrollView?
    /// How tall the rows really are, once there's a table to ask.
    private(set) var contentHeight: CGFloat?
    @ObservationIgnored private var observers: [any NSObjectProtocol] = []
    @ObservationIgnored private var isScrolling = false
    @ObservationIgnored private var lastOffset: CGFloat = 0
    @ObservationIgnored private var isGoingDown = true
    @ObservationIgnored private var settling: Task<Void, Never>?

    isolated deinit {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
    }

    /// From what the rows take up, because the table and its content size never get shorter than what's showing, and what's showing is sized from this.
    func measure() {
        guard let scrollView, let table = scrollView.documentView as? NSTableView else { return }
        let rows = table.intrinsicContentSize.height
        guard rows > 0 else { return }
        let insets = scrollView.contentView.contentInsets
        let height = (rows + insets.top + insets.bottom).rounded(.up)
        if height != contentHeight { contentHeight = height }
    }

    func attach(to scrollView: NSScrollView) {
        defer { measure() }
        guard self.scrollView !== scrollView else { return }
        self.scrollView = scrollView
        let center = NotificationCenter.default
        scrollView.contentView.postsBoundsChangedNotifications = true
        observers = [
            center.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.isScrolling = true }
            },
            center.addObserver(forName: NSScrollView.didEndLiveScrollNotification, object: scrollView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.isScrolling = false
                    self?.settleSoon()
                }
            },
            // A mouse wheel and scrolling from code don't count as live scrolling, so this is how those stop.
            center.addObserver(forName: NSView.boundsDidChangeNotification, object: scrollView.contentView, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.moved() }
            },
        ]
    }

    /// A whole number of rows and what's under the last one, so when one row is whole at the top, so is the one at the bottom, all the way to the end. Only
    /// rows that have been laid out know their real height, and those are the ones showing.
    func heightEndingOnARow(atMost limit: CGFloat) -> CGFloat {
        guard let table = scrollView?.documentView as? NSTableView, table.numberOfRows > 0 else { return limit }
        let showing = table.rows(in: table.visibleRect)
        guard let row = (showing.lowerBound..<showing.upperBound).map({ table.rect(ofRow: $0).height }).max(), row > 0 else { return limit }
        let under = table.intrinsicContentSize.height - table.rect(ofRow: table.numberOfRows - 1).maxY
        return ((limit - under) / row).rounded(.down) * row + under
    }

    private func moved() {
        guard let offset = scrollView?.contentView.bounds.minY, offset != lastOffset else { return }
        isGoingDown = offset > lastOffset
        lastOffset = offset
        settleSoon()
    }

    private func settleSoon() {
        settling?.cancel()
        settling = Task { [weak self] in
            try? await Task.sleep(for: .seconds(0.15))
            guard !Task.isCancelled else { return }
            self?.settle()
        }
    }

    /// On in the direction it was already going, so a row the arrow keys just brought in from the bottom stays in.
    private func settle() {
        guard !isScrolling, let scrollView, let table = scrollView.documentView as? NSTableView else { return }
        let clip = scrollView.contentView
        let offset = clip.bounds.minY
        let end = table.frame.height - clip.bounds.height
        guard offset > 0, offset < end else { return }
        let cut = (0..<table.numberOfRows).map { table.rect(ofRow: $0) }.first { $0.minY < offset - 0.5 && $0.maxY > offset + 0.5 }
        guard let cut else { return }
        let target = min(isGoingDown ? cut.maxY : cut.minY, end)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 : 0.15 * Motion.slowdown
            clip.animator().setBoundsOrigin(CGPoint(x: clip.bounds.minX, y: target))
        }
    }
}

/// Lives in a row, because that's what's inside the table. Rows come and go as the list scrolls, so what it finds is kept outside it.
private struct ListRowsReader: NSViewRepresentable {
    let rows: ListRows

    func makeNSView(context: Context) -> Finder {
        Finder(rows: rows)
    }

    func updateNSView(_ view: Finder, context: Context) {
        view.rows = rows
    }

    final class Finder: NSView {
        var rows: ListRows

        init(rows: ListRows) {
            self.rows = rows
            super.init(frame: .zero)
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) { nil }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            guard window != nil, let scrollView = enclosingScrollView else {
                // A row leaving, which the table may only just have caught up with.
                DispatchQueue.main.async { [rows] in rows.measure() }
                return
            }
            // Later, because this can run in the middle of a SwiftUI update.
            DispatchQueue.main.async { [rows] in rows.attach(to: scrollView) }
        }
    }
}

/// What a change to the list did.
struct WalletListNote {
    let text: String
    /// Shows only while this is the latest change, so the Edit menu's Undo hides it and its Redo brings it back.
    var change: WalletListSnapshot?
    var undo: (() -> Void)?
}

/// The same choice, for the menu bar's popover and the Wallet menu, which can't hold a text field or a row's actions.
struct WalletPicker: View {
    let store: PortfolioStore
    let list: WalletList
    var onChoose: () -> Void = {}

    func choose(_ address: String?) {
        store.setWallet(address)
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
