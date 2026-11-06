// Why a read from the price service failed, sorted the way the Mac app's `FetchError` sorts it. `wording.ts` says what each means to someone reading it.

export type ReadFailure =
  /** Nothing usable came back: no answer at all, or a page from something in front of the server. */
  | { kind: "unreachable" }
  /** The server answered, and it can't read its data right now. */
  | { kind: "unavailable"; said: string }
  /** The server has no data source set up, so it only has the demo wallet. */
  | { kind: "noSource"; said: string }
  /** The server refused this request, and `said` says why. */
  | { kind: "refused"; said: string }
  /** The server is holding this client back for `retryAfter` seconds, which clears by itself. */
  | { kind: "slowedDown"; said: string; retryAfter: number }

export class ReadError extends Error {
  readonly failure: ReadFailure
  constructor(failure: ReadFailure) {
    super(failure.kind === "unreachable" ? failure.kind : failure.said)
    this.failure = failure
  }
}

/** A failed `fetch` throws something that isn't ours, which only happens when nothing answered. */
export const failureOf = (error: unknown): ReadFailure => (error instanceof ReadError ? error.failure : { kind: "unreachable" })

/** In seconds, as this server sends it. Anything else waits a minute, which is as long as its shortest limit lasts. */
function retryAfterOf(response: Response): number {
  const seconds = Number(response.headers.get("retry-after"))
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 60
}

/** A response's JSON body, or a `ReadError` that says why there isn't one. */
export async function readResponse<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null
  const said = body?.error
  if (body !== null && typeof said !== "string" && response.ok) return body as T
  if (typeof said !== "string") throw new ReadError({ kind: "unreachable" })
  if (response.status === 429) throw new ReadError({ kind: "slowedDown", said, retryAfter: retryAfterOf(response) })
  throw new ReadError({ kind: response.status === 502 ? "unavailable" : response.status === 503 ? "noSource" : "refused", said })
}
