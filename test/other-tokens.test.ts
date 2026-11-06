import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from "viem"
import { combineOtherTokens, cleanText, createOtherTokens, decodeAggregate3, decodeText, decodeTokenFacts, encodeAggregate3, encodeTokenFacts, MAX_OTHER_TOKENS, tuckedReason, USDC_ADDRESS, type LegRow, type OtherToken, type TokenAnswer, type TokenRequest } from "@pricetag/sdk/core"
import { foldWallet } from "@pricetag/sdk/core"
import { DEMO_WALLET } from "../src/core/fixtures.ts"
import { noMarketSentence, otherTokenAmount, otherTokenName, otherTokensLeftOutSentence, OTHER_TOKENS_NOTE, OTHER_TOKENS_TITLE, POSSIBLE_SPAM_RULE, POSSIBLE_SPAM_TITLE } from "../src/core/wording.ts"
import { assertMatchesFixture } from "./support/fixtures.ts"

const ME = "0x00000000000000000000000000000000000000aa"
const JACK = "0x00000000000000000000000000000000000000f1"
const QUIET = () => {}
const logger = { warn: QUIET }

const hex = (value: `0x${string}`) => value.slice(2)
const stringAnswer = (text: string) => hex(encodeAbiParameters(parseAbiParameters("string"), [text]))
const wordAnswer = (value: bigint) => value.toString(16).padStart(64, "0")
const aggregateResult = (results: (string | null)[]) => hex(encodeAbiParameters(parseAbiParameters("(bool, bytes)[]"), [results.map((r) => [r !== null, `0x${r ?? ""}`] as const)]))

function row(token: string, side: LegRow["side"], amount: string, changes: Partial<LegRow> = {}): LegRow {
  return { block_num: 100, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: "0xincoming", tx_index: 0, log_index: 0, token, account: ME, side, amount, kind: "unlisted", counterparty: null, ...changes } as LegRow
}
const gas = (tx_hash: string) => row("0x0000000000000000000000000000000000000000", "debit", "1", { kind: "gas", tx_hash })
const none = new Map<string, number>()

/** Answers like a chain with these tokens, counting queries. */
function fakeChain(tokens: Record<string, TokenAnswer | "gas bomb" | "hangs">) {
  const queries: TokenRequest[][] = []
  const read = async (_account: string, requests: readonly TokenRequest[]) => {
    queries.push([...requests])
    if (requests.some(({ token }) => tokens[token] === "hangs")) throw new Error("Query timed out")
    const bomb = requests.findIndex(({ token }) => tokens[token] === "gas bomb")
    if (bomb !== -1 && requests.length === 1) return null
    return new Map(
      requests.map(({ token }, i) => {
        const answer = tokens[token]
        // Everything after a contract that used up the gas fails too.
        if (bomb !== -1 && i >= bomb) return [token, { balance: null, decimals: null, name: null, symbol: null }]
        return [token, typeof answer === "object" ? answer : { balance: "0", name: null, symbol: null, decimals: null }]
      }),
    )
  }
  return { read, queries }
}

const good = (symbol: string, balance = "5000000000000000000"): TokenAnswer => ({ name: `${symbol} Token`, symbol, decimals: 18, balance })

/** Reads until nothing's due, the way a wallet's reads would, and says how many passes that took. */
async function fill(tokens: ReturnType<typeof createOtherTokens>, rows: readonly LegRow[], block = 200, passes = 40) {
  for (let i = 0; i < passes; i++) {
    tokens.update(ME, rows, none, block)
    await tokens.idle()
  }
  return tokens.view(ME, rows, none)
}

