// `pnpm check:tax-answer`: a tax report's buttons open the questions of the wallet they name, and Done comes back to the report.
// Drives the real build and the real API in a headless Chromium, with wallets made up here, so nothing opens on screen and no data
// source is needed. Set `CHROMIUM=…`, or it uses Playwright's.
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { ASSETS, ETH_ADDRESS, shortHash, type LegRow } from "@pricetag/sdk/core"
import type { Source } from "@pricetag/sdk/internal"
import { build } from "vite"
import { createApi } from "../server/app.ts"
import { createHandler } from "../server/http.ts"
import { answerSender, emptyBook, linkDeviceAccounts, type Book } from "../src/core/book.ts"

const FIRST = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SECOND = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const ADDED = "0xcccccccccccccccccccccccccccccccccccccccc"
const FROM_FIRST = "0xdddddddddddddddddddddddddddddddddddddddd"
const FROM_SECOND = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
const FROM_ADDED = "0xffffffffffffffffffffffffffffffffffffffff"
const SHOP = "0x1111111111111111111111111111111111111111"
const ONE = 10n ** 18n

/** Each gets a different amount from its own sender, so the card says whose question it is, and answering one leaves the others. */
const moved = (block: number, side: LegRow["side"], account: string, amount: bigint, tx: string, counterparty: string): LegRow => ({ block_num: block, timestamp: "2026-11-04T00:00:00.000Z", tx_hash: tx, tx_index: 0, log_index: 0, token: ETH_ADDRESS, account, side, amount: amount.toString(), counterparty, kind: "eth" })
/** Gets some, then sends a little of it on, which is what puts an unknown gain in the report. */
const history = (account: string, amount: bigint, from: string, n: number) => [moved(10, "credit", account, amount, `0x${n}1`, from), moved(11, "debit", account, ONE / 10n, `0x${n}2`, SHOP)]
const rows: Record<string, LegRow[]> = { [FIRST]: history(FIRST, ONE, FROM_FIRST, 1), [SECOND]: history(SECOND, 2n * ONE, FROM_SECOND, 2), [ADDED]: history(ADDED, 3n * ONE, FROM_ADDED, 3) }

const source: Source = {
  mode: "raw",
  startBlock: 1,
  historyFrom: null,
  head: async () => ({ blockNum: 20, timestamp: "2026-11-04T00:00:00.000Z" }),
  processedThrough: async (_, head) => head,
  readWindow: async (address) => ({ rows: rows[address] ?? [], priced: null, gasUnknown: [] }),
  readReferences: async (blocks) => blocks.map((block_num) => ({ blockNum: block_num, ethUsd: "300000000000", usdcUsd: "100000000" })),
  readLatestReference: async () => ({ blockNum: 20, ethUsd: "400000000000", usdcUsd: "100000000" }),
  readEthBalances: async () => new Map(),
  readBalances: async (address, block) => {
    const amounts: Record<string, string> = Object.fromEntries(ASSETS.map((asset) => [asset, "0"]))
    for (const row of (rows[address] ?? []).filter((one) => one.block_num <= block)) amounts.ETH = (BigInt(amounts.ETH as string) + (row.side === "credit" ? BigInt(row.amount) : -BigInt(row.amount))).toString()
    return { blockNum: block, amounts }
  },
}

