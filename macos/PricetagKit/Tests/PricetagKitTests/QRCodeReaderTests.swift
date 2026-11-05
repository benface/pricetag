import CoreImage
import Testing
@testable import PricetagKit

@Suite struct QRCodeReaderTests {
    /// The same text a Keystone's receive screen encodes: the address on its own.
    private let address = "0x52908400098527886E0F7030069857D2E4169EE7"

    private func code(_ text: String) throws -> CGImage {
        let filter = try #require(CIFilter(name: "CIQRCodeGenerator"))
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        let output = try #require(filter.outputImage).transformed(by: CGAffineTransform(scaleX: 8, y: 8))
        return try #require(CIContext().createCGImage(output, from: output.extent))
    }

    @Test func readsACode() async throws {
        #expect(await QRCodeReader.read(try code(address)) == [address])
    }

    @Test func aPictureWithNoCodeReadsAsNothing() async throws {
        let blank = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 200, height: 200))
        let image = try #require(CIContext().createCGImage(blank, from: blank.extent))
        #expect(await QRCodeReader.read(image).isEmpty)
    }
}
