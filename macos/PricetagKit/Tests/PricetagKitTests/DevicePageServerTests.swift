import Foundation
import Network
import Testing
@testable import PricetagKit

@Suite struct DevicePageServerTests {
    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "device-pages-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder.appending(path: "assets"), withIntermediateDirectories: true)
        try Data("<!doctype html>page".utf8).write(to: folder.appending(path: "device.html"))
        try Data("code".utf8).write(to: folder.appending(path: "assets/a.js"))
        return folder
    }

    /// `host` is whatever a site's browser might send, so this can't go through URLSession, which picks its own.
    private func ask(_ url: URL, _ request: String) async throws -> String {
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(url.port!))!, using: .tcp)
        defer { connection.cancel() }
        connection.start(queue: .global())
        return try await withCheckedThrowingContinuation { continuation in
            connection.send(content: Data(request.utf8), completion: .contentProcessed { _ in })
            connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { data, _, _, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: String(decoding: data ?? Data(), as: UTF8.self)) }
            }
        }
    }

    private func get(_ url: URL, _ path: String, host: String? = nil, headers: String = "") async throws -> String {
        try await ask(url, "GET \(path) HTTP/1.1\r\nHost: \(host ?? "127.0.0.1:\(url.port!)")\r\n\(headers)\r\n")
    }

    private func isRefused(_ url: URL) async -> Bool {
        (try? await URLSession.shared.data(from: url)) == nil
    }

    private func waitUntilRefused(_ url: URL) async -> Bool {
        for _ in 0..<50 {
            if await isRefused(url) { return true }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return false
    }

    private let quick = DevicePageServer.Timing(waitingForPage: .milliseconds(300), afterLastPage: .milliseconds(100), longest: .seconds(30))

    @Test func servesThePageAtTheRootWithTheSameRulesAsTheServer() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let url = try await server.start()
        #expect(url.host() == "127.0.0.1")
        #expect(url.port != 8787)
        let page = try await get(url, "/?topup=0xabc&usd=20")
        #expect(page.hasPrefix("HTTP/1.1 200"))
        #expect(page.hasSuffix("<!doctype html>page"))
        #expect(page.contains("content-type: text/html"))
        #expect(page.contains("content-security-policy: \(DevicePageServer.contentSecurityPolicy)\r\n"))
        #expect(page.contains("x-content-type-options: nosniff"))
        let code = try await get(url, "/assets/a.js", headers: "Sec-Fetch-Site: same-origin\r\n")
        #expect(code.contains("content-type: text/javascript"))
        #expect(code.hasSuffix("code"))
    }

    @Test func anotherFlowUsesTheSameAddress() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let first = try await server.start()
        let second = try await server.start()
        #expect(first == second)
    }

    @Test func refusesASiteThatRebindsItsDomainHere() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let url = try await server.start()
        for host in ["evil.example", "evil.example:\(url.port!)", "localhost:\(url.port!)", "127.0.0.1", "127.0.0.1:1"] {
            #expect(try await get(url, "/", host: host).hasPrefix("HTTP/1.1 403"), "\(host)")
        }
        let twoHosts = try await ask(url, "GET / HTTP/1.1\r\nHost: 127.0.0.1:\(url.port!)\r\nHost: evil.example\r\n\r\n")
        #expect(twoHosts.hasPrefix("HTTP/1.1 403"))
        let noHost = try await ask(url, "GET / HTTP/1.1\r\n\r\n")
        #expect(noHost.hasPrefix("HTTP/1.1 403"))
    }

    @Test func refusesWhatAnotherSiteAsksFor() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let url = try await server.start()
        for site in ["cross-site", "same-site"] {
            #expect(try await get(url, "/", headers: "Sec-Fetch-Site: \(site)\r\n").hasPrefix("HTTP/1.1 403"), "\(site)")
        }
        #expect(try await get(url, "/", headers: "sec-fetch-site: none\r\n").hasPrefix("HTTP/1.1 200"), "the app opening it")
        #expect(try await get(url, DevicePageServer.alivePath).hasPrefix("HTTP/1.1 403"), "only the page itself can keep this going")
    }

    @Test func onlyServesItsOwnFiles() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let url = try await server.start()
        for path in ["/../../etc/hosts", "/assets/../../secret", "/%2e%2e/secret", "/api/rules", "http://127.0.0.1/", "assets/a.js"] {
            #expect(try await get(url, path).hasPrefix("HTTP/1.1 404"), "\(path)")
        }
        let posted = try await ask(url, "POST / HTTP/1.1\r\nHost: 127.0.0.1:\(url.port!)\r\n\r\n")
        #expect(posted.hasPrefix("HTTP/1.1 405"))
        #expect(try await ask(url, "nonsense\r\n\r\n").hasPrefix("HTTP/1.1 400"))
    }

    @Test func aBuildWithoutThePagesSaysSo() async throws {
        let empty = FileManager.default.temporaryDirectory.appending(path: "device-pages-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        await #expect(throws: DevicePageServer.Problem.noPages) { try await DevicePageServer(folder: empty).start() }
    }

    @Test func stopsIfNoPageEverAsks() async throws {
        let server = DevicePageServer(folder: try folder(), timing: quick)
        let url = try await server.start()
        #expect(await waitUntilRefused(url))
    }

    @Test func staysWhileThePageIsOpenAndStopsOnceItCloses() async throws {
        let server = DevicePageServer(folder: try folder(), timing: quick)
        defer { server.stop() }
        let url = try await server.start()
        let page = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: UInt16(url.port!))!, using: .tcp)
        page.start(queue: .global())
        let answered: String = try await withCheckedThrowingContinuation { continuation in
            page.send(content: Data("GET \(DevicePageServer.alivePath) HTTP/1.1\r\nHost: 127.0.0.1:\(url.port!)\r\nSec-Fetch-Site: same-origin\r\n\r\n".utf8), completion: .contentProcessed { _ in })
            page.receive(minimumIncompleteLength: 1, maximumLength: 4096) { data, _, _, error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume(returning: String(decoding: data ?? Data(), as: UTF8.self)) }
            }
        }
        #expect(answered.hasPrefix("HTTP/1.1 200"))
        try await Task.sleep(for: .seconds(1))
        #expect(try await get(url, "/").hasPrefix("HTTP/1.1 200"), "well past the wait for a page, it's still there")
        page.cancel()
        #expect(await waitUntilRefused(url))
    }

    @Test func aTabLeftOpenDoesntKeepItGoing() async throws {
        let server = DevicePageServer(folder: try folder(), timing: DevicePageServer.Timing(waitingForPage: .seconds(30), afterLastPage: .seconds(30), longest: .milliseconds(200)))
        let url = try await server.start()
        #expect(await waitUntilRefused(url))
    }

    @Test func startsAgainAfterStopping() async throws {
        let server = DevicePageServer(folder: try folder())
        defer { server.stop() }
        let first = try await server.start()
        server.stop()
        #expect(await waitUntilRefused(first))
        let second = try await server.start()
        #expect(try await get(second, "/").hasPrefix("HTTP/1.1 200"))
    }

    @Test func onlyAServerOnThisMacHasThePage() {
        #expect(!DeviceFlow.needsItsOwnPage(URL(string: "http://127.0.0.1:8787?topup=0xabc")!))
        #expect(!DeviceFlow.needsItsOwnPage(URL(string: "http://localhost:8787?topup=0xabc")!))
        #expect(DeviceFlow.needsItsOwnPage(URL(string: "https://patina-server.fly.dev?topup=0xabc")!))
    }

    @Test func aLinkKeepsItsRequestOnThePage() {
        let link = URL(string: "https://patina-server.fly.dev?topup=0xabc&usd=20")!
        #expect(DeviceFlow.link(link, on: URL(string: "http://127.0.0.1:49152")!)?.absoluteString == "http://127.0.0.1:49152?topup=0xabc&usd=20")
    }
}
