import SwiftUI
import UniformTypeIdentifiers

/// Choose a country, read what the file will and won't say, then save it. The server writes the file.
public struct TaxReportView: View {
    let store: PortfolioStore
    let wallets: [WalletEntry]
    let readAddress: (String) -> String?
    /// Opens a wallet's questions about what's unknown. It can be one added here rather than the one showing.
    let onResolve: ((String) -> Void)?
    /// Opens the details of a number, for what's unknown that no question covers.
    let onOpen: ((ExplainTarget) -> Void)?
    @State private var model: TaxReportModel
    @State private var addingWallet: String
    @State private var document: TaxReportDocument?
    @State private var saveError: String?

    public init(store: PortfolioStore, wallets: [WalletEntry] = [], readAddress: @escaping (String) -> String? = WalletAddress.pasted(in:), addingWallet: String = "", model: TaxReportModel? = nil, onResolve: ((String) -> Void)? = nil, onOpen: ((ExplainTarget) -> Void)? = nil) {
        self.store = store
        self.onResolve = onResolve
        self.onOpen = onOpen
        _addingWallet = State(initialValue: addingWallet)
        self.wallets = wallets
        self.readAddress = readAddress
        _model = State(initialValue: model ?? TaxReportModel(currency: store.currency, fetch: { try await store.taxReport($0) }))
    }

    /// What the report is on. All Yours has no address of its own, so it's on the first of them, with the rest alongside.
    private var reportAddress: String? {
        WalletAddress.isAllYours(store.address) ? store.allYoursWallets.first : store.address
    }

    private var reportLinked: [String] {
        guard let address = store.address else { return [] }
        return store.linked(for: address).filter { $0 != reportAddress }
    }

