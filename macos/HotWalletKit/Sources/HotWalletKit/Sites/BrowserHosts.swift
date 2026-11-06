#if os(macOS)
import Foundation

/// Tells each Chromium browser on this Mac where the extension's native messaging host is, for a copy of the app someone installed.
/// `macos/install-bridge.sh` does this for `pnpm mac`. Only the extension with this ID can start the host.
public enum BrowserHosts {
    static let name = "com.benface.patina"
    static let extensionID = "bidkgdhmaoccbkcccmijbppcfeicbllh"
    /// Tells a manifest an installed copy wrote from `macos/install-bridge.sh`'s, which belongs to someone's `pnpm mac` and stays as it is.
    static let description = "Connects the extension to the installed Patina app"
    /// `macos/Config/Hosted.entitlements` allows these and no others, and a test keeps the two the same.
    static let browsers = [
        "Google/Chrome", "Google/Chrome Beta", "Google/Chrome Dev", "Google/Chrome Canary", "Chromium",
        "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data", "Dia/User Data", "Vivaldi",
    ]

    /// Gone when the disk image is ejected, or when macOS stops running it from a temporary copy once it's been moved.
    static func isInstalled(appPath: String) -> Bool {
        !appPath.hasPrefix("/Volumes/") && !appPath.contains("/AppTranslocation/")
    }

    static func manifest(host: String) throws -> Data {
        let fields: [String: Any] = [
            "name": name,
            "description": description,
            "path": host,
            "type": "stdio",
            "allowed_origins": ["chrome-extension://\(extensionID)/"],
        ]
        return try JSONSerialization.data(withJSONObject: fields, options: [.prettyPrinted, .sortedKeys])
    }

    /// Nothing there yet, or what an earlier copy wrote, which may name somewhere it's since been moved from. Anything else is someone else's.
    static func shouldReplace(_ existing: Data?) -> Bool {
        guard let existing else { return true }
        let fields = (try? JSONSerialization.jsonObject(with: existing)) as? [String: Any]
        return fields?["description"] as? String == description
    }

    /// What this can't do, it skips: a browser that isn't on this Mac has no folder to add to, and the extension says so if it can't reach the app.
    public static func install(app: URL, home: URL? = nil) {
        guard isInstalled(appPath: app.path), let home = home ?? realHome else { return }
        let host = app.appending(path: "Contents/Helpers/pricetag-bridge").path
        guard let manifest = try? manifest(host: host) else { return }
        for browser in browsers {
            let folder = home.appending(path: "Library/Application Support/\(browser)/NativeMessagingHosts")
            // One level only: without the browser's own folder, it isn't here.
            try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
            let file = folder.appending(path: "\(name).json")
            guard shouldReplace(try? Data(contentsOf: file)) else { continue }
            // Not atomic: the sandbox allows this one file, and no temporary one beside it.
            try? manifest.write(to: file)
        }
    }

    /// Inside the sandbox, NSHomeDirectory() is the app's own container.
    private static var realHome: URL? {
        getpwuid(getuid())?.pointee.pw_dir.map { URL(fileURLWithPath: String(cString: $0)) }
    }
}
#endif
