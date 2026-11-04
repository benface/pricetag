import Foundation

// The browser starts this when the extension connects, and it relays bytes between the browser and the running app. That's all it
// does: it holds no keys, reads none of what goes through it, and can't reach the Keychain. Sites can't reach it. Only the extension can,
// because of `allowed_origins` in its native messaging manifest, which `macos/install-bridge.sh` writes.

/// Chrome passes the caller's origin as the first argument.
let extensionOrigin = "chrome-extension://bidkgdhmaoccbkcccmijbppcfeicbllh/"

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data("\(message)\n".utf8))
    exit(1)
}

guard CommandLine.arguments.dropFirst().first == extensionOrigin else { fail("This only runs for the extension.") }

/// The app this copy is inside: its name/Contents/Helpers/this.
let appURL = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
guard let bundleIdentifier = Bundle(url: appURL)?.bundleIdentifier else { fail("This has to run from inside the app.") }
guard let home = getpwuid(getuid())?.pointee.pw_dir else { fail("There's no home folder.") }
let path = String(cString: home) + "/Library/Group Containers/83535P4H56.com.benface.pricetag.bridge/\(bundleIdentifier.split(separator: ".").last ?? "app").sock"

let app = socket(AF_UNIX, SOCK_STREAM, 0)
guard app >= 0 else { fail("Couldn't make a socket.") }
var address = sockaddr_un()
address.sun_family = sa_family_t(AF_UNIX)
guard path.utf8.count < MemoryLayout.size(ofValue: address.sun_path) else { fail("The socket's path is too long.") }
withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: path.utf8) }
let connected = withUnsafePointer(to: &address) { pointer in
    pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(app, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
}
// Exiting is how the extension hears that the app isn't running.
guard connected == 0 else { fail("The app isn't running.") }

var on: Int32 = 1
setsockopt(app, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
signal(SIGPIPE, SIG_IGN)

/// Returns when either end closes.
@Sendable func relay(from source: Int32, to destination: Int32) {
    var buffer = [UInt8](repeating: 0, count: 65536)
    while true {
        let got = read(source, &buffer, buffer.count)
        if got < 0, errno == EINTR { continue }
        guard got > 0 else { return }
        var offset = 0
        while offset < got {
            let wrote = buffer.withUnsafeBytes { write(destination, $0.baseAddress! + offset, got - offset) }
            if wrote < 0, errno == EINTR { continue }
            guard wrote > 0 else { return }
            offset += wrote
        }
    }
}

let browserToApp = Thread { relay(from: STDIN_FILENO, to: app); exit(0) }
browserToApp.start()
relay(from: app, to: STDOUT_FILENO)
exit(0)
