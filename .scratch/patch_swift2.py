p='macos/App/MacApp.swift'; s=open(p).read()
s=s.replace('''                    .disabled(store.portfolio == nil)
            }
            CommandGroup(replacing: .undoRedo) {
                Button("Undo Answer") { store.undo() }
                    .keyboardShortcut("z", modifiers: .command)
                    .disabled(store.undoStack.isEmpty)
            }
''','''                    .disabled(store.portfolio == nil)
                Button("Undo Last Answer") { store.undo() }
                    .keyboardShortcut("z", modifiers: [.command, .option])
                    .disabled(store.undoStack.isEmpty)
            }
''')
open(p,'w').write(s)
p='macos/App/SettingsView.swift'; s=open(p).read()
a=s.index('    private var linkMessage: String {'); b=s.index('    var body: some View {')
s=s[:a]+s[b:]
s=s.replace('Text(linkMessage).font(.caption)','Text(Wording.linkMessage(owner: store.address ?? "", address: proving)).font(.caption)')
open(p,'w').write(s)
p='macos/PricetagKit/Sources/PricetagKit/Wording.swift'; s=open(p).read()
s=s.replace('''    /// Where a price came from, in plain words.''','''    /// What a wallet signs to prove it's this user's. The server checks the signature against the same words.
    public static func linkMessage(owner: String, address: String) -> String {
        "Patina: \\(address.lowercased()) is my wallet, and belongs with \\(owner.lowercased()).\\n\\nThis only links them in my own app. It can't move funds or approve anything."
    }

    /// Where a price came from, in plain words.''')
open(p,'w').write(s)
p='test/portfolio.test.ts'; s=open(p).read()
s=s.replace('''      duration: [0, 30, 1800, 3599, 3600, 5400, 100000].map((blocks) => ({ blocks, duration: formatDuration(blocks) })),
''','''      duration: [0, 30, 1800, 3599, 3600, 5400, 100000].map((blocks) => ({ blocks, duration: formatDuration(blocks) })),
      linkMessage: { owner: DEMO_WALLET.address, address: "0x00000000000000000000000000000000000DE301", message: linkMessage(DEMO_WALLET.address, "0x00000000000000000000000000000000000DE301") },
''')
s=s.replace('import { emptyBook } from "../src/core/book.ts"','import { emptyBook, linkMessage } from "../src/core/book.ts"')
open(p,'w').write(s)
