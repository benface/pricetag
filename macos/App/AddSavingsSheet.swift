import AVFoundation
import HotWalletKit
import KeyVault
import PricetagKit
import SwiftUI

/// What the flow needs from this Mac, so a test scene can say what's there without touching any of it.
struct AddSavingsMac {
    var browsers: DeviceBrowsers
    var ledgerWalletIsOpen: () -> Bool
    var scanner: () -> AddressScanner

    static let real = AddSavingsMac(
        browsers: .real,
        ledgerWalletIsOpen: { !NSRunningApplication.runningApplications(withBundleIdentifier: "com.ledger.live").isEmpty },
        scanner: { AddressScanner() }
    )
}

/// The guided way to add a hardware wallet. The Mac app has no device code, so the user is the one who checks the address against
/// the device. That includes one the web app sent over or the camera read, and any other accounts a link names, since anyone can make a link.
struct AddColdWalletSheet: View {
    let navigation: Navigation?
    let server: URL
    let mac: AddSavingsMac
    let showsTrouble: Bool
    var onSendTest: (EthereumAddress) -> Void = { _ in }
    /// Every saved wallet. The paste step offers the ones that could become savings.
    var wallets: [WalletEntry] = []
    @State private var model: AddSavingsModel
    @Environment(\.dismiss) private var dismiss

    init(wallet: HotWallet, wallets: [WalletEntry], navigation: Navigation?, server: URL, onSendTest: @escaping (EthereumAddress) -> Void) {
        self.init(model: AddSavingsModel(wallet: wallet), navigation: navigation, server: server, mac: .real, wallets: wallets)
        self.onSendTest = onSendTest
    }

