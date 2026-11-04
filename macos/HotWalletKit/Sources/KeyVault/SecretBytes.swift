import Foundation

/// Key bytes in memory, for as short a time as possible. The page is kept out of swap, and the bytes are wiped when this
/// goes away. It can't be copied, and it has no way to read the bytes back out except by passing a pointer to `withBytes`.
struct SecretBytes: ~Copyable {
    private let buffer: UnsafeMutableRawBufferPointer

    init(count: Int) {
        buffer = .allocate(byteCount: count, alignment: 16)
        buffer.initializeMemory(as: UInt8.self, repeating: 0)
        mlock(buffer.baseAddress, count)
    }

    deinit {
        memset_s(buffer.baseAddress, buffer.count, 0, buffer.count)
        munlock(buffer.baseAddress, buffer.count)
        buffer.deallocate()
    }

    var count: Int { buffer.count }

    func withBytes<R>(_ body: (UnsafeRawBufferPointer) throws -> R) rethrows -> R {
        try body(UnsafeRawBufferPointer(buffer))
    }

    func withMutableBytes<R>(_ body: (UnsafeMutableRawBufferPointer) throws -> R) rethrows -> R {
        try body(buffer)
    }
}
