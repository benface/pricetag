#if DEBUG && canImport(AppKit)
import AppKit
import SwiftUI
import Testing
@testable import PricetagKit

@MainActor
@Observable
private final class PastedWallets {
    var text = ""
    var added: [String] = []
}

private struct PasteHost: View {
    @Bindable var paste: PastedWallets

    var body: some View {
        AddressField(prompt: "", text: $paste.text, takesSeveral: true, onAddress: { paste.added.append($0) })
    }
}

/// Views drawn from fixtures with `OffscreenRenderer`, which never takes focus. Interaction belongs in the logic tests, not here.
@MainActor
@Suite(.serialized)
struct RenderTests {
    /// Average brightness from 0 to 1, and how many different colors there are.
    private func look(at png: Data) throws -> (brightness: Double, colors: Int) {
        let bitmap = try #require(NSBitmapImageRep(data: png))
        var total = 0.0
        var colors = Set<UInt32>()
        var samples = 0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 3) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 3) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                total += color.brightnessComponent
                samples += 1
                colors.insert(UInt32(color.redComponent * 255) << 16 | UInt32(color.greenComponent * 255) << 8 | UInt32(color.blueComponent * 255))
            }
        }
        return (total / Double(samples), colors.count)
    }

    @Test func drawsARealViewInLightAndDark() throws {
        let portfolio = try demoPortfolio()
        let view = VStack(alignment: .leading) {
            PortfolioSummary(portfolio: portfolio, isLive: true, size: 30) { _ in }
            // A control AppKit draws, which ImageRenderer would leave out.
            Picker("Cost method", selection: .constant(CostMethod.average)) {
                ForEach(CostMethod.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            ForEach(portfolio.positions) { HoldingRow(position: $0, currency: portfolio.currency, isLive: true) }
        }
        .padding()
        .frame(width: 380)

        let light = try look(at: OffscreenRenderer.png(of: view))
        let dark = try look(at: OffscreenRenderer.png(of: view, dark: true))
        #expect(light.colors > 20)
        #expect(dark.colors > 20)
        #expect(light.brightness > 0.7)
        #expect(dark.brightness < 0.3)
    }

    /// The real field, because this is about what it does with a paste, and a wallet missing from a report doesn't show.
    @Test func aPasteOfSeveralLeavesWhatItCouldntAdd() async throws {
        let good = "0x\(String(repeating: "1", count: 40))"
        let another = "0x\(String(repeating: "3", count: 40))"
        for (pasted, added, left) in [
            ("\(good)\n0x2222", [good], "0x2222"),
            ("\(good)\n0x22zz", [good], "0x22zz"),
            ("\(good) \(another) 0x2222", [good, another], "0x2222"),
            ("\(good)\n\(another)", [good, another], ""),
        ] {
            let paste = PastedWallets()
            let host = NSHostingView(rootView: PasteHost(paste: paste))
            host.frame = CGRect(x: 0, y: 0, width: 400, height: 200)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(100))
            paste.text = pasted
            let deadline = Date.now.addingTimeInterval(5)
            while paste.text != left || paste.added != added, Date.now < deadline {
                host.layoutSubtreeIfNeeded()
                try await Task.sleep(for: .milliseconds(20))
            }
            #expect(paste.added == added)
            #expect(paste.text == left)
        }
    }

    @Test func sizesToTheViewUnlessToldOtherwise() throws {
        let fitted = try #require(NSBitmapImageRep(data: OffscreenRenderer.png(of: Color.red.frame(width: 100, height: 50))))
        #expect(fitted.size == NSSize(width: 100, height: 50))
        let told = try #require(NSBitmapImageRep(data: OffscreenRenderer.png(of: Color.red, size: CGSize(width: 40, height: 30))))
        #expect(told.size == NSSize(width: 40, height: 30))
    }

    /// A narrow details pane has to fit a fee's facts on more lines rather than cut them short.
    @Test func aFeeRowMakesRoomInANarrowPane() throws {
        let explanation = try resource("all-yours-demo-explanation", as: Explanation.self)
        let fee = try #require(explanation.legs.first { $0.kind == "gas" })
        let wallet = try #require(fee.wallet)
        let store = PortfolioStore(defaults: UserDefaults(suiteName: "fee-row-\(UUID().uuidString)")!, makeSource: { _ in BookSource([]) })
        let row = NSHostingController(rootView: LegRow(leg: fee, currency: explanation.currency, store: store).environment(\.walletNames, [wallet: "Spending Money"]))
        let height = { (width: CGFloat) in row.sizeThatFits(in: CGSize(width: width, height: 1000)).height }
        #expect(height(268) > height(520))
    }

    @Test func givesUpWhenWhatItWaitsForNeverArrives() {
        #expect(throws: OffscreenRenderer.Failure.neverReady) {
            try OffscreenRenderer.png(of: Text("Waiting"), isReady: { false })
        }
    }
}
#endif