    init(model: AddSavingsModel, navigation: Navigation? = nil, server: URL, mac: AddSavingsMac, showsTrouble: Bool = false, wallets: [WalletEntry] = []) {
        _model = State(initialValue: model)
        self.wallets = wallets
        self.navigation = navigation
        self.server = server
        self.mac = mac
        self.showsTrouble = showsTrouble
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            content
                .frame(maxHeight: .infinity, alignment: .top)
            buttons
        }
        .padding(20)
        .frame(width: 460)
        .frame(minHeight: 400)
        .onChange(of: navigation?.addingSavings, initial: true) { _, link in
            guard let link else { return }
            navigation?.addingSavings = nil
            model.receive(link)
        }
    }

    private var page: AddSavingsWording.Page { AddSavingsWording.page(model.step, device: model.device) }

    @ViewBuilder
    private var content: some View {
        switch model.step {
        case .pick: PickDevice(model: model)
        case .ledgerPlugIn: StepPage(page: page, picture: .ledger(screen: "Enter PIN"), model: model, showsTrouble: showsTrouble)
        case .ledgerApp: StepPage(page: page, picture: .ledger(screen: "Ethereum\napp is ready"), model: model, showsTrouble: showsTrouble)
        case .ledgerQuit: LedgerQuitStep(page: page, model: model, isOpen: mac.ledgerWalletIsOpen)
        case .ledgerBrowser: LedgerBrowserStep(page: page, model: model, server: server, showsTrouble: showsTrouble, browsers: mac.browsers, open: { browser in
            if let link = DeviceFlow.addSavingsFromLedger(server: server) { mac.browsers.open(link, browser) }
        })
        case .keystoneUnlock: StepPage(page: page, picture: .keystone(showsCode: false), model: model, showsTrouble: showsTrouble)
        case .keystoneReceive: StepPage(page: page, picture: .keystone(showsCode: true), model: model, showsTrouble: showsTrouble)
        case .keystoneScan: KeystoneScanStep(page: page, model: model, scanner: mac.scanner, showsTrouble: showsTrouble)
        case .paste: PasteStep(page: page, model: model, wallets: wallets.filter(model.offers))
        case .check: CheckStep(page: page, model: model, showsTrouble: showsTrouble)
        case .finished: FinishedStep(model: model)
        }
    }

    private var buttons: some View {
        HStack {
            if model.canGoBack {
                Button("Back") { model.back() }
                    .disabled(model.isAdding)
            }
            Spacer()
            if model.step != .finished {
                Button("Cancel", role: .cancel) { dismiss() }
                    .keyboardShortcut(.cancelAction)
                    .disabled(model.isAdding)
            }
            switch model.step {
            case .pick, .keystoneScan: EmptyView()
            case .ledgerBrowser: EmptyView()
            case .paste:
                Button("Next") { model.next() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(model.parsed == nil)
            case .check:
                Button("Add Wallet") {
                    // Everything that can stop this is already shown on the page.
                    Task { try? await model.add() }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(!model.canAdd || model.isAdding)
            case .finished:
                if model.canSendTest, let added = model.added {
                    Button("Send a Small Test…") {
                        onSendTest(added)
                        dismiss()
                    }
                }
                Button("Done") { dismiss() }
                    .keyboardShortcut(.defaultAction)
            default:
                Button("Next") { model.next() }
                    .keyboardShortcut(.defaultAction)
            }
        }
    }
}

private struct PickDevice: View {
    let model: AddSavingsModel

    var body: some View {
        let page = AddSavingsWording.page(.pick, device: nil)
        VStack(alignment: .leading, spacing: 12) {
            Text(page.title)
                .font(.sheetTitle)
            Text(page.body)
                .fixedSize(horizontal: false, vertical: true)
            ForEach(AddSavingsModel.Device.allCases, id: \.self) { device in
                Button { model.choose(device) } label: {
                    HStack(spacing: 14) {
                        DevicePicture(device.picture, scale: 0.5)
                            .frame(width: 96, height: 56)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(device.title)
                                .font(.headline)
                            Text(AddSavingsWording.deviceSubtitle(device))
                                .font(.callout)
                                .secondaryText()
                        }
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.tertiary)
                    }
                    .padding(10)
                    .contentShape(Rectangle())
                    .softBox()
                }
                .buttonStyle(.plain)
            }
            Label(AddSavingsWording.neverAsked, systemImage: "lock.shield")
                .font(.callout)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private extension AddSavingsModel.Device {
    var title: String {
        switch self {
        case .ledger: "Ledger"
        case .keystone: "Keystone"
        case .other: "Another wallet"
        }
    }

    var picture: DevicePicture.Kind {
        switch self {
        case .ledger: .ledger(screen: "Ethereum")
        case .keystone: .keystone(showsCode: true)
        case .other: .other
        }
    }
}

/// One step: a picture of what the device should look like, a line or two on what to do, and what to do if it doesn't.
private struct StepPage<Extra: View>: View {
    let page: AddSavingsWording.Page
    var picture: DevicePicture.Kind?
    let model: AddSavingsModel
    var showsTrouble = false
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let progress = model.progress {
                StepDots(current: progress.current, total: progress.total)
            }
            if let picture {
                DevicePicture(picture)
                    .stepPicture()
            }
            Text(page.title)
                .font(.sheetTitle)
            if !page.body.isEmpty {
                Text(page.body)
                    .fixedSize(horizontal: false, vertical: true)
            }
            extra()
            TroubleList(troubles: page.troubles, isExpanded: showsTrouble)
        }
    }
}

extension StepPage where Extra == EmptyView {
    init(page: AddSavingsWording.Page, picture: DevicePicture.Kind?, model: AddSavingsModel, showsTrouble: Bool = false) {
        self.init(page: page, picture: picture, model: model, showsTrouble: showsTrouble) { EmptyView() }
    }
}

private struct StepDots: View {
    let current: Int
    let total: Int
    static let height: CGFloat = 7

