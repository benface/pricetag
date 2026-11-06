// A hosted server only answers the API, and a device page served from a shared host would be a site a cold wallet connects to. So a build
// that reads one serves that page itself, from what was signed into the app, on this Mac only and only while the page is open.

import Foundation
import Network

public final class DevicePageServer: @unchecked Sendable {
    public enum Problem: Error, Equatable {
        /// This copy of the app was built without the pages.
        case noPages
        case couldNotListen
    }

    /// What `server/http.ts` sends. `test/devices.test.ts` holds the two together.
    static let contentSecurityPolicy = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://mainnet.base.org https://global.api.prd.ledger.com/cal/ https://nft.api.live.ledger.com; frame-ancestors 'none'; base-uri 'none'"

    /// The page holds a request here for as long as it's open, which is how this knows the flow has ended.
    static let alivePath = "/alive"
    private static let page = "device.html"
    private static let mostHeaderBytes = 16 * 1024

    struct Timing: Sendable {
        /// For the browser to open and ask for the page.
        var waitingForPage: Duration = .seconds(120)
        /// Long enough for a reload to come back.
        var afterLastPage: Duration = .seconds(15)
        /// So a tab left open doesn't leave this listening.
        var longest: Duration = .seconds(3600)

        static let standard = Timing()
    }

    private let folder: URL
    private let timing: Timing
    private let queue = DispatchQueue(label: "DevicePageServer")

    // All of these are only touched on `queue`.
    private var listener: NWListener?
    private var port: UInt16?
    private var files: [String: URL] = [:]
    private var waitingToStart: [CheckedContinuation<URL, any Error>] = []
    private var connections: [ObjectIdentifier: NWConnection] = [:]
    private var pagesOpen = 0
    private var stopping: DispatchWorkItem?
    private var longest: DispatchWorkItem?

    public convenience init(folder: URL) {
        self.init(folder: folder, timing: .standard)
    }

    init(folder: URL, timing: Timing) {
        self.folder = folder
        self.timing = timing
    }

    /// Where the page is. If it's already serving, that's the same place, so a second flow has the same address as the first.
    public func start() async throws -> URL {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { self.start(continuation) }
        }
    }

    public func stop() {
        queue.async { self.shutDown() }
    }

    private func start(_ continuation: CheckedContinuation<URL, any Error>) {
        if let port {
            scheduleEnd(after: timing.waitingForPage)
            continuation.resume(returning: Self.address(port))
            return
        }
        waitingToStart.append(continuation)
        guard listener == nil else { return }
        do {
            files = try Self.files(in: folder)
            let parameters = NWParameters.tcp
            parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
            parameters.requiredInterfaceType = .loopback
            let listener = try NWListener(using: parameters)
            listener.stateUpdateHandler = { [weak self, weak listener] state in
                guard let self, let listener, self.listener === listener else { return }
                switch state {
                case .ready: self.ready(listener)
                case .failed, .waiting: self.failToStart(.couldNotListen)
                default: break
                }
            }
            listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }
            self.listener = listener
            listener.start(queue: queue)
        } catch {
            failToStart(error as? Problem ?? .couldNotListen)
        }
    }

    private func ready(_ listener: NWListener) {
        guard let port = listener.port?.rawValue else { return failToStart(.couldNotListen) }
        self.port = port
        scheduleEnd(after: timing.waitingForPage)
        let longest = DispatchWorkItem { [weak self] in self?.shutDown() }
        self.longest = longest
        queue.asyncAfter(deadline: .now() + timing.longest.seconds, execute: longest)
        for waiting in waitingToStart { waiting.resume(returning: Self.address(port)) }
        waitingToStart = []
    }

    private func failToStart(_ problem: Problem) {
        for waiting in waitingToStart { waiting.resume(throwing: problem) }
        waitingToStart = []
        shutDown()
    }

    private func shutDown() {
        stopping?.cancel()
        stopping = nil
        longest?.cancel()
        longest = nil
        listener?.cancel()
        listener = nil
        port = nil
        files = [:]
        pagesOpen = 0
        for connection in connections.values { connection.cancel() }
        connections = [:]
    }

    /// With a page open, it's the page closing that ends this.
    private func scheduleEnd(after wait: Duration) {
        stopping?.cancel()
        stopping = nil
        guard pagesOpen == 0 else { return }
        let stopping = DispatchWorkItem { [weak self] in self?.shutDown() }
        self.stopping = stopping
        queue.asyncAfter(deadline: .now() + wait.seconds, execute: stopping)
    }

    private func accept(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        connections[id] = connection
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.connections[id] = nil
            default: break
            }
        }
        connection.start(queue: queue)
        read(connection, Data())
    }

    private func read(_ connection: NWConnection, _ received: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: Self.mostHeaderBytes) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var received = received
            if let data { received.append(data) }
            if received.count > Self.mostHeaderBytes || error != nil {
                connection.cancel()
            } else if received.range(of: Data("\r\n\r\n".utf8)) != nil {
                self.respond(connection, to: DevicePageRequest(received))
            } else if isComplete {
                connection.cancel()
            } else {
                self.read(connection, received)
            }
        }
    }

    private func respond(_ connection: NWConnection, to request: DevicePageRequest?) {
        guard let port else { return connection.cancel() }
        switch DevicePageAnswer(to: request, port: port, files: files) {
        case .file(let url):
            guard let body = try? Data(contentsOf: url) else { return send(connection, status: "500 Internal Server Error", text: "Something went wrong.") }
            send(connection, status: "200 OK", type: Self.type(of: url), body: request?.method == "HEAD" ? Data() : body, length: body.count)
        case .alive:
            holdOpen(connection)
        case .refused(let status, let text):
            send(connection, status: status, text: text)
        }
    }

    private func send(_ connection: NWConnection, status: String, text: String) {
        send(connection, status: status, type: "text/plain", body: Data(text.utf8), length: text.utf8.count)
    }

    private func send(_ connection: NWConnection, status: String, type: String, body: Data, length: Int) {
        connection.send(content: Self.head(status, type: type, length: length) + body, isComplete: true, completion: .contentProcessed { _ in connection.cancel() })
    }

    /// Answers and never finishes, so all that's left is to hear it close.
    private func holdOpen(_ connection: NWConnection) {
        pagesOpen += 1
        scheduleEnd(after: timing.afterLastPage)
        connection.send(content: Self.head("200 OK", type: "text/plain", length: nil), completion: .contentProcessed { _ in })
        waitForClose(connection, Generation(self))
    }

    /// One page closing only counts for the listener it was open on.
    private struct Generation {
        let listener: NWListener?
        init(_ server: DevicePageServer) { listener = server.listener }
    }

    private func waitForClose(_ connection: NWConnection, _ generation: Generation) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1024) { [weak self] _, _, isComplete, error in
            guard let self else { return }
            if !isComplete, error == nil { return self.waitForClose(connection, generation) }
            connection.cancel()
            guard generation.listener === self.listener else { return }
            self.pagesOpen -= 1
            self.scheduleEnd(after: self.timing.afterLastPage)
        }
    }

    private static func address(_ port: UInt16) -> URL {
        URL(string: "http://127.0.0.1:\(port)")!
    }

    private static func head(_ status: String, type: String, length: Int?) -> Data {
        var lines = ["HTTP/1.1 \(status)", "content-type: \(type)", "content-security-policy: \(contentSecurityPolicy)", "x-content-type-options: nosniff", "cache-control: no-store", "connection: close"]
        if let length { lines.append("content-length: \(length)") }
        return Data((lines.joined(separator: "\r\n") + "\r\n\r\n").utf8)
    }

    private static func type(of url: URL) -> String {
        switch url.pathExtension {
        case "html": "text/html; charset=utf-8"
        case "js": "text/javascript"
        case "css": "text/css"
        case "svg": "image/svg+xml"
        case "map": "application/json"
        case "wasm": "application/wasm"
        default: "application/octet-stream"
        }
    }

    /// Everything it can serve, by the path it's served at, listed up front, so nothing in a request ever becomes part of a file's path.
    static func files(in folder: URL) throws -> [String: URL] {
        guard let found = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey]) else { throw Problem.noPages }
        let root = folder.resolvingSymlinksInPath().path(percentEncoded: false)
        var files: [String: URL] = [:]
        for case let url as URL in found {
            guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { continue }
            let path = url.resolvingSymlinksInPath().path(percentEncoded: false)
            guard path.hasPrefix(root) else { continue }
            files["/" + path.dropFirst(root.count).trimmingPrefix("/")] = url
        }
        guard let page = files["/" + Self.page] else { throw Problem.noPages }
        files["/"] = page
        return files
    }
}

