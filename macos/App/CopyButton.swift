import PricetagKit
import SwiftUI

/// Copies, and says so right where you clicked, for long enough to read.
struct CopyButton: View {
    let title: String
    let text: String
    var help: String?
    @State private var copied = false

    var body: some View {
        Button {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            copied = true
        } label: {
            Label(copied ? "Copied" : title, systemImage: copied ? "checkmark" : "doc.on.doc")
                .contentTransition(.symbolEffect(.replace))
        }
        .animation(Motion.state, value: copied)
        .help(help ?? "")
        .task(id: copied) {
            guard copied else { return }
            try? await Task.sleep(for: Motion.acknowledged)
            if !Task.isCancelled { copied = false }
        }
    }
}