    var body: some View {
        HStack(spacing: 5) {
            ForEach(0..<total, id: \.self) { index in
                Circle()
                    .fill(index <= current ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary))
                    .frame(width: Self.height, height: Self.height)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Step \(current + 1) of \(total)")
    }
}

extension View {
    /// The same room for every step's picture, whether it's a device or a symbol, so titles land in the same place from one step to the next.
    /// Keystone's is taller, and stays taller across its own steps.
    fileprivate func stepPicture() -> some View {
        frame(maxWidth: .infinity, minHeight: 76)
    }
}

private struct TroubleList: View {
    let troubles: [AddSavingsWording.Trouble]
    @State private var isExpanded: Bool

    init(troubles: [AddSavingsWording.Trouble], isExpanded: Bool) {
        self.troubles = troubles
        _isExpanded = State(initialValue: isExpanded)
    }

    var body: some View {
        if !troubles.isEmpty {
            DisclosureGroup("Not what you see?", isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(troubles, id: \.when) { trouble in
                        VStack(alignment: .leading, spacing: 1) {
                            Text(trouble.when).fontWeight(.medium)
                            Text(trouble.then).secondaryText()
                        }
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .font(.callout)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 6)
            }
        }
    }
}

private struct LedgerQuitStep: View {
    let page: AddSavingsWording.Page
    let model: AddSavingsModel
    let isOpen: () -> Bool
    @State private var isStillOpen = false

    var body: some View {
        StepPage(page: page, picture: .ledger(screen: "Ethereum\napp is ready"), model: model) {
            if isStillOpen {
                Notice(.warning, "Ledger Wallet is still open.")
            } else {
                Label("It's closed.", systemImage: "checkmark.circle.fill")
                    .font(.callout)
                    .secondaryText()
            }
        }
        .onAppear { isStillOpen = isOpen() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didTerminateApplicationNotification)) { _ in isStillOpen = isOpen() }
        .onReceive(NSWorkspace.shared.notificationCenter.publisher(for: NSWorkspace.didLaunchApplicationNotification)) { _ in isStillOpen = isOpen() }
    }
}

private struct LedgerBrowserStep: View {
    let page: AddSavingsWording.Page
    let model: AddSavingsModel
    let server: URL
    let showsTrouble: Bool
    let browsers: DeviceBrowsers
    let open: (InstalledBrowser?) -> Void
    @State private var found = LedgerBrowserChoice.unknown

    var body: some View {
        Group {
            if model.isWaitingForBrowser, let browser = found.browser {
                waiting(browser)
            } else {
                offer
            }
        }
        .findingBrowsers(browsers, $found)
    }

    private var offer: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let progress = model.progress {
                StepDots(current: progress.current, total: progress.total)
            }
            Image(systemName: "safari")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.secondary)
                .stepPicture()
                .accessibilityHidden(true)
            Text(found.browser.map { "Continue in \($0.name)" } ?? page.title)
                .font(.sheetTitle)
            if let browser = found.browser {
                Text(AddSavingsWording.browserBody(browser.name, defaultThatCant: found.defaultThatCant))
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open \(browser.name)") {
                    open(browser)
                    model.wentToBrowser()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
            } else {
                Notice(.warning, AddSavingsWording.noBrowser(found.defaultThatCant))
                Link("Get Chrome", destination: DeviceBrowsers.getChrome)
            }
            Button("Paste an Address Instead") { model.enterByHand() }
                .buttonStyle(.link)
            TroubleList(troubles: page.troubles, isExpanded: showsTrouble)
        }
    }

    private func waiting(_ browser: InstalledBrowser) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let progress = model.progress {
                StepDots(current: progress.current, total: progress.total)
            }
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                Text("Finish in \(browser.name)")
                    .font(.sheetTitle)
            }
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(AddSavingsWording.browserSteps(browser.name).enumerated()), id: \.offset) { index, line in
                    Label(line, systemImage: "\(index + 1).circle")
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Text("This page moves on by itself when the address arrives.")
                .font(.callout)
                .secondaryText()
            Button("Open \(browser.name) Again") { open(browser) }
            TroubleList(troubles: AddSavingsWording.browserTroubles(server: server), isExpanded: showsTrouble)
        }
    }
}

