import Foundation
import KeyVault

/// What a site can read and ask for short of a signature. Whatever signs for a site is in `HotWallet.swift`, the only file that can reach the signer.
extension HotWallet {
    /// Why a site can't use this wallet right now, if it can't. Reads don't need any of this.
    public var siteProblem: SiteError? {
        guard availability == .ready else { return .stopped("This build of \(SiteWording.appName) can't hold a key.") }
        guard address != nil else { return .stopped("Set up \(HotWalletWording.title) in \(SiteWording.appName) first.") }
        if alarm != nil { return .stopped("\(SiteWording.appName) has stopped this wallet, because its key may be stolen.") }
        if rotation != nil { return .stopped("\(SiteWording.appName) is replacing this wallet's key. Try again once that's done.") }
        if isKeyMissing { return .stopped(HotWalletWording.keyMissing) }
        return nil
    }

    public var connectedSites: [String] { state.connectedSites ?? [] }


    func isConnected(_ origin: String) -> Bool {
        connectedSites.contains(origin)
    }

    func connectSite(_ origin: String) {
        guard !isConnected(origin) else { return }
        state.connectedSites = connectedSites + [origin]
        persistOrSayWhy()
    }

    func disconnectSite(_ origin: String) {
        state.connectedSites?.removeAll { $0 == origin }
        persistOrSayWhy()
    }

    func readForSite(_ method: String, _ parameters: JSONValue) async throws -> RPCAnswer {
        // A node on another chain would tell a site things that aren't true of Base.
        if let snapshot, snapshot.chainID != Base.chainID { return .failure(.wrongChain) }
        return try await chain.read(method, parameters)
    }

    /// What a transaction would cost. What's signed later keeps to this gas and fee per gas. Its L1 data fee goes by its real size,
    /// which a site's data can make far bigger than a sweep.
    func quoteForSite(_ transaction: SiteTransaction) async throws -> SiteQuote {
        guard let address else { throw ChainError.unreadable }
        let snapshot = try await readToQuote(address)
        let estimate: UInt64
        do {
            estimate = try await chain.estimateGas(from: address, to: transaction.to, value: transaction.value, data: transaction.data)
        } catch ChainError.rejected(let message) {
            // The node worked out what it would do, and it fails. Nothing good comes of signing that.
            throw ChainError.rejected(HotWalletWording.wouldFail + message)
        }
        let gasLimit = FeeQuote.gasLimit(estimate: estimate, isPlainSend: transaction.data.isEmpty)
        let unsigned = UnsignedTransaction(
            chainID: Base.chainID,
            nonce: snapshot.nonce,
            maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas,
            maxFeePerGas: snapshot.fees.maxFeePerGas,
            gasLimit: gasLimit,
            to: transaction.to,
            value: transaction.value,
            data: transaction.data
        )
        let l1Fee = try await chain.l1Fee(ofPayload: unsigned.signingPayload)
        let fees = FeeQuote(maxFeePerGas: snapshot.fees.maxFeePerGas, maxPriorityFeePerGas: snapshot.fees.maxPriorityFeePerGas, l1FeeWei: l1Fee)
        guard fees.isPlausible else { throw ChainError.rejected(HotWalletWording.feesLookWrong) }
        var quote = SiteQuote(
            gasLimit: gasLimit,
            maxFeePerGas: snapshot.fees.maxFeePerGas,
            feeWei: fees.costWei(gas: UInt128(gasLimit)),
            ethUsdMicros: snapshot.ethUsdMicros,
            ethBalance: snapshot.balances[Base.eth] ?? 0,
            tokenUsdMicros: Base.tokens.first { $0.contract == transaction.to }.flatMap { price(of: $0, snapshot: snapshot) }
        )
        if TransactionReview(transaction, quote: quote).isUnreadableCall {
            quote.preview = await preview(of: transaction, from: address, gasLimit: gasLimit, snapshot: snapshot)
        }
        return quote
    }

    /// What the node says a call would do. It sees what's about to be sent, as it does for the estimate above. A node that can't do this,
    /// says no, or doesn't answer clearly leaves the approval saying what it always did.
    private func preview(of transaction: SiteTransaction, from address: EthereumAddress, gasLimit: UInt64, snapshot: ChainSnapshot) async -> CallPreview? {
        let parameters = CallSimulation.parameters(transaction, from: address, nonce: snapshot.nonce, gasLimit: gasLimit, fees: snapshot.fees)
        guard case .success(let result)? = try? await chain.read(CallSimulation.method, parameters), let simulation = CallSimulation(result, wallet: address, value: transaction.value) else { return nil }
        // A snapshot only has prices for what's held, and what a swap brings in usually isn't.
        var prices: [Token: UInt128] = [:]
        for token in simulation.tokens {
            if let known = price(of: token, snapshot: snapshot) {
                prices[token] = known
            } else if let feed = Oracle.others[token.asset], let blockTime = simulation.blockTime {
                let call: JSONValue = .object(["to": .string(feed.address.lowercased), "data": .string("0x" + Hex.encode(Calldata.latestRoundData))])
                if case .success(.string(let round))? = try? await chain.read("eth_call", .array([call, .string("latest")])) {
                    prices[token] = Oracle.price(round, feed: feed, blockTime: blockTime, ethUsdMicros: snapshot.ethUsdMicros)
                }
            }
        }
        return simulation.preview { prices[$0] }
    }

    /// What this key signed for sites that may still be used, newest first. An expired one can't be, whatever else is known about it.
    public var signedPermits: [SignedPermit] {
        guard let address else { return [] }
        let time = now()
        return (state.signedPermits?[address] ?? []).filter { !$0.hasExpired(at: time) }.reversed()
    }

    /// Asks the chain about each one, and forgets it only once that's proof it can't be used, or once it's expired. Anything that
    /// doesn't answer stays listed, because a permit that can't be checked may still work.
    public func checkSignedPermits() async {
        guard let address, !isCheckingPermits else { return }
        isCheckingPermits = true
        defer { isCheckingPermits = false }
        let time = now()
        let permits = state.signedPermits?[address] ?? []
        let open = permits.filter { !$0.hasExpired(at: time) }
        // Settings can change the node while this waits, and only the node that said it's on Base gets to answer.
        let chain = chain
        // A node on another chain could answer anything about these, so only Base's answers count.
        var isBase = false
        if open.contains(where: { $0.terms != nil }) { isBase = (try? await chain.read("eth_chainId", .array([])))?.isBaseChainID == true }
        var spent = Set<String>()
        var checks: [String: SignedPermit.Check] = [:]
        for permit in open {
            guard let terms = permit.terms else { continue }
            checks[permit.id] = .couldntCheck
            guard isBase, let read = terms.read(owner: address),
                  case .success(let answer)? = try? await chain.read("eth_call", .array([.object(["to": .string(read.to.lowercased), "data": .string("0x" + Hex.encode(read.data))]), .string("latest")])),
                  let bytes = answer.string.flatMap(Hex.decode), let isSpent = terms.isSpent(given: bytes) else { continue }
            if isSpent { spent.insert(permit.id) } else { checks[permit.id] = .notUsed }
        }
        permitChecks = checks
        let expired = Set(permits.filter { $0.hasExpired(at: time) }.map(\.id))
        guard !spent.isEmpty || !expired.isEmpty else { return }
        // More may have been signed while this was reading, so this only takes out what it knows about.
        state.signedPermits?[address]?.removeAll { spent.contains($0.id) || expired.contains($0.id) }
        // If this doesn't reach the disk, the next check finds the same again.
        persistOrSayWhy()
    }
}
