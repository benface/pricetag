import CoreImage
import CoreImage.CIFilterBuiltins

/// Draws a QR code from Core Image's own generator, so there's no dependency to trust with an address.
public enum QRCodeMaker {
    /// `moduleSize` pixels per module, with the generator's quiet zone. Large enough, it stays sharp however it's drawn.
    public static func image(for text: String, moduleSize: CGFloat = 1) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        // Medium: a phone reads it easily off a screen, and the code stays small.
        filter.correctionLevel = "M"
        guard let output = filter.outputImage?.samplingNearest().transformed(by: CGAffineTransform(scaleX: moduleSize, y: moduleSize)) else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}