private struct KeystoneScanStep: View {
    let page: AddSavingsWording.Page
    let model: AddSavingsModel
    let scanner: () -> AddressScanner
    let showsTrouble: Bool
    @State private var camera: AddressScanner?

    /// Holding it up to a camera only makes sense with one that's working.
    private var shown: AddSavingsWording.Page {
        camera?.state == .denied || camera?.state == .noCamera || camera?.state == .failed ? AddSavingsWording.Page(title: AddSavingsWording.noCamera, body: "") : page
    }

    var body: some View {
        StepPage(page: shown, picture: nil, model: model, showsTrouble: showsTrouble) {
            if let camera {
                switch camera.state {
                case .starting, .running:
                    CameraPreview(scanner: camera)
                        .frame(height: 210)
                        .overlay {
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .strokeBorder(.white.opacity(0.8), style: StrokeStyle(lineWidth: 2, dash: [10, 8]))
                                .frame(width: 150, height: 150)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    Text(AddSavingsWording.camera)
                        .font(.caption)
                        .secondaryText()
                    if let problem = model.scanProblem {
                        WarningText(problem).font(.callout)
                    }
                case .denied:
                    Notice(.warning, "This app isn't allowed to use your camera. You can turn that on in System Settings, or type the address yourself.")
                    Link("Open Camera Settings", destination: URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Camera")!)
                case .noCamera:
                    Notice(.info, "This Mac doesn't have a camera it can use. You can type the address yourself.")
                case .failed:
                    Notice(.warning, "The camera didn't start. Close anything else that's using it, or type the address yourself.")
                }
            }
            Button("Type the Address Instead") { model.enterByHand() }
                .buttonStyle(.link)
        }
        .task {
            let camera = scanner()
            self.camera = camera
            await camera.start { model.read($0) }
        }
        .onDisappear { camera?.stop() }
    }
}

private struct PasteStep: View {
    let page: AddSavingsWording.Page
    @Bindable var model: AddSavingsModel
    let wallets: [WalletEntry]

    var body: some View {
        StepPage(page: page, picture: model.device?.picture, model: model) {
            // Picking only fills this in. The next page still has the user check it against the device, whatever it's called here.
            AddressField(prompt: "0x…", text: $model.address, wallets: wallets, read: AddressText.read)
        }
    }
}

private struct CheckStep: View {
    let page: AddSavingsWording.Page
    @Bindable var model: AddSavingsModel
    let showsTrouble: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let progress = model.progress {
                StepDots(current: progress.current, total: progress.total)
            }
            Text(page.title)
                .font(.sheetTitle)
            Text(page.body)
                .fixedSize(horizontal: false, vertical: true)
            if let parsed = model.parsed {
                // In groups, because nobody really compares 40 characters in one run.
                AddressLine(parsed.checksummed)
                    .font(.title3)
                    .textSelection(.enabled)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            }
            if model.parsed == nil {
                // A link can say anything, and there's nothing here to compare.
                WarningText("That isn't a valid address. Press Cancel, and don't send anything.").font(.callout)
            } else if let problem = model.problem {
                WarningText(problem).font(.callout)
            } else {
                if let notice = model.sweepNotice {
                    Notice(model.wouldStartSweeps ? .warning : .info, notice)
                }
                if let problem = model.addProblem {
                    WarningText(problem).font(.callout)
                }
                Toggle(AddSavingsWording.matches, isOn: $model.matches)
                // Outside a form, a text field doesn't show its label.
                LabeledContent("Name") {
                    TextField("Name", text: $model.name, prompt: Text("Savings"))
                        .labelsHidden()
                }
            }
            Text(AddSavingsWording.checkWarning)
                .font(.caption)
                .secondaryText()
                .fixedSize(horizontal: false, vertical: true)
            if !model.suggestedAccounts.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("This link also names other accounts. Tick the ones you know are yours.")
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                    ForEach(model.suggestedAccounts, id: \.self) { account in
                        Toggle(isOn: accepted(account)) {
                            AddressLine(EthereumAddress(account)?.checksummed ?? account)
                                .font(.subheadline)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                    Text("Costs will follow what moves to and from the ones you tick, and no money is sent there. Leave out any you don't recognize.")
                        .font(.caption)
                        .secondaryText()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            TroubleList(troubles: page.troubles, isExpanded: showsTrouble)
        }
    }

    private func accepted(_ account: String) -> Binding<Bool> {
        Binding {
            model.acceptedAccounts.contains(account)
        } set: { isAccepted in
            if isAccepted { model.acceptedAccounts.insert(account) } else { model.acceptedAccounts.remove(account) }
        }
    }
}

private struct FinishedStep: View {
    let model: AddSavingsModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Where the steps' dots were, so the title stays where every step had it.
            Color.clear.frame(height: StepDots.height)
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 44))
                .foregroundStyle(Tone.gain.style)
                .stepPicture()
                .accessibilityHidden(true)
            Text(AddSavingsWording.page(.finished, device: model.device).title)
                .font(.sheetTitle)
            if model.sweepsGoHere {
                Label(model.mayBeSweeping ? AddSavingsWording.sweepsStarted : "From now on, money above your cap goes here.", systemImage: "arrow.down.to.line")
                    .fixedSize(horizontal: false, vertical: true)
            } else {
                Label("Money above your cap still goes to \(model.sweepDestinationName ?? "your other savings wallet").", systemImage: "arrow.down.to.line")
                    .fixedSize(horizontal: false, vertical: true)
                Button("Send It Here Instead") { Task { await model.sweepHere() } }
            }
            Label(model.mayBeSweeping ? AddSavingsWording.testAfterSweep : AddSavingsWording.testFirst, systemImage: "testtube.2")
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// A simple drawing of each device, in nobody's trademark. The screen says what the real one should.
struct DevicePicture: View {
    enum Kind: Equatable {
        case ledger(screen: String)
        case keystone(showsCode: Bool)
        case other
    }