describe("reading a token's contract", () => {
  const requests: TokenRequest[] = [
    { token: JACK, balance: true, details: true, decimals: true },
    { token: USDC_ADDRESS, balance: true, details: false, decimals: false },
  ]

  it("encodes what viem reads back as the same calls", () => {
    const [calls] = decodeAbiParameters(parseAbiParameters("(address, bool, bytes)[]"), `0x${encodeTokenFacts(ME, requests).slice(8)}`)
    assert.deepEqual(calls.map(([target, allowFailure, data]) => [target.toLowerCase(), allowFailure, data]), [
      [JACK, true, `0x70a08231${ME.slice(2).padStart(64, "0")}`],
      [JACK, true, "0x06fdde03"],
      [JACK, true, "0x95d89b41"],
      [JACK, true, "0x313ce567"],
      [USDC_ADDRESS, true, `0x70a08231${ME.slice(2).padStart(64, "0")}`],
    ])
    assert.equal(encodeAggregate3([]).length, 8 + 128)
  })

  it("decodes answers, and a call that failed stays apart from the rest", () => {
    const data = aggregateResult([wordAnswer(7n), stringAnswer("Jackfruit"), stringAnswer("JACK"), wordAnswer(18n), null])
    const answers = decodeTokenFacts(data, requests)
    assert.deepEqual(answers?.get(JACK), { balance: "7", name: "Jackfruit", symbol: "JACK", decimals: 18 })
    assert.deepEqual(answers?.get(USDC_ADDRESS), { balance: null })
  })

  it("gives nothing for bytes that aren't an answer to these calls, rather than throwing", () => {
    for (const data of [null, undefined, "", "zz", "00", "ff".repeat(32), "ff".repeat(96), aggregateResult([wordAnswer(1n)])]) assert.equal(decodeTokenFacts(data, requests), null)
    // Offsets that point past the end, or at nowhere sensible.
    const lying = `${word(32)}${word(1)}${word(2n ** 255n)}`
    assert.equal(decodeAggregate3(lying, 1), null)
    const longerThanItIs = `${word(32)}${word(1)}${word(32)}${word(1)}${word(64)}${word(10_000)}`
    assert.equal(decodeAggregate3(longerThanItIs, 1), null)
  })

  it("takes a name as a string or an old token's bytes32", () => {
    assert.equal(decodeText(stringAnswer("Maker"), 64), "Maker")
    assert.equal(decodeText(Buffer.from("MKR").toString("hex").padEnd(64, "0"), 16), "MKR")
  })

  it("won't take a name that isn't text, is empty or is far too long", () => {
    assert.equal(decodeText(null, 64), null)
    assert.equal(decodeText("", 64), null)
    assert.equal(decodeText(stringAnswer("x".repeat(257)), 64), null)
    assert.equal(decodeText(`${word(32)}${word(4)}${"ff".repeat(4).padEnd(64, "0")}`, 64), null, "not UTF-8")
    assert.equal(decodeText(`${word(0)}${word(4)}${"41".repeat(4).padEnd(64, "0")}`, 64), null, "a bad offset")
    assert.equal(decodeText(`${word(32)}${word(2n ** 200n)}`, 64), null, "a length that can't be")
    assert.equal(decodeText(stringAnswer(""), 64), null)
  })

  it("rejects decimals no real token has, and a balance that isn't one word", () => {
    const one: TokenRequest[] = [{ token: JACK, balance: true, details: false, decimals: true }]
    assert.deepEqual(decodeTokenFacts(aggregateResult(["12", wordAnswer(255n)]), one)?.get(JACK), { balance: null, decimals: null })
    assert.deepEqual(decodeTokenFacts(aggregateResult([wordAnswer(2n ** 256n - 1n), wordAnswer(36n)]), one)?.get(JACK), { balance: (2n ** 256n - 1n).toString(), decimals: 36 })
  })

  it("cleans up what's going on a screen", () => {
    assert.equal(cleanText("‮CDSU‬", 16), "CDSU", "direction overrides")
    assert.equal(cleanText("US​DC\u0000\n", 16), "USDC", "invisible characters")
    assert.equal(cleanText("  two   words ", 16), "two words")
    assert.equal(cleanText("á̂̃̄b", 16), "\u00e1b", "marks piled on a letter")
    assert.equal(cleanText("é", 16), "é")
    assert.equal(cleanText("日本語トークン", 16), "日本語トークン")
    assert.equal(cleanText("x".repeat(20), 16), `${"x".repeat(15)}…`)
    assert.equal(cleanText("​ \u0000", 16), null)
  })
})

describe("what gets tucked away", () => {
  const read = { state: "read" as const }
  const named = (name: string | null, symbol: string | null) => ({ ...read, name, symbol })

  it("leaves alone a token this wallet's own transaction moved", () => {
    assert.equal(tuckedReason(named("Jackfruit", "JACK"), true), null)
    assert.equal(tuckedReason(named("日本語", "ニホン"), true), null)
    assert.equal(tuckedReason(named("Brett", "BRETT"), true), null)
    assert.equal(tuckedReason(named("Claimable Yield", "CLY"), true), null, "a word inside another isn't enough")
  })

  it("tucks away what arrived on its own, without calling it worthless", () => {
    const reason = tuckedReason(named("Jackfruit", "JACK"), false)
    assert.equal(reason, "It arrived without any transaction of yours.")
    assert.doesNotMatch(reason as string, /worthless|scam|spam/i)
  })

  it("tucks away a copy of a token we know, even one this wallet bought", () => {
    for (const [name, symbol] of [["USD Coin", "USDC"], ["USD Coin", "usdc"], ["Whatever", "USDС"], ["Whatever", "U.S.D.C"], ["Ether", "XYZ"], ["Tether USD", "XYZ"], ["Whatever", "ＥＴＨ"], ["Whatever", "U​SDC"], ["Whatever", "AERO"]] as const) {
      assert.match(tuckedReason(named(name, cleanText(symbol, 16)), true) ?? "", /calls itself/, `${name} ${symbol}`)
    }
  })

  it("sees through the letters real copies use, ahead of a contract that won't answer", () => {
    // Read from the two contracts at 0x80228d1e… and 0x08779bf3… on Base, which are what a wallet was sent.
    for (const [name, symbol, copied] of [["\u13AC\u0422\u13BB", "\u0415\u13A2\u13BB", "ETH"], ["\u054D\u054F" + "D \u13DF\u0585i\u0578", "\u144C\u0405D\u03F9", "USDC"]] as const) {
      assert.equal(tuckedReason({ name, symbol, state: "unreadable" }, false), `It calls itself ${copied}, but it isn't the real ${copied}.`)
    }
  })

  it("tucks away a name that sends you to a website", () => {
    for (const name of ["Visit usdc-rewards.com", "https://x.co", "claim at example.xyz", "www.free", "Claim your tokens"]) assert.match(tuckedReason(named(name, "X"), true) ?? "", /website/, name)
  })

  it("tucks away a contract that won't answer, and says so", () => {
    assert.equal(tuckedReason({ name: null, symbol: null, state: "unreadable" }, true), "Its contract doesn't answer properly.")
  })
})

