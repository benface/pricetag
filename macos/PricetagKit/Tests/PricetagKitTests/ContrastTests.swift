#if canImport(AppKit)
import AppKit
import SwiftUI
import Testing
@testable import PricetagKit

/// Text against the window, by WCAG's measure: 4.5:1 for text at its usual sizes. It's worked out from the real system colors in light and dark,
/// the way they're drawn: a color with some transparency is blended with the window first.
@MainActor
@Suite(.serialized)
struct ContrastTests {
    private typealias RGB = (r: Double, g: Double, b: Double)

    private func resolved(_ color: Color, dark: Bool) -> (rgb: RGB, alpha: Double) {
        var environment = EnvironmentValues()
        environment.colorScheme = dark ? .dark : .light
        let color = NSColor(cgColor: color.resolve(in: environment).cgColor)!.usingColorSpace(.sRGB)!
        return ((color.redComponent, color.greenComponent, color.blueComponent), color.alphaComponent)
    }

    private func window(dark: Bool) -> RGB {
        var rgb: RGB = (0, 0, 0)
        NSAppearance(named: dark ? .darkAqua : .aqua)!.performAsCurrentDrawingAppearance {
            let color = NSColor.windowBackgroundColor.usingColorSpace(.sRGB)!
            rgb = (color.redComponent, color.greenComponent, color.blueComponent)
        }
        return rgb
    }

    private func luminance(_ rgb: RGB) -> Double {
        func linear(_ value: Double) -> Double { value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(rgb.r) + 0.7152 * linear(rgb.g) + 0.0722 * linear(rgb.b)
    }

    private func contrast(_ color: Color, opacity: Double = 1, dark: Bool) -> Double {
        let (rgb, alpha) = resolved(color, dark: dark)
        let background = window(dark: dark)
        let a = alpha * opacity
        let blended: RGB = (rgb.r * a + background.r * (1 - a), rgb.g * a + background.g * (1 - a), rgb.b * a + background.b * (1 - a))
        let (lighter, darker) = (max(luminance(blended), luminance(background)), min(luminance(blended), luminance(background)))
        return (lighter + 0.05) / (darker + 0.05)
    }

    @Test(arguments: [false, true])
    func gainsLossesAndWarningsCanBeRead(dark: Bool) throws {
        for tone in [Tone.gain, .loss, .warning] {
            #expect(contrast(tone.color, dark: dark) >= 4.5, "\(tone) in \(dark ? "dark" : "light") is \(contrast(tone.color, dark: dark))")
            let measured = try rendered(LiveNumber("8888", tone: tone).font(.system(size: 60, weight: .bold)), dark: dark)
            #expect(measured >= 4.5, "\(tone) in \(dark ? "dark" : "light") measured \(measured)")
        }
    }

    /// "Unknown", the labels over numbers and comparisons. Faded or not, and with Increase Contrast on.
    @Test(arguments: [false, true])
    func secondaryTextThatSaysSomethingCanBeRead(dark: Bool) throws {
        let big = Font.system(size: 60, weight: .bold)
        let cases: [(String, AnyView)] = [
            ("a secondary number", AnyView(LiveNumber("8888", tone: .secondary).font(big))),
            ("secondary text", AnyView(Text("8888").font(big).secondaryText())),
            ("faded secondary text", AnyView(Text("8888").font(big).secondaryText().stale(true))),
            ("faded secondary number", AnyView(LiveNumber("8888", tone: .secondary).font(big).stale(true))),
            ("secondary text with Increase Contrast", AnyView(Text("8888").font(big).secondaryText().environment(\._colorSchemeContrast, .increased))),
            ("a secondary number with Increase Contrast", AnyView(LiveNumber("8888", tone: .secondary).font(big).environment(\._colorSchemeContrast, .increased))),
        ]
        for (name, view) in cases {
            let measured = try rendered(view, dark: dark)
            #expect(measured >= 4.5, "\(name) in \(dark ? "dark" : "light") measured \(measured)")
        }
        // The system's own, so this test means something.
        if !dark { #expect(try rendered(Text("8888").font(big).foregroundStyle(.secondary), dark: false) < 4.5) }
    }

    /// They lose their color as they fade, so it's the text color that has to hold. Measured from a render, because text comes out lighter
    /// than its color says: 0.7 measured 4.3:1 in light.
    @Test(arguments: [false, true])
    func numbersThatStoppedUpdatingCanStillBeRead(dark: Bool) throws {
        let measured = try rendered(LiveNumber("8888", tone: .gain).font(.system(size: 60, weight: .bold)).stale(true), dark: dark)
        #expect(measured >= 4.5, "\(dark ? "dark" : "light") is \(measured)")
        // What it used to be, so this test means something.
        let before = try rendered(LiveNumber("8888").font(.system(size: 60, weight: .bold)).opacity(0.55), dark: false)
        if !dark { #expect(before < 4.5) }
    }

    /// The contrast of the pixel that's furthest from the window's color, which a big bold glyph always reaches.
    private func rendered(_ view: some View, dark: Bool) throws -> Double {
        let background = window(dark: dark)
        // Plain text has nothing to wait for, and a render holds the main thread that other tests are waiting on.
        let png = try OffscreenRenderer.png(of: view.padding(20).background(Color(nsColor: .windowBackgroundColor)), dark: dark, settle: 0)
        let bitmap = try #require(NSBitmapImageRep(data: png))
        var best = 1.0
        for y in stride(from: 0, to: bitmap.pixelsHigh, by: 2) {
            for x in stride(from: 0, to: bitmap.pixelsWide, by: 2) {
                guard let color = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                let (a, b) = (luminance((color.redComponent, color.greenComponent, color.blueComponent)), luminance(background))
                best = max(best, (max(a, b) + 0.05) / (min(a, b) + 0.05))
            }
        }
        return best
    }
}
#endif