/// As much of a request as deciding what to do with it takes.
struct DevicePageRequest: Equatable {
    let method: String
    let path: String
    let hosts: [String]
    let fetchSite: String?

    init(method: String, path: String, hosts: [String], fetchSite: String?) {
        self.method = method
        self.path = path
        self.hosts = hosts
        self.fetchSite = fetchSite
    }

    init?(_ data: Data) {
        guard let end = data.range(of: Data("\r\n\r\n".utf8)), let text = String(data: data[..<end.lowerBound], encoding: .utf8) else { return nil }
        let lines = text.components(separatedBy: "\r\n")
        let first = lines[0].split(separator: " ", omittingEmptySubsequences: false)
        guard first.count == 3, first[2].hasPrefix("HTTP/1.") else { return nil }
        var hosts: [String] = []
        var fetchSite: String?
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { return nil }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            switch line[..<colon].lowercased() {
            case "host": hosts.append(value)
            case "sec-fetch-site": fetchSite = value.lowercased()
            default: break
            }
        }
        self.init(method: String(first[0]), path: String(first[1].prefix { $0 != "?" && $0 != "#" }), hosts: hosts, fetchSite: fetchSite)
    }
}

enum DevicePageAnswer: Equatable {
    case file(URL)
    case alive
    case refused(status: String, text: String)

    /// A site can make a browser ask this Mac for anything, and can point its own domain at 127.0.0.1 to look like it's asking from here. So
    /// `Host` has to be this address exactly, and a request can only come from the page itself or from the app opening it.
    init(to request: DevicePageRequest?, port: UInt16, files: [String: URL]) {
        guard let request else {
            self = .refused(status: "400 Bad Request", text: "Bad request")
            return
        }
        guard request.method == "GET" || request.method == "HEAD" else {
            self = .refused(status: "405 Method Not Allowed", text: "Only reading")
            return
        }
        guard request.hosts == ["127.0.0.1:\(port)"], [nil, "none", "same-origin"].contains(request.fetchSite) else {
            self = .refused(status: "403 Forbidden", text: "Not from here")
            return
        }
        if request.path == DevicePageServer.alivePath {
            self = request.fetchSite == "same-origin" ? .alive : .refused(status: "403 Forbidden", text: "Not from here")
        } else if let file = files[request.path] {
            self = .file(file)
        } else {
            self = .refused(status: "404 Not Found", text: "Not found")
        }
    }
}

private extension Duration {
    var seconds: Double {
        let parts = components
        return Double(parts.seconds) + Double(parts.attoseconds) / 1e18
    }
}
