#if os(macOS)
import Foundation

/// Where the extension's native messaging host finds the app: a Unix socket in a folder both can reach and no other app can, an app group
/// that belongs to this team. Sandboxed apps can only listen on sockets inside a container like this. `macos/BridgeHost/main.swift`
/// works out the same path, and a test keeps them the same.
public enum BridgeEndpoint {
    public static let group = "R7TNNTC382.com.benface.pricetag.bridge"

    public static func socketPath(bundleIdentifier: String) -> String? {
        guard let passwd = getpwuid(getuid()), let home = passwd.pointee.pw_dir else { return nil }
        // The real home, since inside the sandbox NSHomeDirectory() is the app's own container.
        let path = String(cString: home) + "/Library/Group Containers/\(group)/\(bundleIdentifier.split(separator: ".").last ?? "app").sock"
        // A Unix socket's path has to fit in `sun_path`.
        return path.utf8.count < MemoryLayout.size(ofValue: sockaddr_un().sun_path) ? path : nil
    }
}

/// Listens for the native messaging host and passes what it says to the bridge. The frames are Chrome's own, a 4-byte length and then
/// JSON, so the host only has to relay bytes.
///
/// A message has three kinds. `site` carries a page's request, with the origin the extension got from the browser. `cancel` says that
/// page went away. `popup` is the extension's own popup. There's deliberately no message that answers an approval.
@MainActor
public final class BridgeServer {
    /// Chrome won't take a bigger message from a host.
    nonisolated static let maxFrame = 1024 * 1024

    private let bridge: SiteBridge
    private let path: String
    private var connections: [UUID: BridgeConnection] = [:]
    private var listener: Int32 = -1

    public init(bridge: SiteBridge, path: String) {
        self.bridge = bridge
        self.path = path
        bridge.onAccountsChanged = { [weak self] origin, accounts in
            self?.broadcast(.object(["event": .string("accountsChanged"), "origin": .string(origin), "data": .array(accounts.map { .string($0) })]))
        }
    }

    /// Throws if this build isn't allowed to make the socket, which only a provisioned one is.
    public func start() throws {
        // Makes the folder, the first time. It's this user's alone.
        _ = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: BridgeEndpoint.group)
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        // Left over from the last run. Only one copy of this app runs at a time.
        unlink(path)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &address.sun_path) { buffer in
            buffer.copyBytes(from: path.utf8)
        }
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, chmod(path, 0o600) == 0, listen(descriptor, 8) == 0 else {
            let failure = POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
            close(descriptor)
            throw failure
        }
        listener = descriptor
        // Blocking calls, so they get their own threads instead of holding up anything else.
        Thread.detachNewThread { [weak self] in
            while true {
                let client = accept(descriptor, nil, nil)
                guard client >= 0 else { return }
                Task { @MainActor [weak self] in self?.add(client) }
            }
        }
    }

    public func stop() {
        if listener >= 0 { close(listener) }
        listener = -1
        unlink(path)
        for connection in connections.values { connection.close() }
    }

    private func add(_ descriptor: Int32) {
        let id = UUID()
        let connection = BridgeConnection(descriptor: descriptor)
        connections[id] = connection
        Thread.detachNewThread { [weak self] in
            connection.readFrames { frame in
                Task { @MainActor [weak self] in self?.receive(frame, from: id, on: connection) }
            }
            Task { @MainActor [weak self] in
                self?.connections[id] = nil
                self?.bridge.cancelAll(connection: id)
            }
        }
    }

    private func receive(_ frame: Data, from id: UUID, on connection: BridgeConnection) {
        // Its host has already gone, so nothing would hear an answer, and nothing would cancel this.
        guard connections[id] != nil else { return }
        guard let message = try? JSONDecoder().decode(JSONValue.self, from: frame), let kind = message["kind"]?.string, let requestID = message["id"]?.string else { return }
        switch kind {
        case "site":
            guard let origin = message["origin"]?.string, let method = message["method"]?.string else { return }
            // On record before the next frame is read, which could be the one cancelling it.
            let answer = bridge.begin(SiteRequest(connection: id, id: requestID, origin: origin, method: method, parameters: message["params"]))
            Task {
                connection.send(Self.reply(id: requestID, await answer.value))
            }
        case "cancel":
            bridge.cancel(connection: id, id: requestID)
        case "popup":
            switch message["method"]?.string {
            case "status":
                connection.send(Self.reply(id: requestID, .success(bridge.popupStatus())))
            case "topUp":
                bridge.requestTopUp()
                connection.send(Self.reply(id: requestID, .success(.null)))
            case "receive":
                bridge.requestReceive()
                connection.send(Self.reply(id: requestID, .success(.null)))
            default:
                connection.send(Self.reply(id: requestID, .failure(.unsupported(message["method"]?.string ?? "that"))))
            }
        default:
            break
        }
    }

    private func broadcast(_ message: JSONValue) {
        for connection in connections.values { connection.send(message) }
    }

    nonisolated static func reply(id: String, _ answer: RPCAnswer) -> JSONValue {
        switch answer {
        case .success(let result):
            return .object(["id": .string(id), "result": result])
        case .failure(let error):
            var body: [String: JSONValue] = ["code": .number(Double(error.code)), "message": .string(error.message)]
            if let data = error.data { body["data"] = data }
            return .object(["id": .string(id), "error": .object(body)])
        }
    }
}

/// One host, so one browser. Reads and writes block, on a thread and a queue of their own.
final class BridgeConnection: @unchecked Sendable {
    private let descriptor: Int32
    private let writes = DispatchQueue(label: "com.benface.pricetag.bridge.write")

    init(descriptor: Int32) {
        self.descriptor = descriptor
        // A browser that's gone shouldn't take the app with it. A failed write just ends this connection.
        var on: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    /// Returns when the other end closes, or breaks the rules.
    func readFrames(_ receive: (Data) -> Void) {
        while let header = read(count: 4) {
            let length = header.withUnsafeBytes { Int($0.loadUnaligned(as: UInt32.self)) }
            guard length <= BridgeServer.maxFrame, let body = read(count: length) else { break }
            receive(body)
        }
        close()
    }

    private func read(count: Int) -> Data? {
        var data = Data(count: count)
        var offset = 0
        while offset < count {
            let got = data.withUnsafeMutableBytes { Darwin.read(descriptor, $0.baseAddress! + offset, count - offset) }
            if got < 0, errno == EINTR { continue }
            guard got > 0 else { return nil }
            offset += got
        }
        return data
    }

    func send(_ message: JSONValue) {
        writes.async { [self] in
            guard var body = try? JSONEncoder().encode(message) else { return }
            if body.count > BridgeServer.maxFrame {
                // Chrome would end the connection, and every other request on it. Only this one has to fail.
                let error = SiteError(code: -32603, message: "That answer is too big to pass along.")
                guard let id = message["id"]?.string, let small = try? JSONEncoder().encode(BridgeServer.reply(id: id, .failure(error))) else { return }
                body = small
            }
            var length = UInt32(body.count)
            let frame = withUnsafeBytes(of: &length) { Data($0) } + body
            var offset = 0
            while offset < frame.count {
                let wrote = frame.withUnsafeBytes { Darwin.write(descriptor, $0.baseAddress! + offset, frame.count - offset) }
                if wrote < 0, errno == EINTR { continue }
                guard wrote > 0 else { return }
                offset += wrote
            }
        }
    }

    func close() {
        shutdown(descriptor, SHUT_RDWR)
    }

    deinit {
        Darwin.close(descriptor)
    }
}
#endif