    let kind: Kind
    var scale = 1.0

    init(_ kind: Kind, scale: Double = 1) {
        self.kind = kind
        self.scale = scale
    }

    private let body1 = Color(white: 0.2)

    var body: some View {
        Group {
            switch kind {
            case .ledger(let screen): ledger(screen)
            case .keystone(let showsCode): keystone(showsCode)
            case .other:
                Image(systemName: "wallet.bifold")
                    .font(.system(size: 56 * scale, weight: .light))
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityHidden(true)
    }

    private func ledger(_ screen: String) -> some View {
        ZStack(alignment: .top) {
            HStack(spacing: 72 * scale) {
                Capsule().fill(Color(white: 0.55)).frame(width: 16 * scale, height: 5 * scale)
                Capsule().fill(Color(white: 0.55)).frame(width: 16 * scale, height: 5 * scale)
            }
            RoundedRectangle(cornerRadius: 12 * scale, style: .continuous)
                .fill(body1)
                .overlay(RoundedRectangle(cornerRadius: 12 * scale, style: .continuous).stroke(.white.opacity(0.18), lineWidth: 1))
                .overlay {
                    RoundedRectangle(cornerRadius: 4 * scale, style: .continuous)
                        .fill(.black)
                        .frame(width: 112 * scale, height: 44 * scale)
                        .overlay {
                            Text(screen)
                                .font(.system(size: 11 * scale, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white)
                                .multilineTextAlignment(.center)
                                .minimumScaleFactor(0.6)
                        }
                }
                .frame(width: 184 * scale, height: 64 * scale)
                .padding(.top, 3 * scale)
        }
    }

    private func keystone(_ showsCode: Bool) -> some View {
        RoundedRectangle(cornerRadius: 12 * scale, style: .continuous)
            .fill(body1)
            .overlay(RoundedRectangle(cornerRadius: 12 * scale, style: .continuous).stroke(.white.opacity(0.18), lineWidth: 1))
            .overlay {
                RoundedRectangle(cornerRadius: 6 * scale, style: .continuous)
                    .fill(.black)
                    .padding(6 * scale)
                    .overlay {
                        if showsCode {
                            VStack(spacing: 5 * scale) {
                                Text("Receive ETH")
                                    .font(.system(size: 8 * scale, weight: .semibold))
                                    .foregroundStyle(.white)
                                CodePattern()
                                    .frame(width: 58 * scale, height: 58 * scale)
                            }
                        } else {
                            Image(systemName: "lock")
                                .font(.system(size: 20 * scale))
                                .foregroundStyle(.white)
                        }
                    }
            }
            .frame(width: 84 * scale, height: 112 * scale)
    }
}

/// Looks like a code from a distance. It has none of what makes one readable, so a camera can't mistake this for the real thing.
private struct CodePattern: View {
    private let rows = [0b1101001, 0b0110110, 0b1010011, 0b0011101, 0b1100100, 0b0101011, 0b1001110]

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.white))
            let cell = size.width / 9
            for (y, row) in rows.enumerated() {
                for x in 0..<7 where row >> x & 1 == 1 {
                    context.fill(Path(CGRect(x: cell * Double(x + 1), y: cell * Double(y + 1), width: cell, height: cell)), with: .color(.black))
                }
            }
        }
    }
}

