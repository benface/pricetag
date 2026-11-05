import SwiftUI
import UniformTypeIdentifiers

/// Choose a country, read what the file will and won't say, then save it. The server writes the file.
public struct TaxReportView: View {
    let store: PortfolioStore
    @State private var model: TaxReportModel
    @State private var document: TaxReportDocument?
    @State private var saveError: String?

    public init(store: PortfolioStore, model: TaxReportModel? = nil) {
        self.store = store
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
                TextEditor(text: Binding(get: { model.otherWalletsText }, set: { model.setOtherWalletsText($0) }))
                    .font(.callout.monospaced())
                    .autocorrectionDisabled()
                    .frame(height: 54)
                if let bad = badWallet {
                    WarningText("\(bad) isn't a Base address.").font(.callout)
                }
            } header: {
                Text("Your other wallets, one per line")
            }
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
                    Text("Working it out…").foregroundStyle(.secondary)
                }
            }
        default:
            if let report { content(report) }
        }
    }

    @ViewBuilder
    private func content(_ report: TaxReport) -> some View {
        Section {
            LabeledContent("Rows") { Text(Format.block(report.rowCount)).monospacedDigit() }
            LabeledContent("Unknown gain") {
                if report.unresolvedCount > 0 {
                    WarningText(Format.block(report.unresolvedCount)).monospacedDigit()
                } else {
                    Text("0").monospacedDigit()
                }
            }
            LabeledContent("Gain on known rows") {
                if let gain = report.gainMicros {
                    LiveNumber(Format.signedMoney(gain, report.currency), tone: Tone(signed: gain))
                } else {
                    WarningText("Unknown")
                }
            }
        }
        Section {
            DisclosureGroup("What this leaves out") {
                ForEach(report.warnings + report.notes, id: \.self) { line in
                    Text(line)
                        .font(.callout)
                        .foregroundStyle(.secondary)
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