describe("other tokens", () => {
  it("shows a token with what its contract says, once it's been read", async () => {
    const { read } = fakeChain({ [JACK]: good("JACK") })
    const tokens = createOtherTokens(read, logger)
    const rows = [row(JACK, "credit", "5000000000000000000", { tx_hash: "0xmine" }), gas("0xmine")]
    assert.deepEqual(tokens.view(ME, rows, none).otherTokens.map((t) => [t.state, t.balance, t.tucked]), [["reading", null, null]], "it's there before anything's read, and has no balance yet, rather than 0")
    assert.deepEqual((await fill(tokens, rows)).otherTokens, [{ token: JACK, kind: "token", name: "JACK Token", symbol: "JACK", decimals: 18, balance: "5000000000000000000", state: "read", note: null, tucked: null }])
  })

  it("reads what's held on the chain, not what the rows add up to", async () => {
    // Most of this was there before the first block, so the rows alone say it's gone.
    const { read } = fakeChain({ [JACK]: good("JACK", "900") })
    const tokens = createOtherTokens(read, logger)
    const rows = [row(JACK, "debit", "100", { tx_hash: "0xmine" }), gas("0xmine")]
    assert.equal((await fill(tokens, rows)).otherTokens[0]?.balance, "900")
  })

  it("drops what's no longer held", async () => {
    const { read } = fakeChain({ [JACK]: good("JACK", "0") })
    const tokens = createOtherTokens(read, logger)
    assert.deepEqual((await fill(tokens, [row(JACK, "credit", "7")])).otherTokens, [])
  })

  it("doesn't list a zero-value transfer, which is how address poisoning looks", async () => {
    const { read, queries } = fakeChain({ [JACK]: good("JACK", "0") })
    const tokens = createOtherTokens(read, logger)
    assert.deepEqual(tokens.view(ME, [row(JACK, "credit", "0")], none).otherTokens, [])
    await fill(tokens, [row(JACK, "credit", "0")])
    assert.equal(queries.length, 1, "and once it's read as empty, it's never asked about again")
  })

  describe("a token whose rows don't add up to anything held", () => {
    // It held 10 from before the first block and sent 2, so the rows say -2.
    const spent = [row(JACK, "debit", "2", { tx_hash: "0xmine" }), gas("0xmine")]
    const sentThrough = [row(JACK, "credit", "2", { block_num: 90 }), row(JACK, "debit", "2", { tx_hash: "0xmine" }), gas("0xmine")]
    const noAnswer = { balance: null, name: null, symbol: null, decimals: null }

    for (const [what, rows] of [["sent more than it received", spent], ["sent all it received", sentThrough]] as const) {
      it(`stays listed with no amount while it has ${what} and its first read fails`, async () => {
        const tokens = createOtherTokens(fakeChain({ [JACK]: noAnswer }).read, logger)
        assert.deepEqual(tokens.view(ME, rows, none).otherTokens.map((t) => [t.state, t.balance]), [["reading", null]], "before it's read")
        const { otherTokens } = await fill(tokens, rows)
        assert.deepEqual(otherTokens.map((t) => [t.state, t.balance]), [["unreadable", null]])
      })
    }

    it("goes by the balance once there is one", async () => {
      const answers: Record<string, TokenAnswer> = { [JACK]: noAnswer }
      let time = 1_000_000
      const tokens = createOtherTokens(fakeChain(answers).read, logger, () => time)
      await fill(tokens, spent, 200, 1)
      answers[JACK] = good("JACK", "8")
      time += 11 * 60_000
      assert.deepEqual((await fill(tokens, spent, 300, 1)).otherTokens.map((t) => [t.state, t.balance]), [["read", "8"]])
      answers[JACK] = good("JACK", "0")
      time += 6 * 60_000
      assert.deepEqual((await fill(tokens, spent, 400, 1)).otherTokens, [])
    })

    it("makes a sum across wallets unknown rather than leaving this wallet out", async () => {
      const tokens = createOtherTokens(fakeChain({ [JACK]: noAnswer }).read, logger)
      const elsewhere = { otherTokens: [{ token: JACK, kind: "token" as const, name: "JACK Token", symbol: "JACK", decimals: 18, balance: "5", state: "read" as const, note: null, tucked: null }], otherTokensLeftOut: 0 }
      const [token] = combineOtherTokens([await fill(tokens, spent), elsewhere]).otherTokens
      assert.deepEqual([token?.state, token?.balance], ["unreadable", null])
    })

    it("stays listed at an earlier block too", async () => {
      const tokens = createOtherTokens(fakeChain({ [JACK]: noAnswer }).read, logger)
      await fill(tokens, spent)
      assert.deepEqual(tokens.viewAt(ME, spent, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["unreadable", null]])
      assert.deepEqual(createOtherTokens(fakeChain({}).read, logger).viewAt(ME, spent, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["reading", null]])
    })

    it("still leaves out a zero-value transfer whose read fails, at any block", async () => {
      const poison = [row(JACK, "credit", "0"), row(JACK, "debit", "0")]
      const tokens = createOtherTokens(fakeChain({ [JACK]: noAnswer }).read, logger)
      assert.deepEqual((await fill(tokens, poison)).otherTokens, [])
      assert.deepEqual(tokens.viewAt(ME, poison, none, 150).otherTokens, [])
    })
  })

  it("is only reads: what's in `otherTokens` isn't in the fold", () => {
    const without = foldWallet({ ...DEMO_WALLET, otherTokens: [], otherTokensLeftOut: 0 }, "average")
    const huge: OtherToken = { token: JACK, kind: "token", name: "Rich", symbol: "RICH", decimals: 0, balance: (10n ** 40n).toString(), state: "read", note: null, tucked: null }
    const withThem = foldWallet({ ...DEMO_WALLET, otherTokens: [huge], otherTokensLeftOut: 3 }, "average")
    assert.deepEqual(withThem.totals, without.totals)
    assert.deepEqual(withThem.positions, without.positions)
    assert.ok(!withThem.positions.some((p) => p.asset === "RICH"))
  })

  describe("a contract that gives bad answers", () => {
    const rows = [row(JACK, "credit", "7", { tx_hash: "0xmine" }), gas("0xmine")]

    it("says so, and stays listed since the rows say it's held", async () => {
      const { read } = fakeChain({ [JACK]: { balance: null, name: null, symbol: null, decimals: null } })
      const [token] = (await fill(createOtherTokens(read, logger), rows)).otherTokens
      assert.equal(token?.state, "unreadable")
      assert.equal(token?.balance, null)
      assert.match(token?.note ?? "", /didn't answer/)
      assert.match(token?.tucked ?? "", /doesn't answer properly/)
    })

    it("counts in its smallest unit when it won't give decimals", async () => {
      const { read } = fakeChain({ [JACK]: { balance: "7", name: "Odd", symbol: "ODD", decimals: null } })
      const [token] = (await fill(createOtherTokens(read, logger), rows)).otherTokens
      assert.equal(token?.decimals, null)
      assert.equal(otherTokenAmount(token as OtherToken), "7 units")
      assert.match(token?.note ?? "", /smallest unit/)
    })

    it("doesn't take the others with it, even when it uses up all the gas", async () => {
      const others = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
      const bomb = others[0] as string
      const { read } = fakeChain({ ...Object.fromEntries(others.map((t) => [t, good(`T${t.slice(-2)}`)])), [bomb]: "gas bomb" })
      const allRows = others.flatMap((t) => [row(t, "credit", "7", { tx_hash: "0xmine" })]).concat(gas("0xmine"))
      const tokens = createOtherTokens(read, logger)
      const { otherTokens } = await fill(tokens, allRows)
      assert.equal(otherTokens.filter((t) => t.state === "read").length, 29)
      assert.deepEqual(otherTokens.filter((t) => t.state === "unreadable").map((t) => t.token), [bomb])
    })

    it("backs off from one that hangs, and a failed query doesn't fail a read", async () => {
      let time = 1_000_000
      const { read, queries } = fakeChain({ [JACK]: "hangs" })
      const tokens = createOtherTokens(read, logger, () => time)
      tokens.update(ME, rows, none, 200)
      await tokens.idle()
      assert.equal(queries.length, 1)
      tokens.update(ME, rows, none, 201)
      await tokens.idle()
      assert.equal(queries.length, 1, "nothing during the backoff")
      assert.equal(tokens.view(ME, rows, none).otherTokens[0]?.state, "unreadable")
      time += 11 * 60_000
      tokens.update(ME, rows, none, 202)
      await tokens.idle()
      assert.equal(queries.length, 2, "tried again later")
    })

    it("doesn't call an old balance current after a failed read, and has it back once there's an answer", async () => {
      let time = 1_000_000
      const answers: Record<string, TokenAnswer> = { [JACK]: good("JACK", "5") }
      const tokens = createOtherTokens(fakeChain(answers).read, logger, () => time)
      await fill(tokens, rows, 200, 1)
      answers[JACK] = { balance: null }
      time += 6 * 60_000
      const [failed] = (await fill(tokens, rows, 300, 1)).otherTokens
      assert.deepEqual([failed?.state, failed?.balance], ["unreadable", null])
      assert.match(failed?.note ?? "", /isn't known right now/)
      assert.equal(failed?.tucked, null, "it answered before, so one bad answer doesn't make it look like spam")
      answers[JACK] = { balance: "6" }
      time += 11 * 60_000
      const [back] = (await fill(tokens, rows, 400, 1)).otherTokens
      assert.deepEqual([back?.state, back?.balance, back?.note], ["read", "6", null])
    })

    it("still lists what it held when a failed read follows sending it all away", async () => {
      const answers: Record<string, TokenAnswer> = { [JACK]: good("JACK", "5") }
      const tokens = createOtherTokens(fakeChain(answers).read, logger)
      await fill(tokens, rows, 200, 1)
      answers[JACK] = { balance: null }
      const sentAll = [...rows, row(JACK, "debit", "7", { block_num: 250, tx_hash: "0xmine" })]
      const [token] = (await fill(tokens, sentAll, 300, 1)).otherTokens
      assert.deepEqual([token?.state, token?.balance], ["unreadable", null])
    })

    describe("when the query it shared with another token fails", () => {
      const OTHER = "0x00000000000000000000000000000000000000f2"
      const both = [...rows, row(OTHER, "credit", "7", { tx_hash: "0xmine" })]
      const failing = async (failure: TokenAnswer | "hangs") => {
        const clock = { time: 1_000_000 }
        const answers: Record<string, TokenAnswer | "hangs"> = { [JACK]: good("JACK", "5"), [OTHER]: good("OTHER", "5") }
        const { read, queries } = fakeChain(answers)
        const tokens = createOtherTokens(read, logger, () => clock.time)
        await fill(tokens, both, 200, 1)
        queries.length = 0
        answers[JACK] = failure
        clock.time += 6 * 60_000
        const failed = await fill(tokens, both, 300, 1)
        return { clock, answers, queries, tokens, failed }
      }
      const jackIn = ({ otherTokens }: { otherTokens: OtherToken[] }) => otherTokens.find((t) => t.token === JACK)
      const shown = (token: OtherToken | undefined) => [token?.state, token?.balance, token?.note]

      it("doesn't show an old balance as current when one answer in it fails, and asks again on its own right away", async () => {
        const { answers, queries, tokens, failed } = await failing({ balance: null })
        assert.deepEqual(queries.map((q) => q.length), [2])
        assert.deepEqual(shown(jackIn(failed)), ["unreadable", null, "Its contract answered before but not the last time it was asked, so this wallet's balance isn't known right now."])
        assert.equal(jackIn(failed)?.tucked, null, "nothing's been blamed yet, so it doesn't look like spam")
        answers[JACK] = good("JACK", "6")
        const back = await fill(tokens, both, 301, 1)
        assert.deepEqual(queries[1]?.map((q) => q.token), [JACK], "the retry doesn't wait for a bad answer's 10 minutes")
        assert.deepEqual(shown(jackIn(back)), ["read", "6", null])
      })

      it("doesn't show an old balance as current when the query times out, and asks again in a smaller group after the backoff", async () => {
        const { answers, queries, tokens, failed, clock } = await failing("hangs")
        assert.deepEqual(failed.otherTokens.map(shown).map(([state, balance]) => [state, balance]), [["unreadable", null], ["unreadable", null]])
        await fill(tokens, both, 301, 1)
        assert.equal(queries.length, 1, "nothing during the backoff")
        answers[JACK] = good("JACK", "6")
        clock.time += 61_000
        const back = await fill(tokens, both, 302, 1)
        assert.deepEqual(queries.slice(1).map((q) => q.length), [1, 1], "well before a bad answer's 10 minutes")
        assert.deepEqual(back.otherTokens.map(shown), [["read", "6", null], ["read", "5", null]])
      })

      it("stops asking every read once the contract has had a query to itself", async () => {
        const { queries, tokens, failed } = await failing({ balance: null })
        assert.equal(jackIn(failed)?.state, "unreadable")
        await fill(tokens, both, 301, 1)
        const asked = queries.length
        assert.equal(jackIn(await fill(tokens, both, 302, 3))?.state, "unreadable")
        assert.equal(queries.length, asked)
      })
    })

    it("doesn't call a balance current past a move it hasn't read yet", async () => {
      const tokens = createOtherTokens(fakeChain({ [JACK]: good("JACK", "5") }).read, logger)
      await fill(tokens, rows, 200, 1)
      const moved = [...rows, row(JACK, "debit", "7", { block_num: 250, tx_hash: "0xmine" })]
      const [token] = tokens.view(ME, moved, none).otherTokens
      assert.deepEqual([token?.state, token?.balance], ["reading", null])
    })
  })

  describe("how much it reads", () => {
    const many = (count: number) => Array.from({ length: count }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`)
    const rowsOf = (tokens: readonly string[], mine: boolean) => tokens.map((t, i) => row(t, "credit", "7", { block_num: 100 + i, tx_hash: mine ? "0xmine" : "0xincoming" })).concat(mine ? [gas("0xmine")] : [])

    it("makes at most two queries each time, and stops when a wallet read is waiting", async () => {
      const addresses = many(200)
      const { read, queries } = fakeChain(Object.fromEntries(addresses.map((t) => [t, good("X")])))
      const tokens = createOtherTokens(read, logger)
      tokens.update(ME, rowsOf(addresses, true), none, 500)
      await tokens.idle()
      assert.equal(queries.length, 2)
      assert.ok(queries.every((q) => q.length <= 25))
      tokens.update(ME, rowsOf(addresses, true), none, 500, () => true)
      await tokens.idle()
      assert.equal(queries.length, 2)
    })

    it("only starts one at a time, whichever wallet asks", async () => {
      const { read, queries } = fakeChain({ [JACK]: good("JACK") })
      const tokens = createOtherTokens(read, logger)
      const rows = [row(JACK, "credit", "7")]
      tokens.update(ME, rows, none, 200)
      tokens.update(ME, rows, none, 200)
      await tokens.idle()
      assert.equal(queries.length, 1)
    })

    describe("with several wallets", () => {
      const OTHER = "0x00000000000000000000000000000000000000bb"
      const addresses = many(100)
      const rowsFor = (account: string) => addresses.map((t, i) => row(t, "credit", "7", { account, block_num: 100 + i }))
      const accountsRead = () => {
        const seen: string[] = []
        const read = async (account: string, requests: readonly TokenRequest[]) => {
          seen.push(account)
          return new Map(requests.map(({ token }) => [token, good("X")]))
        }
        return { seen, read }
      }

      it("gives each its turn when one always finishes while another is still being read", async () => {
        const { seen, read } = accountsRead()
        const tokens = createOtherTokens(read, logger)
        let reading = 2
        const isBusy = () => reading > 0
        for (let round = 0; round < 2; round++) {
          reading = 1
          tokens.update(ME, rowsFor(ME), none, 500, isBusy)
          await tokens.idle()
          assert.equal(seen.length, round * 4, "nothing while a wallet read is waiting")
          reading = 0
          tokens.update(OTHER, rowsFor(OTHER), none, 500, isBusy)
          await tokens.idle()
          assert.equal(seen.length, (round + 1) * 4, "two queries for each wallet read")
        }
        assert.deepEqual(seen, [ME, ME, OTHER, OTHER, ME, ME, OTHER, OTHER])
        for (const account of [ME, OTHER]) assert.ok(tokens.view(account, rowsFor(account), none).otherTokens.every((t) => t.state === "read"))
      })

      it("keeps one place in line however often a wallet asks", async () => {
        const { seen, read } = accountsRead()
        const tokens = createOtherTokens(read, logger)
        let busy = true
        for (const account of [ME, OTHER, ME, ME]) tokens.update(account, rowsFor(account), none, 500, () => busy)
        await tokens.idle()
        assert.equal(seen.length, 0)
        busy = false
        tokens.resume()
        await tokens.idle()
        assert.deepEqual(seen, [ME, ME, OTHER, OTHER])
      })

      it("doesn't read for a wallet in line what a reorg replaced", async () => {
        const { seen, read } = accountsRead()
        const tokens = createOtherTokens(read, logger)
        let busy = true
        tokens.update(ME, rowsFor(ME), none, 500, () => busy)
        await tokens.idle()
        tokens.forgetFrom(450)
        busy = false
        tokens.resume()
        await tokens.idle()
        assert.equal(seen.length, 0)
      })
    })

    it("costs nothing once it's read, until a token moves or its balance is old", async () => {
      let time = 1_000_000
      const { read, queries } = fakeChain({ [JACK]: good("JACK") })
      const tokens = createOtherTokens(read, logger, () => time)
      const rows = [row(JACK, "credit", "7")]
      await fill(tokens, rows)
      assert.equal(queries.length, 1)
      assert.deepEqual(queries[0], [{ token: JACK, balance: true, details: true, decimals: true }])

      await fill(tokens, [...rows, row(JACK, "credit", "1", { block_num: 150 })], 200)
      assert.equal(queries.length, 1, "a block it has already read past")
      await fill(tokens, [...rows, row(JACK, "credit", "1", { block_num: 250 })], 250)
      assert.deepEqual(queries[1], [{ token: JACK, balance: true, details: false, decimals: false }], "what it says about itself isn't asked again")

      time += 6 * 60_000
      await fill(tokens, [...rows, row(JACK, "credit", "1", { block_num: 250 })], 300)
      assert.equal(queries.length, 3)
    })

    it(`caps a wallet at ${MAX_OTHER_TOKENS}, keeping what it sent itself and what's newest, and says how many it left out`, async () => {
      const spam = many(MAX_OTHER_TOKENS + 50)
      const mine = "0x00000000000000000000000000000000000fffff"
      const tokens = createOtherTokens(fakeChain({}).read, logger)
      const rows = [...rowsOf(spam, false), row(mine, "credit", "7", { block_num: 1, tx_hash: "0xmine" }), gas("0xmine")]
      const { otherTokens, otherTokensLeftOut } = tokens.view(ME, rows, none)
      assert.equal(otherTokens.length, MAX_OTHER_TOKENS)
      assert.equal(otherTokensLeftOut, 51)
      assert.ok(otherTokens.some((t) => t.token === mine), "the oldest, but it's the one this wallet moved")
      assert.ok(otherTokens.some((t) => t.token === spam.at(-1)))
      assert.ok(!otherTokens.some((t) => t.token === spam[0]))
    })

    it("finishes a wallet with hundreds in a bounded number of reads", async () => {
      const addresses = many(MAX_OTHER_TOKENS)
      const { read, queries } = fakeChain(Object.fromEntries(addresses.map((t) => [t, good("X")])))
      const tokens = createOtherTokens(read, logger)
      await fill(tokens, rowsOf(addresses, true), 1000, 6)
      assert.equal(queries.length, 12)
      assert.ok(tokens.view(ME, rowsOf(addresses, true), none).otherTokens.every((t) => t.state === "read"))
    })
  })

  it("forgets balances from blocks a reorg replaced, and keeps what a contract says about itself", async () => {
    const { read, queries } = fakeChain({ [JACK]: good("JACK") })
    const tokens = createOtherTokens(read, logger)
    const rows = [row(JACK, "credit", "7")]
    await fill(tokens, rows, 200)
    tokens.forgetFrom(150)
    assert.equal(tokens.view(ME, rows, none).otherTokens[0]?.state, "reading")
    await fill(tokens, rows, 200)
    assert.deepEqual(queries[1], [{ token: JACK, balance: true, details: false, decimals: false }])
  })

  it("doesn't keep a read that crossed a reorg", async () => {
    let release = () => {}
    const tokens = createOtherTokens(async (_a, requests) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return new Map(requests.map(({ token }) => [token, good("JACK")]))
    }, logger)
    const rows = [row(JACK, "credit", "7")]
    tokens.update(ME, rows, none, 200)
    await new Promise((resolve) => setImmediate(resolve))
    tokens.forgetFrom(150)
    release()
    await tokens.idle()
    assert.equal(tokens.view(ME, rows, none).otherTokens[0]?.state, "reading")
  })

  it("calls a collectible's balance a count, and doesn't blame one with no decimals", async () => {
    const NFT = "0x00000000000000000000000000000000000000f3"
    const { read, queries } = fakeChain({ [NFT]: { balance: "2", name: "Cats", symbol: "CAT" } })
    const tokens = createOtherTokens(read, logger)
    const rows = [row(NFT, "credit", "42", { kind: "unlisted_nft", tx_hash: "0xmine" }), gas("0xmine")]
    const [token] = (await fill(tokens, rows)).otherTokens
    assert.equal(token?.kind, "collectible")
    assert.equal(token?.note, null)
    assert.equal(otherTokenAmount(token as OtherToken), "2 items")
    assert.deepEqual(queries[0], [{ token: NFT, balance: true, details: true, decimals: false }])
  })

  it("doesn't ask an ERC-1155 for one balance, and says it can't tell", async () => {
    const MULTI = "0x00000000000000000000000000000000000000f4"
    const { read, queries } = fakeChain({ [MULTI]: { name: "Items", symbol: "ITM" } })
    const tokens = createOtherTokens(read, logger)
    const [token] = (await fill(tokens, [row(MULTI, "credit", "")])).otherTokens
    assert.deepEqual(queries[0], [{ token: MULTI, balance: false, details: true, decimals: false }])
    assert.equal(token?.state, "read")
    assert.equal(token?.balance, null)
    assert.equal(otherTokenAmount(token as OtherToken), "Unknown")
    assert.match(token?.note ?? "", /may or may not/)
  })

  it("never lists a token on the allowlist", () => {
    const tokens = createOtherTokens(fakeChain({}).read, logger)
    assert.deepEqual(tokens.view(ME, [row(USDC_ADDRESS, "credit", "7")], none).otherTokens, [])
  })

  it("ignores another account's rows", () => {
    const tokens = createOtherTokens(fakeChain({}).read, logger)
    assert.deepEqual(tokens.view(ME, [row(JACK, "credit", "7", { account: "0x00000000000000000000000000000000000000bb" })], none).otherTokens, [])
  })
})

describe("other tokens at an earlier block, as All Yours lines wallets up", () => {
  const moved = [row(JACK, "credit", "5", { block_num: 100, tx_hash: "0xmine" }), gas("0xmine")]
  const tokensReadAt = async (block: number) => {
    const tokens = createOtherTokens(fakeChain({ [JACK]: good("JACK", "5") }).read, logger)
    tokens.update(ME, moved, none, block)
    await tokens.idle()
    return tokens
  }

  it("keeps a balance read after that block when nothing moved in between", async () => {
    const tokens = await tokensReadAt(200)
    assert.deepEqual(tokens.viewAt(ME, moved, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["read", "5"]])
  })

  it("keeps a balance read before a later move", async () => {
    const tokens = await tokensReadAt(120)
    const rows = [...moved, row(JACK, "debit", "5", { block_num: 170 })]
    assert.deepEqual(tokens.viewAt(ME, rows, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["read", "5"]])
  })

  it("has no amount for it when a move falls between that block and the read", async () => {
    const tokens = await tokensReadAt(200)
    const rows = [...moved, row(JACK, "debit", "5", { block_num: 170 })]
    assert.deepEqual(tokens.viewAt(ME, rows, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["reading", null]])
  })

  it("doesn't take a read of nothing after a move to mean there was nothing before it", async () => {
    const tokens = createOtherTokens(fakeChain({ [JACK]: good("JACK", "0") }).read, logger)
    const rows = [...moved, row(JACK, "debit", "5", { block_num: 170 })]
    tokens.update(ME, rows, none, 200)
    await tokens.idle()
    assert.deepEqual(tokens.view(ME, rows, none).otherTokens, [])
    assert.deepEqual(tokens.viewAt(ME, rows, none, 150).otherTokens.map((t) => [t.state, t.balance]), [["reading", null]])
  })

  it("leaves out what only arrived after that block", async () => {
    const tokens = await tokensReadAt(200)
    assert.deepEqual(tokens.viewAt(ME, moved, none, 90).otherTokens, [])
  })

  it("leaves the sum unknown across wallets when one has no amount at that block", async () => {
    const tokens = await tokensReadAt(200)
    const behind = { otherTokens: [{ token: JACK, kind: "token" as const, name: "JACK Token", symbol: "JACK", decimals: 18, balance: "7", state: "read" as const, note: null, tucked: null }], otherTokensLeftOut: 0 }
    const rows = [...moved, row(JACK, "debit", "5", { block_num: 170 })]
    const [token] = combineOtherTokens([behind, tokens.viewAt(ME, rows, none, 150)]).otherTokens
    assert.deepEqual([token?.state, token?.balance], ["reading", null])
  })
})

describe("several wallets' other tokens", () => {
  const base: OtherToken = { token: JACK, kind: "token", name: "Jackfruit", symbol: "JACK", decimals: 18, balance: "5", state: "read", note: null, tucked: null }

  it("adds up what they hold", () => {
    const { otherTokens } = combineOtherTokens([{ otherTokens: [base], otherTokensLeftOut: 0 }, { otherTokens: [{ ...base, balance: "7" }], otherTokensLeftOut: 2 }])
    assert.equal(otherTokens[0]?.balance, "12")
  })

  it("has no sum while one is still reading or can't be read", () => {
    const sum = (state: OtherToken["state"]) => combineOtherTokens([{ otherTokens: [base], otherTokensLeftOut: 0 }, { otherTokens: [{ ...base, balance: null, state }], otherTokensLeftOut: 0 }]).otherTokens[0]
    assert.deepEqual([sum("reading")?.state, sum("reading")?.balance], ["reading", null])
    assert.deepEqual([sum("unreadable")?.state, sum("unreadable")?.balance], ["unreadable", null])
  })

  it("shows what any of them moved itself", () => {
    const tucked = { ...base, tucked: "It arrived without any transaction of yours." }
    assert.equal(combineOtherTokens([{ otherTokens: [tucked], otherTokensLeftOut: 0 }, { otherTokens: [base], otherTokensLeftOut: 0 }]).otherTokens[0]?.tucked, null)
    assert.equal(combineOtherTokens([{ otherTokens: [tucked], otherTokensLeftOut: 0 }, { otherTokens: [tucked], otherTokensLeftOut: 0 }]).otherTokens[0]?.tucked, tucked.tucked)
  })
})

describe("the words the Swift package repeats", () => {
  const token = (changes: Partial<OtherToken>): OtherToken => ({ token: JACK, kind: "token", name: null, symbol: null, decimals: 18, balance: "1500000000000000000", state: "read", note: null, tucked: null, ...changes })

  it("never say a token with no answer holds nothing", () => {
    assert.equal(otherTokenAmount(token({ state: "reading", balance: null })), "Reading…")
    assert.equal(otherTokenAmount(token({ state: "unreadable", balance: null })), "Unknown")
  })

  it("match the vectors it tests against", () => {
    const tokens = [
      token({ name: "Jackfruit", symbol: "JACK" }),
      token({ symbol: "JACK" }),
      token({}),
      token({ state: "reading", balance: null }),
      token({ state: "unreadable", balance: null }),
      token({ decimals: null, balance: "1234567" }),
      token({ decimals: 6, balance: "2500000" }),
      token({ decimals: 0, balance: (2n ** 256n - 1n).toString() }),
      token({ decimals: 36, balance: "1" }),
      token({ kind: "collectible", decimals: 0, balance: "1" }),
      token({ kind: "collectible", decimals: 0, balance: "12" }),
      token({ kind: "collectible", decimals: 0, balance: null }),
    ]
    const vectors = {
      title: OTHER_TOKENS_TITLE,
      note: OTHER_TOKENS_NOTE,
      spamTitle: POSSIBLE_SPAM_TITLE,
      spamRule: POSSIBLE_SPAM_RULE,
      tokens: tokens.map((one) => ({ token: one, name: otherTokenName(one), amount: otherTokenAmount(one) })),
      leftOut: [0, 1, 40].map((count) => ({ count, sentence: otherTokensLeftOutSentence(count) })),
      noMarket: ([[[], 0], [["DEGEN"], 0], [[], 1], [[], 3], [["DEGEN"], 1], [["DEGEN", "AERO"], 4]] as const).map(([listed, others]) => ({ listed, others, sentence: noMarketSentence(listed, others) })),
    }
    assertMatchesFixture("other-token-vectors.json", vectors)
  })
})

function word(value: number | bigint) {
  return BigInt(value).toString(16).padStart(64, "0")
}
