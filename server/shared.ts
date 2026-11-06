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

/** One at a time per wallet, so a read that starts while another is running can use what that one found. A failure only reaches whoever asked for that read. */
export function walletTurns() {
  const turns = new Map<string, Promise<unknown>>()
  return <T>(address: string, read: () => Promise<T>): Promise<T> => {
    const turn = (turns.get(address) ?? Promise.resolve()).then(read)
    turns.set(address, turn.catch(() => {}))
    return turn
  }
}
