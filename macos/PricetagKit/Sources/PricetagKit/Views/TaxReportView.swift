import SwiftUI
import UniformTypeIdentifiers

/// Choose a country, read what the file will and won't say, then save it. The server writes the file.
public struct TaxReportView: View {
    let store: PortfolioStore
    let wallets: [WalletEntry]
    let readAddress: (String) -> String?
    @State private var model: TaxReportModel
    @State private var addingWallet: String
    @State private var document: TaxReportDocument?
    @State private var saveError: String?

    public init(store: PortfolioStore, wallets: [WalletEntry] = [], readAddress: @escaping (String) -> String? = WalletAddress.pasted(in:), addingWallet: String = "", model: TaxReportModel? = nil) {
        self.store = store
        _addingWallet = State(initialValue: addingWallet)
        self.wallets = wallets
        self.readAddress = readAddress
        _model = State(initialValue: model ?? TaxReportModel(currency: store.currency, fetch: { try await store.taxReport($0) }))
    }

    private var request: TaxReportRequest? {
        model.request(address: store.address, currency: store.currency, serverURL: store.serverURL, book: store.book, linked: store.address.map(store.linked(for:)) ?? [])
    }

    private var badWallet: String? {
        model.badWallet(for: store.address)
    }

    private var report: TaxReport? {
        if badWallet == nil, case .ready(let report) = model.state { return report }
        return nil
    }

    public var body: some View {
        VStack(spacing: 0) {
            Form {
                choices
                results
            }
            .formStyle(.grouped)
            Divider()
            HStack {
                if let saveError {
                    WarningText(saveError).font(.callout)
                } else {
                    Text("Not tax advice.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .help(report?.disclaimer ?? "Check this with an accountant before relying on it.")
                }
                Spacer()
                Button("Export CSV…") { document = report.map(TaxReportDocument.init) }
                    .buttonStyle(.borderedProminent)
                    .disabled(report == nil)
            }
            .padding(12)
        }
        .task(id: request) {
            if let request { await model.load(request) }
        }
        .fileExporter(
            isPresented: Binding(get: { document != nil }, set: { if !$0 { document = nil } }),
            document: document,
            contentType: .commaSeparatedText,
            defaultFilename: document?.filename
        ) { result in
            if case .failure(let error) = result { saveError = "Couldn't save it: \(error.localizedDescription)" } else { saveError = nil }
        }
    }

    @ViewBuilder
    private var choices: some View {
        Section {
            Picker("Country", selection: Binding(get: { model.country }, set: { model.setCountry($0) })) {
                ForEach(TaxCountry.allCases) { Text($0.name).tag($0) }
            }
            Picker(Wording.methodName, selection: Binding(get: { model.method }, set: { model.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label + defaultTag($0 == model.country.defaultMethod)).tag($0) }
            }
            Picker("Wallets", selection: Binding(get: { model.scope }, set: { model.setScope($0) })) {
                ForEach(TaxScope.allCases) { Text($0.label + defaultTag($0 == model.country.defaultScope)).tag($0) }
            }
        }
        if store.address != WalletAddress.demo {
            Section {
                ForEach(model.otherWallets, id: \.self) { otherWalletRow($0) }
                AddressField(
                    "Add a wallet",
                    prompt: wallets.isEmpty ? "Paste an address" : "Paste an address, or find a wallet",
                    text: $addingWallet,
                    wallets: wallets.filter { model.offers($0, showing: store.address, linked: store.address.map(store.linked(for:)) ?? []) },
                    read: readAddress,
                    takesSeveral: true,
                    onAddress: model.addOtherWallet
                )
                // A form's own style has no box, so its prompt would read as a label.
                .textFieldStyle(.roundedBorder)
            } header: {
                Text("Your other wallets")
            }
        }
    }

    private func otherWalletRow(_ address: String) -> some View {
        let wallet = wallets.first { $0.address == address }
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(wallet?.title ?? (WalletAddress.isValid(address) ? Format.shortHash(address) : address))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if !WalletAddress.isValid(address) {
                    // Only from before this could only hold addresses.
                    WarningText("This isn't a Base address.").font(.callout)
                } else if let wallet {
                    Text(wallet.pickDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button("Remove", systemImage: "minus.circle") { model.removeOtherWallet(address) }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .help("Remove")
        }
    }

    private func defaultTag(_ isDefault: Bool) -> String {
        isDefault ? " (default)" : ""
    }

    @ViewBuilder
    private var results: some View {
        switch model.state {
        case .failed(let message) where badWallet == nil:
            Section { WarningText(message).font(.callout) }
        case .loading where badWallet == nil:
            Section {
                HStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Working it out…").secondaryText()
                }
            }
        default:
            if let report { content(report) }
        }
    }

    @ViewBuilder
    private func content(_ report: TaxReport) -> some View {
        Section {
            // Each with its label, as one thing to read. Combining them would keep only the label.
            LabeledContent("Rows") { Text(Format.block(report.rowCount)).monospacedDigit() }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Rows, \(Format.block(report.rowCount))")
            LabeledContent("Unknown gain") {
                if report.unresolvedCount > 0 {
                    WarningText(Format.block(report.unresolvedCount)).monospacedDigit()
                } else {
                    Text("0").monospacedDigit()
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Unknown gain, \(Format.block(report.unresolvedCount))")
            LabeledContent("Gain on known rows") {
                if let gain = report.gainMicros {
                    LiveNumber(Format.signedMoney(gain, report.currency), tone: Tone(signed: gain))
                } else {
                    WarningText("Unknown")
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Spoken.number("Gain on known rows", report.gainMicros.map { Format.signedMoney($0, report.currency) }))
        }
        Section {
            DisclosureGroup("What this leaves out") {
                ForEach(report.warnings + report.notes, id: \.self) { line in
                    Text(line)
                        .font(.callout)
                        .secondaryText()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }
}

/// The server's file, unchanged.
struct TaxReportDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.commaSeparatedText]

    let csv: String
    let filename: String

    init(_ report: TaxReport) {
        csv = report.csv
        filename = report.filename
    }

    init(configuration: ReadConfiguration) throws {
        csv = String(decoding: configuration.file.regularFileContents ?? Data(), as: UTF8.self)
        filename = configuration.file.filename ?? "tax-report.csv"
    }

    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: Data(csv.utf8))
    }
}
