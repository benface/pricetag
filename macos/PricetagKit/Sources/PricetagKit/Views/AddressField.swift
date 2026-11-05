import SwiftUI

/// The one place to enter an address: paste it, type it, or pick a saved wallet. Addresses only: nothing in this app ever asks for a key or a
/// recovery phrase. Picking only fills in the field, so whatever a flow checks before it trusts an address, it still has to check.
public struct AddressField<Focus: Hashable>: View {
    private let label: String
    private let prompt: String
    @Binding private var text: String
    private let wallets: [WalletEntry]
    private let read: (String) -> String?
    private let focus: FocusState<Focus>.Binding?
    private let focusValue: Focus?
    private let takesSeveral: Bool
    private let onSubmit: () -> Void
    private let onAddress: ((String) -> Void)?
    /// What Return was last pressed on, so what it found wrong goes away as soon as that changes.
    @State private var submitted: String?
    @State private var highlighted: String?
    @State private var hovered: String?

    /// With `onAddress`, an address needs no confirming: it goes straight through and leaves the field empty, and `takesSeveral` lets one paste
    /// bring more than one. Without it, the address stays in `text` for the rest of the form.
    public init(
        _ label: String = "Address",
        prompt: String,
        text: Binding<String>,
        wallets: [WalletEntry] = [],
        read: @escaping (String) -> String? = WalletAddress.pasted(in:),
        focus: FocusState<Focus>.Binding,
        equals focusValue: Focus,
        takesSeveral: Bool = false,
        onSubmit: @escaping () -> Void = {},
        onAddress: ((String) -> Void)? = nil
    ) {
        self.label = label
        self.prompt = prompt
        _text = text
        self.wallets = wallets
        self.read = read
        self.focus = focus
        self.focusValue = focusValue
        self.takesSeveral = takesSeveral
        self.onSubmit = onSubmit
        self.onAddress = onAddress
    }

    private var suggestions: [WalletEntry] { AddressInput.suggestions(for: text, in: wallets) }

    private var input: AddressInput {
        AddressInput(text: text, isSubmitted: submitted == text, hasMatches: !suggestions.isEmpty, read: read)
    }

    /// Typing something makes its first match what Return picks, so a few letters of a name and Return is enough.
    private var highlightedWallet: WalletEntry? {
        suggestions.first { $0.address == highlighted } ?? (text.isEmpty ? nil : suggestions.first)
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            field
            message
            if !suggestions.isEmpty { list }
        }
        .onChange(of: text) {
            highlighted = nil
            take()
        }
        .onKeyPress(.downArrow) { moveHighlight(by: 1) }
        .onKeyPress(.upArrow) { moveHighlight(by: -1) }
    }

    @ViewBuilder
    private var field: some View {
        if let focus, let focusValue {
            textField.focused(focus, equals: focusValue)
        } else {
            textField
        }
    }

    private var textField: some View {
        // Only an address is in a code font: a prompt in one reads as a command, and a name isn't code.
        TextField(label, text: $text, prompt: Text(prompt))
            .labelsHidden()
            .font(text.hasPrefix("0x") ? .body.monospaced() : .body)
            .autocorrectionDisabled()
            .onSubmit(submit)
            .overlay(alignment: .trailing) {
                if !text.isEmpty {
                    Button("Clear", systemImage: "xmark.circle.fill") { text = "" }
                        .labelStyle(.iconOnly)
                        .buttonStyle(.plain)
                        .foregroundStyle(.secondary)
                        .padding(.trailing, 6)
                        .help("Clear")
                }
            }
    }

    @ViewBuilder
    private var message: some View {
        switch input {
        case .problem(let problem):
            WarningText(problem)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        case .typing(let digits) where suggestions.isEmpty:
            Text("\(digits) of 40 characters")
                .font(.caption)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        default:
            EmptyView()
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(suggestions) { row($0) }
                }
                .padding(4)
            }
            // Four rows and part of a fifth, which shows there's more.
            .frame(maxHeight: 178)
            .fixedSize(horizontal: false, vertical: true)
            .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onChange(of: highlighted) { if let highlighted { proxy.scrollTo(highlighted) } }
        }
    }

    private func row(_ wallet: WalletEntry) -> some View {
        Button { pick(wallet) } label: {
            HStack(spacing: 10) {
                WalletIcon(kind: wallet.kind)
                VStack(alignment: .leading, spacing: 1) {
                    Text(wallet.title)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text(wallet.pickDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
            .background {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(.primary.opacity(wallet == highlightedWallet ? 0.09 : wallet.address == hovered ? 0.05 : 0))
            }
        }
        .buttonStyle(.plain)
        .id(wallet.address)
        .onHover { isHovering in
            if isHovering { hovered = wallet.address } else if hovered == wallet.address { hovered = nil }
        }
        .accessibilityLabel([wallet.title, wallet.pickDetail].joined(separator: ", "))
    }

    /// Whatever arrived, by typing or pasting, once it's an address. The field then holds only that, so what's checked is what's seen.
    private func take() {
        if takesSeveral, let onAddress {
            let found = WalletAddress.all(in: text)
            if found.count > 1 {
                let readable = found.filter { read($0) != nil }
                readable.forEach { onAddress($0.lowercased()) }
                text = found.first { read($0) == nil } ?? ""
                return
            }
        }
        guard let address = read(text.trimmingCharacters(in: .whitespacesAndNewlines)) else { return }
        if let onAddress {
            text = ""
            onAddress(address.lowercased())
        } else if address != text {
            text = address
        }
    }

    private func pick(_ wallet: WalletEntry) {
        highlighted = nil
        if let onAddress {
            text = ""
            onAddress(wallet.address)
        } else {
            text = read(wallet.address) ?? wallet.address
        }
    }

    private func submit() {
        if let highlightedWallet {
            pick(highlightedWallet)
            return
        }
        submitted = text
        switch input {
        case .empty, .address: onSubmit()
        default: break
        }
    }

    private func moveHighlight(by step: Int) -> KeyPress.Result {
        let addresses = suggestions.map(\.address)
        guard !addresses.isEmpty else { return .ignored }
        let current = highlightedWallet.flatMap { addresses.firstIndex(of: $0.address) }
        highlighted = addresses[current.map { min(max($0 + step, 0), addresses.count - 1) } ?? (step > 0 ? 0 : addresses.count - 1)]
        return .handled
    }
}

extension AddressField where Focus == Bool {
    /// For a place with nothing to move the cursor to it.
    public init(
        _ label: String = "Address",
        prompt: String,
        text: Binding<String>,
        wallets: [WalletEntry] = [],
        read: @escaping (String) -> String? = WalletAddress.pasted(in:),
        takesSeveral: Bool = false,
        onSubmit: @escaping () -> Void = {},
        onAddress: ((String) -> Void)? = nil
    ) {
        self.label = label
        self.prompt = prompt
        _text = text
        self.wallets = wallets
        self.read = read
        focus = nil
        focusValue = nil
        self.takesSeveral = takesSeveral
        self.onSubmit = onSubmit
        self.onAddress = onAddress
    }
}
