#if DEBUG && canImport(AppKit)
import AppKit
import SwiftUI
import Testing
@testable import PricetagKit

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
            PnlHeadline(portfolio: portfolio, isLive: true, size: 30) {}
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

    @Test func sizesToTheViewUnlessToldOtherwise() throws {
        let fitted = try #require(NSBitmapImageRep(data: OffscreenRenderer.png(of: Color.red.frame(width: 100, height: 50))))
        #expect(fitted.size == NSSize(width: 100, height: 50))
        let told = try #require(NSBitmapImageRep(data: OffscreenRenderer.png(of: Color.red, size: CGSize(width: 40, height: 30))))
        #expect(told.size == NSSize(width: 40, height: 30))
    }

    @Test func givesUpWhenWhatItWaitsForNeverArrives() {
        #expect(throws: OffscreenRenderer.Failure.neverReady) {
            try OffscreenRenderer.png(of: Text("Waiting"), isReady: { false })
        }
    }
}
#endif
