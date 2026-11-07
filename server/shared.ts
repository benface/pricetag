// What the server's own files have in common.

import type { IncomingMessage } from "node:http"
import { describeError } from "@pricetag/sdk/internal"

export type Env = Record<string, string | undefined>

/** The request's decoded path, or null when the URL is malformed. Clients can send anything here. */
export function pathOf(req: IncomingMessage): string | null {
  try {
    return decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname)
  } catch {
    return null
  }
}

/** A dataset that doesn't have this table, which says so in one of these ways. */
export const isMissingTable = (error: unknown) => /table .*not found|not found.*table|does not exist|unknown table/i.test(describeError(error))

/** One at a time per wallet, so a read that starts while another is running can use what that one found. A failure only reaches whoever asked for that read. The queue keeps neither results nor failures, since a wallet's cache may have let go of its rows. */
export function walletTurns() {
  const turns = new Map<string, Promise<void>>()
  const inTurn = <T>(address: string, read: () => Promise<T>): Promise<T> => {
    const turn = (turns.get(address) ?? Promise.resolve()).then(read)
    const tail: Promise<void> = turn.then(
      () => forget(),
      () => forget(),
    )
    // A wallet nobody's reading leaves nothing behind, or a long-running server keeps one entry for every wallet it ever read.
    const forget = () => {
      if (turns.get(address) === tail) turns.delete(address)
    }
    turns.set(address, tail)
    return turn
  }
  return Object.assign(inTurn, {
    /** How many wallets have a read running or waiting. */
    get waiting() {
      return turns.size
    },
  })
}
