#if os(macOS)
import Foundation
import Testing

@testable import HotWalletKit

@Suite struct BrowserHostsTests {
    private func home() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appending(path: "browser-hosts-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func manifest(_ home: URL, _ browser: String) -> URL {
        home.appending(path: "Library/Application Support/\(browser)/NativeMessagingHosts/com.benface.patina.json")
    }

    private func make(_ home: URL, browser: String) throws {
        try FileManager.default.createDirectory(at: home.appending(path: "Library/Application Support/\(browser)"), withIntermediateDirectories: true)
    }

    private let app = URL(fileURLWithPath: "/Applications/Patina.app")

    @Test func namesTheHostInsideTheAppForTheOneExtension() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try make(home, browser: "Google/Chrome")
        BrowserHosts.install(app: app, home: home)
        let fields = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: manifest(home, "Google/Chrome"))) as? [String: Any])
        #expect(fields["name"] as? String == "com.benface.patina")
        #expect(fields["path"] as? String == "/Applications/Patina.app/Contents/Helpers/pricetag-bridge")
        #expect(fields["type"] as? String == "stdio")
        #expect(fields["allowed_origins"] as? [String] == ["chrome-extension://bidkgdhmaoccbkcccmijbppcfeicbllh/"])
    }

    @Test func aBrowserThatIsntHereIsLeftOut() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        BrowserHosts.install(app: app, home: home)
        #expect(!FileManager.default.fileExists(atPath: home.appending(path: "Library/Application Support/Google").path))
    }

    /// `pnpm mac` wrote this one, and the app it names is the one that person's using.
    @Test func leavesAManifestItDidntWriteAlone() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try make(home, browser: "Google/Chrome")
        let file = manifest(home, "Google/Chrome")
        try FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        let theirs = Data(#"{"description":"Connects the extension to the Mac app","path":"/somewhere/else"}"#.utf8)
        try theirs.write(to: file)
        BrowserHosts.install(app: app, home: home)
        #expect(try Data(contentsOf: file) == theirs)
    }

    @Test func followsTheAppWhenItMoves() throws {
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try make(home, browser: "Google/Chrome")
        BrowserHosts.install(app: app, home: home)
        BrowserHosts.install(app: home.appending(path: "Applications/Patina.app"), home: home)
        let fields = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: manifest(home, "Google/Chrome"))) as? [String: Any])
        #expect((fields["path"] as? String)?.hasPrefix(home.path) == true)
    }

    @Test func aCopyStillOnTheDiskImageOrTranslocatedInstallsNothing() throws {
        #expect(!BrowserHosts.isInstalled(appPath: "/Volumes/Patina/Patina.app"))
        #expect(!BrowserHosts.isInstalled(appPath: "/private/var/folders/x/AppTranslocation/ABC/d/Patina.app"))
        #expect(BrowserHosts.isInstalled(appPath: "/Applications/Patina.app"))
        let home = try home()
        defer { try? FileManager.default.removeItem(at: home) }
        try make(home, browser: "Google/Chrome")
        BrowserHosts.install(app: URL(fileURLWithPath: "/Volumes/Patina/Patina.app"), home: home)
        #expect(!FileManager.default.fileExists(atPath: manifest(home, "Google/Chrome").path))
    }
}
#endif