    private var request: TaxReportRequest? {
        model.request(address: reportAddress, currency: store.currency, serverURL: store.serverURL, book: store.book, linked: reportLinked)
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
                        .secondaryText()
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
            Picker("Year", selection: Binding(get: { model.shownYear }, set: { model.setYear($0) })) {
                // Until the first report says which years there are.
                if model.years.isEmpty { Text("Newest").tag(TaxYear.latest) }
                ForEach(model.years, id: \.self) { Text(verbatim: String($0)).tag(TaxYear.year($0)) }
                Text("All years").tag(TaxYear.all)
            }
            Picker("Country", selection: Binding(get: { model.country }, set: { model.setCountry($0) })) {
                ForEach(TaxCountry.allCases) { Text($0.name).tag($0) }
            }
            Picker(Wording.methodName, selection: Binding(get: { model.method }, set: { model.setMethod($0) })) {
                ForEach(CostMethod.allCases) { Text($0.label + defaultTag($0 == model.country.defaultMethod)).tag($0) }
            }
            Picker("Wallets", selection: Binding(get: { model.scope }, set: { model.setScope($0) })) {
                ForEach(TaxScope.allCases) { Text($0.label + defaultTag($0 == model.country.defaultScope)).tag($0) }
            }
        } footer: {
            if let methodNote {
                Text(methodNote)
                    .font(.callout)
                    .secondaryText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        if store.address != WalletAddress.demo {
            Section {
                ForEach(model.otherWallets, id: \.self) { otherWalletRow($0) }
                AddressField(
                    "Add a wallet",
                    prompt: wallets.isEmpty ? "Paste an address" : "Paste an address, or find a wallet",
                    text: $addingWallet,
                    wallets: wallets.filter { model.offers($0, showing: reportAddress, linked: reportLinked) },
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

    /// Overview's numbers and this report's can differ only through this, so it says so and why.
    private var methodNote: String? {
        guard model.method != store.method else { return nil }
        let overview = "Overview uses \(store.method.label)"
        if model.method == model.country.defaultMethod {
            return "\(overview), but \(model.country.rules) call for \(model.method.label), so this report uses that. Its gains can differ from Overview's."
        }
        return "\(overview), and you chose \(model.method.label) here, so its gains can differ from Overview's."
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
            if let partialYear = report.partialYear {
                WarningText(partialYear)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // Each with its label, as one thing to read. Combining them would keep only the label.
            countRow("Sales", report.soldCount)
            countRow(Wording.networkFees, report.feeCount)
            if report.sentCount > 0 {
                countRow("Sent to other addresses", report.sentCount)
            }
            LabeledContent("Total gain") {
                if let gain = report.gainMicros {
                    LiveNumber(Format.signedMoney(gain, report.currency), tone: Tone(signed: gain))
                } else {
                    WarningText("Unknown")
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Spoken.number("Total gain", report.gainMicros.map { Format.signedMoney($0, report.currency) }))
            if report.unresolvedCount > 0 { unknownRow(report) }
        } header: {
            Text(report.year.map { "In \(String($0))" } ?? "In all years")
        }
        previewSection(report)
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

    private func countRow(_ label: String, _ count: Int) -> some View {
        LabeledContent(label) { Text(Format.block(count)).monospacedDigit() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(label), \(Format.block(count))")
    }

    /// What's unknown is never in the total, so this says how much is left out, and where to fix it.
    private func unknownRow(_ report: TaxReport) -> some View {
        let count = report.unknownCount
        let text = count == report.eventCount
            ? (count == 1 ? "Its gain is unknown, in whole or in part." : "All \(Format.block(count)) have an unknown gain, in whole or in part.")
            : "\(Format.block(count)) of these \(Format.block(report.eventCount)) \(count == 1 ? "has" : "have") an unknown gain, in whole or in part. What's unknown is left out of the total."
        return VStack(alignment: .leading, spacing: 8) {
            WarningText(text)
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            fixButtons(report)
        }
    }

    /// One for each wallet with something unknown, since its questions are about that wallet. The one showing works like
    /// Overview's: answer what the app can't work out, or see why when there's nothing to answer.
    @ViewBuilder
    private func fixButtons(_ report: TaxReport) -> some View {
        let buttons = report.unknownWallets.compactMap(fixButton)
        if !buttons.isEmpty {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) { ForEach(buttons.indices, id: \.self) { buttons[$0] } }
                VStack(alignment: .leading, spacing: 8) { ForEach(buttons.indices, id: \.self) { buttons[$0] } }
            }
        }
    }

    private func fixButton(_ wallet: String) -> AnyView? {
        guard wallet == store.address else {
            guard let onResolve else { return nil }
            let name = wallets.first { $0.address == wallet }?.title ?? Format.shortHash(wallet)
            return AnyView(
                Button("Answer for \(name)") { onResolve(wallet) }
                    .fixedSize()
                    .help("Shows this wallet's questions, then comes back here")
            )
        }
        guard let portfolio = store.portfolio else { return nil }
        if !portfolio.questions.isEmpty, let onResolve {
            return AnyView(
                Button(Wording.answerQuestions(portfolio.questions.count)) { onResolve(wallet) }
                    .fixedSize()
                    .help("Answer what the app can't work out by itself (⇧⌘R)")
            )
        }
        if portfolio.attention != nil, let onOpen {
            return AnyView(Button("See Why") { onOpen(portfolio.attentionTarget) }.fixedSize())
        }
        return nil
    }

    private func previewSection(_ report: TaxReport) -> some View {
        Section {
            if report.preview.isEmpty {
                Text(report.year.map { "Nothing to report in \(String($0))." } ?? "Nothing to report.")
                    .secondaryText()
            }
            ForEach(Array(report.preview.enumerated()), id: \.offset) { _, row in
                previewRow(row, currency: report.currency)
            }
        } header: {
            Text("First rows of the file")
        } footer: {
            if report.rowCount > report.preview.count {
                Text("And \(Format.block(report.rowCount - report.preview.count)) more in the file.")
                    .font(.callout)
                    .secondaryText()
            }
        }
    }

    private func previewRow(_ row: TaxPreviewRow, currency: CurrencyCode) -> some View {
        let amount = "\(Format.amount(row.amount, decimals: row.decimals)) \(row.asset)"
        let title = row.type == "Network fee" ? "Network fee, \(amount)" : "\(row.type) \(amount)"
        let date = parseTimestamp(row.timestamp).map { Format.utcDateTime($0) }
        return LabeledContent {
            if let gain = row.gainMicros {
                Text(Format.signedMoney(gain, currency))
                    .monospacedDigit()
                    .foregroundStyle(Tone(signed: gain).style)
            } else {
                WarningText("Unknown gain")
            }
        } label: {
            Text(title)
            if let date {
                Text(date)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Spoken.number([title, date, "gain"].compactMap(\.self).joined(separator: ", "), row.gainMicros.map { Format.signedMoney($0, currency) }))
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
