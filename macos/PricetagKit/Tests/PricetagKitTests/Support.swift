import Foundation
import Testing
@testable import PricetagKit

func resource<T: Decodable>(_ name: String, as type: T.Type) throws -> T {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: "json", subdirectory: "Resources"))
    return try JSONDecoder().decode(type, from: Data(contentsOf: url))
}

func demoPortfolio() throws -> Portfolio {
    try resource("demo-portfolio", as: Portfolio.self)
}
