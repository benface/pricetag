import CoreVideo
import Vision

/// Reads QR codes out of a camera's frame. What it finds is only text, and nothing here keeps the frame or the text.
public enum QRCodeReader {
    public static func read(_ frame: CVPixelBuffer) async -> [String] {
        var request = DetectBarcodesRequest()
        request.symbologies = [.qr]
        return (try? await request.perform(on: frame))?.compactMap(\.payloadString) ?? []
    }

    public static func read(_ image: CGImage) async -> [String] {
        var request = DetectBarcodesRequest()
        request.symbologies = [.qr]
        return (try? await request.perform(on: image))?.compactMap(\.payloadString) ?? []
    }
}
