K='macos/PricetagKit/Sources/PricetagKit/'
p=K+'ResolveModel.swift'; s=open(p).read()
s=s.replace('''    /// Asking what they paid, because they said it's their exchange account.''','''    /// What the cost being typed would do, once the server has said. Nothing's saved until it's confirmed.
    public private(set) var costPreview: BookPreview?
    /// Asking what they paid, because they said it's their exchange account.''')
s=s.replace('''    /// `dollars` is what was paid for everything from this sender, by asset, as typed. False when something isn't an amount.
    @discardableResult
    public func enterCost(_ dollars: [String: String]) -> Bool {
        guard let question = current else { return false }
        var micros: [String: String] = [:]
        for (asset, text) in dollars {
            guard let amount = Format.micros(fromDollars: text) else { return false }
            micros[asset] = amount
        }
        guard !micros.isEmpty else { return false }
        if let sender = question.sender {
            store.setBook(store.book.answering(sender, SenderAnswer(kind: .myExchange, costs: micros), focus: store.portfolio?.address))
        } else if let key = question.costKey, let cost = micros.values.first {
            store.setBook(store.book.enteringCost(key, usdMicros: cost))
        }
        advance()
        return true
    }
''','''    /// The books a typed cost leads to. nil until every amount reads as one.
    private func candidate(costs dollars: [String: String], for question: Question) -> Book? {
        var micros: [String: String] = [:]
        for arrival in question.arrivals {
            guard let amount = Format.micros(fromDollars: dollars[arrival.asset] ?? "") else { return nil }
            micros[arrival.asset] = amount
        }
        if let sender = question.sender {
            return store.book.answering(sender, SenderAnswer(kind: .myExchange, costs: micros), focus: store.portfolio?.address)
        }
        guard let key = question.costKey, let cost = micros.values.first else { return nil }
        return store.book.enteringCost(key, usdMicros: cost)
    }

    /// Reads what this cost would do, so it shows before the answer's final.
    public func previewCost(_ dollars: [String: String]) async {
        guard let question = current, let book = candidate(costs: dollars, for: question) else {
            costPreview = nil
            return
        }
        guard let answer = try? await store.previews(of: [book]).first, !Task.isCancelled, question.id == current?.id else { return }
        costPreview = answer
    }

    /// `dollars` is what was paid for everything that arrived, by asset, as typed. False when something isn't an amount.
    @discardableResult
    public func enterCost(_ dollars: [String: String]) -> Bool {
        guard let question = current, let book = candidate(costs: dollars, for: question) else { return false }
        store.setBook(book)
        advance()
        return true
    }
''')
s=s.replace('''        isAskingCost = false
        previews = [:]
''','''        isAskingCost = false
        previews = [:]
        costPreview = nil
''')
open(p,'w').write(s)

p=K+'Views/ResolveFlow.swift'; s=open(p).read()
s=s.replace('''    @FocusState private var isFocused: Bool

    public init''','''    @FocusState private var isFocused: Bool
    @FocusState private var focusedCost: String?

    public init''')
s=s.replace('''        .onKeyPress(.downArrow) {
            guard model.current != nil else { return .ignored }
            model.skip()''','''        .onKeyPress(.downArrow) {
            guard let question = model.current, !isTakingCost(question) else { return .ignored }
            model.skip()''')
s=s.replace('''        .sensoryFeedback(.success, trigger: model.isBalanced)''','''        .task(id: costs) {
            // Waits for a pause in the typing, so each keystroke isn't a request.
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await model.previewCost(costs)
        }
        .sensoryFeedback(.success, trigger: model.isBalanced)''')
s=s.replace('''                        .frame(width: 140)
                        .onSubmit { save(question) }
                }
            }
            HStack {''','''                        .frame(width: 140)
                        .focused($focusedCost, equals: arrival.asset)
                        .onSubmit { save(question) }
                }
            }
            if let preview = model.costPreview {
                LabeledContent("That would make it") {
                    Text(Wording.consequence(preview)).monospacedDigit().fontWeight(.medium)
                }
                .font(.callout)
            }
            HStack {''')
s=s.replace('''        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .id(question.id)
    }

    private func canSave''','''        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .id(question.id)
        .onAppear { focusedCost = question.arrivals.first?.asset }
    }

    private func canSave''')
open(p,'w').write(s)

p='macos/PricetagKit/Tests/PricetagKitTests/ResolveTests.swift'; s=open(p).read()
s=s.replace('''        #expect(!model.enterCost(["USDC": "nope"]), "not an amount")
        #expect(model.enterCost(["USDC": "$1,234.50"]))''','''        #expect(!model.enterCost(["USDC": "nope"]), "not an amount")
        await source.answerPreviews([BookPreview(pnlUsdMicros: "1000000", pnlStatus: .complete, estimatedUsdMicros: "0", unresolvedUsdMicros: "0", open: 0, pending: false)])
        await model.previewCost(["USDC": "$1,234.50"])
        #expect(model.costPreview.map(Wording.consequence) == "+$1.00")
        #expect(store.book.senders[try #require(first.sender)]?.costs == nil, "typing isn't answering")
        await model.previewCost(["USDC": "nope"])
        #expect(model.costPreview == nil)
        #expect(model.enterCost(["USDC": "$1,234.50"]))''')
open(p,'w').write(s)

p='src/ui/ResolvePanel.tsx'; s=open(p).read()
s=s.replace('''  const saveCost = () => {
    if (!current) return
    const entered = Object.fromEntries(current.arrivals.map((a) => [a.asset, microsOf(costs[a.asset] ?? "")]))
    if (Object.values(entered).includes(null)) return setMessage("That isn't an amount.")
    if (current.sender) answer({ kind: "my-exchange", costs: entered as Record<string, string> })
    else if (current.costKey) onChange({ ...book, costs: { ...book.costs, [current.costKey]: Object.values(entered)[0] as string } })
    setAsking(false)
  }
''','''  /** The book a typed cost leads to, or null until every amount reads as one. */
  const costBook = useMemo(() => {
    if (!current) return null
    const entered = Object.fromEntries(current.arrivals.map((a) => [a.asset, microsOf(costs[a.asset] ?? "")]))
    if (Object.values(entered).includes(null)) return null
    if (current.sender) return answerSender(book, wallet.address, current.sender, { kind: "my-exchange", costs: entered as Record<string, string> })
    return current.costKey ? { ...book, costs: { ...book.costs, [current.costKey]: Object.values(entered)[0] as string } } : null
  }, [current, costs, book, wallet.address])
  const saveCost = () => {
    if (!costBook) return setMessage("That isn't an amount.")
    onChange(costBook)
    setAsking(false)
  }
''')
s=s.replace('''              <div className="cost-actions">''','''              {costBook ? <p className="small">That would make it {consequence(previewBook(wallet, others as WalletResponse[], method, costBook))}</p> : null}
              <div className="cost-actions">''')
s=s.replace('''<input inputMode="decimal" placeholder="$0.00" value''','''<input autoFocus inputMode="decimal" placeholder="$0.00" value''')
open(p,'w').write(s)
