import SwiftUI
import UniformTypeIdentifiers

/// Answering questions: one card at a time, with swipes, keys or taps. Each answer shows what it does before you pick it, and Undo is
/// always there. Skipping is always allowed, and what's skipped stays flagged.
public struct ResolveFlow: View {
    let store: PortfolioStore
    let publishFromDevice: ((URL) -> AnyView)?
    private let firstRun: FirstRun
    /// The question that says why it's asking. The next one gets on with it.
    @State private var firstQuestion: String?
    @State private var model: ResolveModel
    @State private var drag: CGSize = .zero
    @State private var costs: [String: String] = [:]
    @State private var isImporting = false
    @State private var publishing: CostNoteDraft?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.walletNames) private var walletNames
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @FocusState private var isFocused: Bool
    @FocusState private var focusedCost: String?

    /// `publishFromDevice` is what opens that page, which takes knowing the browsers on this computer.
    public init(store: PortfolioStore, firstAsset: String? = nil, noteWriter: (any CostNoteWriter)? = nil, firstRun: FirstRun = .finished, publishFromDevice: ((URL) -> AnyView)? = nil) {
        self.store = store
        self.firstRun = firstRun
        self.publishFromDevice = publishFromDevice
        _model = State(initialValue: ResolveModel(store: store, firstAsset: firstAsset, noteWriter: noteWriter))
    }

    /// With questions already dealt with, to show where that leads.
    public init(store: PortfolioStore, model: ResolveModel, firstRun: FirstRun = .finished) {
        self.store = store
        self.firstRun = firstRun
        publishFromDevice = nil
        _model = State(initialValue: model)
    }

    private static let swipeDistance: CGFloat = 110

    public var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header
            Group {
                if let question = model.current {
                    if question.kind == .cost || model.isAskingCost || question.needsCost {
                        costCard(question)
                    } else {
                        senderCard(question)
                    }
                } else {
                    finish
                }
            }
            .frame(maxWidth: .infinity, minHeight: 330, alignment: .top)
            if let imported = model.lastImport {
                let sentence = Wording.imported(found: imported.withdrawals.count, skipped: imported.skipped)
                if imported.needsALook {
                    WarningText(sentence).font(.callout).fixedSize(horizontal: false, vertical: true)
                } else {
                    Text(sentence).font(.callout).secondaryText()
                }
            }
            if let refusal = model.importRefusal {
                WarningText(refusal).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            if let startsAt = model.pendingImport?.startsAt {
                VStack(alignment: .leading, spacing: 8) {
                    Text(Wording.importQuestion).font(.callout.weight(.semibold))
                    Text(Wording.importWhy(startsAt: startsAt)).font(.callout).secondaryText().fixedSize(horizontal: false, vertical: true)
                    HStack {
                        Button("Yes, Use It") { model.keepImport() }
                        Button("No, Don't Use It") { model.declineImport() }
                    }
                }
            }
            footer
        }
        // One question to the next, and the last to the finish, fade rather than swap.
        .motion(Motion.state, value: model.current?.id)
        .padding(20)
        .frame(width: 520)
        .focusable()
        .focusEffectDisabled()
        .focused($isFocused)
        .onAppear {
            isFocused = true
            firstQuestion = model.current?.id
        }
        .onDisappear { firstRun.finishQuestions() }
        .onKeyPress(keys: ["1", "2", "3"]) { press in
            guard let question = model.current, question.kind == .sender, !isTakingCost(question) else { return .ignored }
            let options = model.options
            guard let index = Int(press.characters), options.indices.contains(index - 1) else { return .ignored }
            model.answer(options[index - 1])
            return .handled
        }
        .onKeyPress(.rightArrow) { swipeKey(.mine) }
        .onKeyPress(.upArrow) { swipeKey(.myExchange) }
        .onKeyPress(.leftArrow) { swipeKey(.someoneElse) }
        .onKeyPress(.downArrow) {
            guard let question = model.current, !isTakingCost(question) else { return .ignored }
            model.skip()
            return .handled
        }
        .task(id: "\(model.current?.id ?? "")|\(store.book.hashValue)") {
            costs = [:]
            await model.loadPreviews()
        }
        .task(id: costs) {
            // Waits for a pause in the typing, so each keystroke isn't a request.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.previewCost(costs)
        }
        .sensoryFeedback(.success, trigger: model.isBalanced) { _, balanced in balanced }
        .fileImporter(isPresented: $isImporting, allowedContentTypes: [.commaSeparatedText, .plainText]) { result in
            guard case .success(let url) = result else { return }
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            guard let csv = try? String(contentsOf: url, encoding: .utf8) else {
                model.failure = "Couldn't read that file."
                return
            }
            Task { await _ = model.importCoinbase(csv: csv) }
        }
        .sheet(item: $publishing) { draft in
            PublishCostSheet(draft: draft, currency: store.currency, typed: store.currency == .USD ? costs[draft.asset] ?? "" : "", publish: { await model.publish(draft, usd: $0) }, problem: { model.failure }, isPublishing: { model.isPublishing })
        }
    }

    private func isTakingCost(_ question: Question) -> Bool {
        question.kind == .cost || model.isAskingCost || question.needsCost
    }

    private func swipeKey(_ ownership: Ownership) -> KeyPress.Result {
        guard let question = model.current, question.kind == .sender, !isTakingCost(question) else { return .ignored }
        model.answer(ownership)
        return .handled
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text(headline).font(.sheetTitle)
                Spacer()
                if let meter = model.meter, meter.open > 0 {
                    Text("\(meter.open) left").font(.callout).secondaryText().monospacedDigit().contentTransition(.numericText(value: Double(meter.open))).motion(Motion.number, value: meter.open)
                }
            }
            if firstRun.explainsQuestions, let firstQuestion, firstQuestion == model.current?.id {
                Text(Wording.firstQuestion).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            if let why {
                Text(why).font(.callout).secondaryText().fixedSize(horizontal: false, vertical: true)
            }
            ProgressView(value: model.meter?.progress ?? 0)
                .tint(model.isBalanced ? Tone.gain.color : .accentColor)
                .motion(Motion.state, value: model.meter)
                .accessibilityLabel("Questions, \(model.meter?.open ?? 0) left")
            // At the end, the number takes the middle of the sheet instead.
            if model.current != nil {
                HStack(spacing: 6) {
                    Text("Now").foregroundStyle(.secondary)
                    if let portfolio = store.portfolio {
                        LiveNumber(nowText(portfolio))
                    }
                }
                .font(.callout)
            }
        }
    }

    private var headline: String {
        guard let question = model.current else { return model.isBalanced ? Wording.allAnswered : Wording.nothingLeft }
        return isTakingCost(question) ? Wording.costQuestion : Wording.senderQuestion
    }

    /// Why it's asking, right under the question, so nobody has to guess what an answer is for.
    private var why: String? {
        guard let question = model.current else { return store.hasAnswers ? Wording.answersPlace : nil }
        guard isTakingCost(question) else { return Wording.senderWhy }
        return question.sender == nil ? Wording.costWhy : Wording.exchangeCostWhy
    }

    private func nowText(_ portfolio: Portfolio) -> String {
        guard portfolio.pnlStatus != .unavailable, let pnl = portfolio.totals.pnlMicros else { return Wording.pnlUnavailable }
        let number = Format.estimate(Format.signedMoney(pnl, portfolio.currency), isPositive(portfolio.totals.estimatedMicros))
        return Wording.headlineCaveat(portfolio.totals, portfolio.currency).map { "\(number) · \($0)" } ?? number
    }

    private func arrived(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(question.arrivals) { arrival in
                Text("\(Format.amount(arrival.units, decimals: arrival.decimals)) \(arrival.asset)")
                    .monospacedDigit()
                    .font(.title3.weight(.semibold))
                    .monospacedDigit()
            }
            if let detail = detail(question) {
                Text(detail).font(.callout).secondaryText().textSelection(.enabled)
            }
            ForEach(question.evidence, id: \.self) { fact in
                Label(fact, systemImage: "lightbulb").font(.callout).secondaryText()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// What it can say about where this came from. With no sender, the line under the question already says why it's asked.
    private func detail(_ question: Question) -> String? {
        let transfers = question.transfers == 1 ? "1 transfer" : "\(question.transfers) transfers"
        let elsewhere = store.portfolio?.isAllYours == true
            ? walletNames.walletName(question.wallet)
            : question.wallet != store.portfolio?.address.lowercased() ? "your other wallet \(Format.shortHash(question.wallet))" : nil
        guard let sender = question.sender else { return elsewhere.map { "Arrived in \($0)" } }
        return "From \(Format.shortHash(sender)) · \(transfers)\(elsewhere.map { " · arrived in \($0)" } ?? "")"
    }

    private func senderCard(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            arrived(question)
            VStack(spacing: 8) {
                ForEach(Array(model.options.enumerated()), id: \.element) { index, ownership in
                    answerButton(ownership, key: index + 1)
                }
            }
            if model.previewsAreHeldBack { WarningText(Wording.previewHeldBack).font(.callout).fixedSize(horizontal: false, vertical: true) }
            if let failure = model.failure { WarningText(failure).font(.callout) }
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(alignment: .top) { swipeHint }
        .offset(reduceMotion ? .zero : drag)
        .rotationEffect(reduceMotion ? .zero : .degrees(Double(drag.width) / 40))
        .gesture(
            DragGesture(minimumDistance: 12)
                .onChanged { drag = $0.translation }
                .onEnded { value in
                    defer { withAnimation(reduceMotion ? nil : Motion.state) { drag = .zero } }
                    if value.translation.width > Self.swipeDistance { model.answer(.mine) }
                    else if value.translation.width < -Self.swipeDistance { model.answer(.someoneElse) }
                    else if value.translation.height < -Self.swipeDistance { model.answer(.myExchange) }
                    else if value.translation.height > Self.swipeDistance { model.skip() }
                }
        )
        .id(question.id)
        .transition(reduceMotion ? .opacity : .asymmetric(insertion: .scale(scale: 0.96).combined(with: .opacity), removal: .opacity))
        .motion(Motion.state, value: question.id)
    }

    @ViewBuilder
    private var swipeHint: some View {
        if let hint = dragged {
            Text(hint)
                .font(.callout.weight(.semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 4)
                .background(.regularMaterial, in: Capsule())
                .padding(.top, 6)
        }
    }

    private var dragged: String? {
        if drag.width > 40 { return Ownership.mine.title }
        if drag.width < -40 { return Ownership.someoneElse.title }
        if drag.height < -40, model.options.contains(.myExchange) { return Ownership.myExchange.title }
        if drag.height > 40 { return "Skip" }
        return nil
    }

    private func answerButton(_ ownership: Ownership, key: Int) -> some View {
        Button {
            model.answer(ownership)
        } label: {
            HStack(alignment: .firstTextBaseline) {
                Text(ownership.title).fontWeight(.medium)
                Spacer(minLength: 12)
                Text(consequence(ownership))
                    .font(.callout)
                    .monospacedDigit()
                    .secondaryText()
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                Text("\(key)").font(.caption.monospaced()).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity)
            .contentShape(Rectangle())
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .accessibilityValue(consequence(ownership))
    }

    private func consequence(_ ownership: Ownership) -> String {
        if ownership == .myExchange { return "Then asks what you paid" }
        return model.previews[ownership].map { Wording.consequence($0, store.currency) } ?? "…"
    }

    private func costCard(_ question: Question) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            arrived(question)
            ForEach(question.arrivals) { arrival in
                LabeledContent("Paid for \(Format.amount(arrival.units, decimals: arrival.decimals)) \(arrival.asset), in \(store.currency.rawValue)") {
                    TextField(Format.money("0", store.currency), text: Binding(get: { costs[arrival.asset] ?? "" }, set: { costs[arrival.asset] = $0 }))
                        .textFieldStyle(.roundedBorder)
                        .multilineTextAlignment(.trailing)
                        .frame(width: 140)
                        .focused($focusedCost, equals: arrival.asset)
                        .onSubmit { save(question) }
                }
            }
            if let preview = model.costPreview {
                LabeledContent("That would make it") {
                    Text(Wording.consequence(preview, store.currency)).monospacedDigit().fontWeight(.medium)
                }
                .font(.callout)
            }
            if model.costPreviewIsHeldBack { WarningText(Wording.previewHeldBack).font(.callout).fixedSize(horizontal: false, vertical: true) }
            if let warning = model.costWarning(costs, for: question) {
                WarningText(warning).font(.callout).fixedSize(horizontal: false, vertical: true)
            }
            // Two rows, because all of these on one would cut off their names.
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("Save") { save(question) }
                        .keyboardShortcut(.defaultAction)
                        .disabled(!canSave(question))
                    if let draft = model.noteDraft(for: question) {
                        Button("Publish Onchain…") { publishing = draft }
                            .help("Writes what you paid on Base, where anyone can read it")
                    }
                    if let publishFromDevice, let draft = model.deviceNoteDraft(for: question), let url = DeviceFlow.publish(server: store.serverURL, draft: draft, usd: store.currency == .USD ? costs[draft.asset] : nil) {
                        publishFromDevice(url)
                    }
                }
                if question.sender != nil {
                    HStack {
                        Button("Import Coinbase History…") { isImporting = true }
                        Button("Use the Price When It Arrived") { model.usePriceWhenItArrived() }
                            .help("An estimate, and it's always shown as one")
                    }
                }
            }
            Text("This stays on this Mac.")
                .font(.caption)
                .foregroundStyle(.secondary)
                .help("Publishing a cost onchain would tie your wallets together in public, so that's never done without asking.")
            if let failure = model.failure { WarningText(failure).font(.callout) }
        }
        .padding(16)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .id(question.id)
        .onAppear { focusedCost = question.arrivals.first?.asset }
    }

    private func canSave(_ question: Question) -> Bool {
        question.arrivals.allSatisfy { Format.micros(fromDollars: costs[$0.asset] ?? "", in: store.currency) != nil }
    }

    private func save(_ question: Question) {
        guard canSave(question) else { return }
        model.enterCost(costs)
        costs = [:]
    }

    /// The fun part: the meter's empty, and the number it was all for.
    private var finish: some View {
        VStack(spacing: 14) {
            Image(systemName: model.isBalanced ? "checkmark.seal.fill" : "tray")
                .font(.system(size: 64))
                .foregroundStyle(model.isBalanced ? Tone.gain.style : AnyShapeStyle(.secondary))
                .symbolEffect(.bounce, value: model.isBalanced)
            if let portfolio = store.portfolio {
                finalNumber(portfolio)
                if let excluded = Wording.excluded(portfolio.totals.excluded) {
                    Text(Wording.finishNote(portfolio.meter))
                        .font(.callout)
                        .secondaryText()
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                        .help(excluded)
                }
            }
            if let failed = store.portfolio?.linkedFailed.count, failed > 0 {
                WarningText(Wording.linkedFailed(failed)).font(.callout).fixedSize(horizontal: false, vertical: true)
                Button("Try Again") { store.refresh() }
            }
            if let portfolio = store.portfolio, !portfolio.linkedReading.isEmpty {
                let waiting = portfolio.linkedReading.count
                Text("Still reading your other \(waiting == 1 ? "wallet" : "wallets").")
                    .font(.callout)
                    .secondaryText()
                    .multilineTextAlignment(.center)
            }
            if !model.skipped.isEmpty {
                Text("\(model.skipped.count) skipped").font(.callout).secondaryText()
                Button("Go Back to Them") { model.revisitSkipped() }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Set like the Overview's, because it's the same number, and now it's the one this was for. What it still leaves out is said under it.
    @ViewBuilder
    private func finalNumber(_ portfolio: Portfolio) -> some View {
        VStack(spacing: 4) {
            Text("Total PnL").font(.subheadline).secondaryText()
            if portfolio.pnlStatus != .unavailable, let pnl = portfolio.totals.pnlMicros {
                DisplayNumber(Format.estimate(Format.signedMoney(pnl, portfolio.currency), isPositive(portfolio.totals.estimatedMicros)), size: 40, tone: Tone(signed: pnl))
                if let caveat = Wording.headlineCaveat(portfolio.totals, portfolio.currency) {
                    Text(caveat)
                        .font(.callout)
                        .secondaryText()
                        .monospacedDigit()
                        .multilineTextAlignment(.center)
                }
            } else {
                Text(Wording.pnlUnavailable).font(.displaySmall).secondaryText()
            }
        }
    }

    private var footer: some View {
        HStack {
            Button("Undo") { model.undo() }
                .keyboardShortcut("z", modifiers: .command)
                .disabled(!model.canUndo)
            Spacer()
            if model.current != nil {
                Button("Skip") { model.skip() }
                    .help("Stays flagged. You can come back to it (↓)")
            }
            Button("Done") { dismiss() }
                .keyboardShortcut(.cancelAction)
        }
    }
}