const work = mkdtempSync(join(tmpdir(), "patina-tax-answer."))
let chromium: ChildProcess | undefined
// However this ends, including a failed check or an interrupt, it leaves nothing behind.
process.on("exit", () => {
  chromium?.kill("SIGKILL")
  // Chromium's helpers can still be writing to its profile for a moment.
  rmSync(work, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => process.exit(1))
const dist = join(work, "dist")
await build({ logLevel: "warn", build: { outDir: dist, emptyOutDir: true } })
const api = createApi({}, { source, readRates: async () => ({ byBlock: {}, latest: null }), proofs: { datasets: async () => [], priceBehind: async () => null, readBlock: async () => null } }, null)
const server = createServer(createHandler(api, dist))
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

function findChromium(): string {
  if (process.env.CHROMIUM) return process.env.CHROMIUM
  const root = join(homedir(), "Library/Caches/ms-playwright")
  const newest = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name)).sort().at(-1)
  if (!newest) throw new Error("No Chromium. Set CHROMIUM to one.")
  const platform = readdirSync(join(root, newest)).find((name) => name.startsWith("chrome-")) as string
  const app = readdirSync(join(root, newest, platform)).find((name) => name.endsWith(".app")) as string
  const binaries = join(root, newest, platform, app, "Contents/MacOS")
  return join(binaries, readdirSync(binaries)[0] as string)
}
chromium = spawn(findChromium(), ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${join(work, "profile")}`, "about:blank"], { stdio: "ignore" })

async function devtoolsPort(): Promise<string> {
  for (let tries = 0; tries < 100; tries++) {
    try {
      const port = readFileSync(join(work, "profile/DevToolsActivePort"), "utf8").split("\n")[0]
      if (port) return port
    } catch {}
    await sleep(100)
  }
  throw new Error("Chromium didn't start")
}

// Just enough of the DevTools protocol, as in `extension-e2e.ts`.
const target = (await (await fetch(`http://127.0.0.1:${await devtoolsPort()}/json/new`, { method: "PUT" })).json()) as { webSocketDebuggerUrl: string }
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve)
  socket.addEventListener("error", reject)
})
const waiting = new Map<number, (message: any) => void>()
const pageErrors: string[] = []
socket.addEventListener("message", (event) => {
  const message = JSON.parse(String(event.data))
  if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text)
  waiting.get(message.id)?.(message)
  waiting.delete(message.id)
})
let nextId = 1
const send = (method: string, params: object = {}) =>
  new Promise<any>((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
const evaluate = async (expression: string): Promise<any> => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

let failures = 0
const check = (name: string, passed: boolean, detail?: unknown) => {
  console.log(`${passed ? "ok  " : "FAIL"} ${name}${passed || detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`)
  if (!passed) failures++
}

const TAX = `document.querySelector('dialog[aria-label="Tax report"]')`
const QUESTIONS = `document.querySelector("dialog.resolve")`

/** Nothing here should take long, so what never shows up fails rather than hangs. */
async function until(expression: string, what: string): Promise<boolean> {
  for (let tries = 0; tries < 100; tries++) {
    if (await evaluate(`!!(${expression})`)) return true
    await sleep(100)
  }
  throw new Error(`${what} didn't happen. The page says: ${await evaluate(`document.body.innerText.slice(-600)`)}`)
}
const text = (of: string): Promise<string> => evaluate(`${of}?.innerText ?? ""`)
const buttonsIn = (of: string): Promise<string[]> => evaluate(`[...(${of}?.querySelectorAll("button.resolve-button") ?? [])].map((b) => b.innerText)`)
const click = (of: string, label: string) => evaluate(`[...${of}.querySelectorAll("button")].find((b) => b.innerText.trim().startsWith(${JSON.stringify(label)})).click()`)
const unknownShown = `${TAX}?.querySelector(".tax-unknown")`

/** Opens a page from nothing, then its tax report on all years, so coming back can show the year stayed. */
async function openReport(address: string, book: Book, others: string[] = []) {
  await send("Page.navigate", { url: `${origin}/` })
  await until(`document.readyState === "complete"`, "the page loads")
  await evaluate(`localStorage.clear(); localStorage.setItem("patina.book", ${JSON.stringify(JSON.stringify(book))}); localStorage.setItem("pricetag.taxOtherWallets", ${JSON.stringify(others.join("\n"))})`)
  await send("Page.navigate", { url: `${origin}/?address=${address}` })
  await until(`[...document.querySelectorAll("button")].some((b) => b.innerText.includes("Export a tax report"))`, "the wallet shows")
  await click("document", "Export a tax report…")
  await until(unknownShown, "the report says what's unknown")
  await evaluate(`(() => { const select = ${TAX}.querySelector("select"); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "all"); select.dispatchEvent(new Event("change", { bubbles: true })) })()`)
  await until(`${TAX}.querySelector("select").value === "all" && ${unknownShown}`, "the report goes to all years")
}

/** Done, then the report is back on the wallets and the year it was on. */
async function checkCameBack(address: string) {
  await click(QUESTIONS, "Done")
  check(`Done goes back to the report`, await until(`${TAX} !== null`, "the report comes back"))
  check(`  on the same page`, (await evaluate(`location.search`)) === `?address=${address}`, await evaluate(`location.search`))
  check(`  on the same year`, await until(`${TAX}?.querySelector("select").value === "all"`, "the year stays"))
}

await send("Runtime.enable")
await send("Page.enable")

const both = linkDeviceAccounts(emptyBook(), [FIRST, SECOND])

// All Yours has nothing to ask, and the report has a wallet added to it alone, which is the one with a question.
await openReport("all", answerSender(answerSender(both, FIRST, FROM_FIRST, { kind: "someone-else" }), SECOND, FROM_SECOND, { kind: "someone-else" }), [ADDED])
check("a wallet added to the report gets a button, and ones with nothing to ask don't", JSON.stringify(await buttonsIn(TAX)) === JSON.stringify([`Answer for ${shortHash(ADDED)}`]), await buttonsIn(TAX))
await click(TAX, `Answer for ${shortHash(ADDED)}`)
await until(QUESTIONS, "its questions open")
check("its question opens, not All answered", (await text(QUESTIONS)).includes("3 ETH"), await text(QUESTIONS))
await checkCameBack("all")
check("it's still asking while it's unanswered", await until(`${TAX}?.querySelector("button.resolve-button")`, "the button is still there"))

// All Yours has questions in both wallets, and each button opens only the one it names.
await openReport("all", both)
check("each wallet in All Yours gets a button by name", JSON.stringify((await buttonsIn(TAX)).sort()) === JSON.stringify([`Answer for ${shortHash(FIRST)}`, `Answer for ${shortHash(SECOND)}`]), await buttonsIn(TAX))
await click(TAX, `Answer for ${shortHash(FIRST)}`)
await until(`${QUESTIONS}?.innerText.includes("2 left")`, "its questions open, with the linked wallet's read too")
const named = await text(QUESTIONS)
check("a named wallet's own question comes first, though the other's is worth more", named.includes("1 ETH") && !named.includes("2 ETH"), named)
await click(QUESTIONS, "Someone else")
await until(`${QUESTIONS}.innerText.includes("2 ETH")`, "the linked wallet's question comes next")
await click(QUESTIONS, "Skip")
await checkCameBack("all")
await until(`${TAX}?.querySelectorAll("button.resolve-button").length === 1`, "the answered wallet's button goes")
check("only the wallet still asking has a button", JSON.stringify(await buttonsIn(TAX)) === JSON.stringify([`Answer for ${shortHash(SECOND)}`]), await buttonsIn(TAX))

// One wallet on its own, which is the same way back.
await openReport(ADDED, emptyBook())
check("the wallet showing says how many it has", JSON.stringify(await buttonsIn(TAX)) === JSON.stringify(["Resolve 1"]), await buttonsIn(TAX))
await click(TAX, "Resolve 1")
await until(QUESTIONS, "its questions open")
check("its question opens", (await text(QUESTIONS)).includes("3 ETH"), await text(QUESTIONS))
await click(QUESTIONS, "Someone else")
await until(`!${QUESTIONS}.querySelector(".who-card")`, "the question's answered")
await checkCameBack(ADDED)
check("with nothing left to ask, there's no button", await until(`${TAX}?.innerText.includes("Download CSV") && !${TAX}.querySelector("button.resolve-button")`, "the button goes"))

check("no page errors", pageErrors.length === 0, pageErrors)

process.exit(failures > 0 ? 1 : 0)
