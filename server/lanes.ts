// Whose work a request's Amp queries are, so one person's slow read doesn't hold up anyone else's. See `createTurns`.

import { AsyncLocalStorage } from "node:async_hooks"

const lanes = new AsyncLocalStorage<string>()

export const laneOf = () => lanes.getStore()

/** Everything this starts, however long after, is `lane`'s. */
export const inLane = <T>(lane: string, work: () => T): T => lanes.run(lane, work)

/** What the server reads for everyone, like the head, which shouldn't wait because of who happened to ask first. */
export const forEveryone = <T>(work: () => T): T => lanes.exit(work)
