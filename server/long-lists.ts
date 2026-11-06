// A busy wallet's reply is nearly all its chart points and outgoing transactions, and nearly none of those change between
// reads. So a client can say what it already has, and gets only the rest. Nothing is assumed: its copy has to hash the same
// as what was just worked out, or it gets the whole list.

import { createHash } from "node:crypto"

const LISTS = ["points", "outgoingTxs"] as const
type ListName = (typeof LISTS)[number]

/** Shorter than this isn't worth it, so a wallet like the demo's gets the reply it always did. */
const LONG_LIST = 1000
/** How much of the end isn't vouched for. The newest transactions are the ones still getting prices and fees. */
const RECENT = 200

const MARK = /^(\d+):([0-9a-f]{64})$/

function trimmed(list: readonly unknown[], mark: unknown): { rest: readonly unknown[]; kept: number; mark: string | null } {
  if (list.length < LONG_LIST) return { rest: list, kept: 0, mark: null }
  const [, count, digest] = (typeof mark === "string" && mark.match(MARK)) || []
  const markAt = list.length - RECENT
  const hash = createHash("sha256")
  let kept = 0
  let next: string | null = null
  for (let i = 0; i <= list.length; i++) {
    if (i === Number(count) && i > 0 && hash.copy().digest("hex") === digest) kept = i
    if (i === markAt) next = `${i}:${hash.copy().digest("hex")}`
    if (i < list.length) hash.update(`${JSON.stringify(list[i])}\n`)
  }
  return { rest: kept > 0 ? list.slice(kept) : list, kept, mark: next }
}

/**
 * The reply to send a client that said what it has with `since`, as `{ points?: mark, outgoingTxs?: mark }`. Asking with
 * none is how it starts. `marks` is what to send next time, and `kept` says how much of a list was left out because it has it.
 * A client that doesn't ask gets the reply as it is.
 */
export function withoutWhatItHas<Reply extends Record<ListName, readonly unknown[]>>(reply: Reply, since: unknown): Reply | (Reply & { marks: Partial<Record<ListName, string>>; kept?: Partial<Record<ListName, number>> }) {
  if (typeof since !== "object" || since === null) return reply
  const lists = { ...reply }
  const marks: Partial<Record<ListName, string>> = {}
  const kept: Partial<Record<ListName, number>> = {}
  for (const name of LISTS) {
    const list = trimmed(reply[name], (since as Partial<Record<ListName, unknown>>)[name])
    Object.assign(lists, { [name]: list.rest })
    if (list.mark) marks[name] = list.mark
    if (list.kept > 0) kept[name] = list.kept
  }
  if (Object.keys(marks).length === 0) return reply
  return { ...lists, marks, ...(Object.keys(kept).length > 0 ? { kept } : {}) }
}