/// Reads addresses from the camera. Frames stay in memory for as long as it takes to look at them, and only the text of a code leaves here.
@MainActor
@Observable
final class AddressScanner {
    enum State: Equatable { case starting, running, denied, noCamera, failed }

    private(set) var state: State
    let session = AVCaptureSession()
    private let isFixture: Bool
    private var reader: FrameReader?
    /// The permission prompt can outlast the sheet, and the camera mustn't come on after that.
    private var isStopped = false

    init() {
        state = .starting
        isFixture = false
    }

    /// Never asks for the camera, so a test scene can't either.
    init(fixed state: State) {
        self.state = state
        isFixture = true
    }

    var isLive: Bool { !isFixture }

    func start(onRead: @escaping @MainActor (String) -> Void) async {
        guard !isFixture else { return }
        guard let camera = AVCaptureDevice.default(for: .video) else {
            state = .noCamera
            return
        }
        let allowed = await AVCaptureDevice.requestAccess(for: .video)
        guard !isStopped else { return }
        guard allowed else {
            state = .denied
            return
        }
        let reader = FrameReader(onRead: onRead)
        self.reader = reader
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(reader, queue: reader.queue)
        session.beginConfiguration()
        session.sessionPreset = .high
        guard let input = try? AVCaptureDeviceInput(device: camera), session.canAddInput(input), session.canAddOutput(output) else {
            session.commitConfiguration()
            state = .failed
            return
        }
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        nonisolated(unsafe) let session = session
        reader.queue.async { session.startRunning() }
        state = .running
    }

    func stop() {
        guard !isFixture else { return }
        isStopped = true
        nonisolated(unsafe) let session = session
        reader?.queue.async { session.stopRunning() }
    }
}

private nonisolated final class FrameReader: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "add-savings.camera")
    private let onRead: @MainActor (String) -> Void
    /// Only touched on `queue`.
    private var isReading = false

    init(onRead: @escaping @MainActor (String) -> Void) {
        self.onRead = onRead
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard !isReading, let frame = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        isReading = true
        nonisolated(unsafe) let held = frame
        Task {
            let texts = await QRCodeReader.read(held)
            for text in texts { await onRead(text) }
            queue.async { self.isReading = false }
        }
    }
}

private struct CameraPreview: NSViewRepresentable {
    let scanner: AddressScanner

    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.wantsLayer = true
        view.layer?.backgroundColor = NSColor.black.cgColor
        if scanner.isLive {
            let preview = AVCaptureVideoPreviewLayer(session: scanner.session)
            preview.videoGravity = .resizeAspectFill
            preview.autoresizingMask = [.layerWidthSizable, .layerHeightSizable]
            view.layer?.addSublayer(preview)
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}
}
