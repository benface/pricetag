import AppKit
import PricetagKit
import SwiftUI

/// The browsers on this Mac, and opening a page in one. A test scene can say what's there without touching any of it.
struct DeviceBrowsers {
    var choice: () -> LedgerBrowserChoice
    /// With no browser, it's the default.
    var open: (URL, InstalledBrowser?) -> Void

    static let getChrome = URL(string: "https://www.google.com/chrome/")!

    static let real = DeviceBrowsers(
        choice: {
            // Any web address will do, to ask who opens them.
            let page = URL(string: "https://example.com")!
            let browser = { (url: URL) -> InstalledBrowser? in
                guard let id = Bundle(url: url)?.bundleIdentifier else { return nil }
                return InstalledBrowser(bundleID: id, name: FileManager.default.displayName(atPath: url.path(percentEncoded: false)).replacing(".app", with: ""), url: url)
            }
            return LedgerBrowserChoice(defaultBrowser: NSWorkspace.shared.urlForApplication(toOpen: page).flatMap(browser), installed: NSWorkspace.shared.urlsForApplications(toOpen: page).compactMap(browser))
        },
        open: { url, browser in
            if let browser {
                NSWorkspace.shared.open([url], withApplicationAt: browser.url, configuration: NSWorkspace.OpenConfiguration())
            } else {
                NSWorkspace.shared.open(url)
            }
        }
    )
}

extension View {
    func findingBrowsers(_ browsers: DeviceBrowsers, _ found: Binding<LedgerBrowserChoice>) -> some View {
        onAppear { found.wrappedValue = browsers.choice() }
            // Installing one means leaving this app and coming back.
            .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in found.wrappedValue = browsers.choice() }
    }
}

/// Says which browser a device's page opens in. A Keystone works in any of them, so the default stays on offer when it can't reach a Ledger.
struct DeviceBrowserNote: View {
    let choice: LedgerBrowserChoice
    let outcome: String
    /// False while the page isn't ready to be opened.
    var canUseDefault = true
    let useDefault: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(choice.opening(outcome))
                .font(.callout)
                .fixedSize(horizontal: false, vertical: true)
            if let other = choice.defaultForKeystone {
                Button("Use \(other) Instead, for a Keystone", action: useDefault)
                    .buttonStyle(.link)
                    .font(.callout)
                    .disabled(!canUseDefault)
            }
            if let problem = choice.noLedgerBrowser {
                Notice(.warning, problem)
                Link("Get Chrome", destination: DeviceBrowsers.getChrome)
                    .font(.callout)
            }
        }
    }
}

/// Publishing from a device happens on a web page. This says where before going there, since a sheet this full has no room to.
struct PublishFromDeviceButton: View {
    let link: URL
    let browsers: DeviceBrowsers
    @State private var isOffering = false

    var body: some View {
        Button("Publish from Your Device…") { isOffering = true }
            .help("Your hardware wallet signs it in a browser. Anyone can read it after that")
            .popover(isPresented: $isOffering, arrowEdge: .bottom) {
                PublishFromDeviceOffer(link: link, browsers: browsers) { isOffering = false }
            }
    }
}

struct PublishFromDeviceOffer: View {
    let link: URL
    let browsers: DeviceBrowsers
    let done: () -> Void
    @State private var found = LedgerBrowserChoice.unknown

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            DeviceBrowserNote(choice: found, outcome: "your hardware wallet signs this cost. Anyone can read it after that.") { open(in: nil) }
            HStack {
                Spacer()
                Button(found.continueTitle) { open(in: found.browser) }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(16)
        .frame(width: 340)
        .findingBrowsers(browsers, $found)
    }

    private func open(in browser: InstalledBrowser?) {
        browsers.open(link, browser)
        done()
    }
}
