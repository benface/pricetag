// Restarts a staging dataset's job when it goes FATAL, which `retry_strategy: unless_stopped` doesn't do (WORK-574). Bounded reads
// keep answering when that happens, with blocks that stop moving, so nothing else notices.
//
//   node scripts/job-watch.ts [path to .env.local]
//
// For the demo it runs from launchd as com.benface.pricetag-job-watch, from a copy in ~/.local/share/pricetag-job-watch. It logs to
// ~/Library/Logs/pricetag-job-watch.log. To stop it: launchctl bootout gui/$(id -u)/com.benface.pricetag-job-watch
//
// Every 30 s it checks the versions .env.local names, read again each time, so it follows a replacement. Checking uses the read
// token, so it outlives the admin token. Restarting reads the admin token from ~/.config/pricetag/staging.jwt when it's needed, so
// dropping in a new one needs no restart here, and it's never an argument or logged. Only builtins, so it can run from a copy.

import { execFile } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"

const CONTROLLER = "https://gateway.amp.staging.edgeandnode.com/controller"
const DATASET_KEYS = ["PRICETAG_DATASET", "PRICETAG_FORK_DATASET", "PRICETAG_RATES_DATASET", "PRICETAG_FEEDS_DATASET"]
const CHECK_EVERY_MS = 30_000
const TIMEOUT_MS = 20_000
// An accepted restart that's still FATAL this much later gets another one. It may have died again between two checks.
const RESTART_AGAIN_AFTER_MS = 5 * 60_000
const HEARTBEAT_EVERY_MS = 60 * 60_000

export type Env = Record<string, string | undefined>

export type Watcher = {
  controller: string
  fetch: typeof fetch
  readEnv: () => Env
  /** Throws if there's no token to read. */
  readAdminToken: () => string
  now: () => number
  log: (line: string) => void
  /** For what someone should see right away. It's also logged. */
  alert: (line: string) => void
}

type Seen = { status?: string; problem?: string; restartProblem?: string; restartedAt?: number }

/** Only `benface/*`, because that's all we may write to on staging. */
export function datasetsIn(env: Env): string[] {
  const named = DATASET_KEYS.map((key) => env[key]?.trim()).filter((ref): ref is string => !!ref)
  return [...new Set(named)].filter((ref) => /^benface\/[\w-]+@[\w.-]+$/.test(ref))
}

/** When a JWT expires, in milliseconds, without checking its signature. Undefined if it doesn't say. */
export function expiryOf(token: string): number | undefined {
  try {
    const { exp } = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString())
    return typeof exp === "number" ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

const versionPath = (ref: string) => {
  const [name, version] = ref.split("@")
  return `/materialized-datasets/${name}/versions/${version}`
}

export function createJobWatch(watcher: Watcher) {
  const { controller, fetch, readEnv, readAdminToken, now, log, alert } = watcher
  const seen = new Map<string, Seen>()
  let env: Env = {}
  let lastEnvProblem: string | undefined
  let lastTokenProblem: string | undefined
  let refusedToken: string | undefined
  let lastDatasets = ""

  const seenFor = (ref: string) => {
    let entry = seen.get(ref)
    if (!entry) seen.set(ref, (entry = {}))
    return entry
  }

  const problem = (entry: Seen, ref: string, line: string) => {
    if (entry.problem !== line) log(`${ref}: ${line}`)
    entry.problem = line
  }

  /** The admin token, or undefined with one plain alert when there isn't a usable one. A new token clears it. */
  function usableToken(): string | undefined {
    let token: string
    try {
      token = readAdminToken().trim()
    } catch {
      tokenProblem("The admin token can't be read, so a job that dies can't be restarted. Checking continues.")
      return undefined
    }
    // It goes in a header, where anything else would fail the request instead of being refused.
    if (!/^[\x21-\x7e]+$/.test(token)) {
      tokenProblem("The admin token is empty or malformed, so a job that dies can't be restarted. Checking continues. Put a new token in staging.jwt.")
      return undefined
    }
    const expiry = expiryOf(token)
    if (expiry !== undefined && expiry <= now()) {
      tokenProblem(`The admin token expired at ${new Date(expiry).toISOString()}, so a job that dies can't be restarted. Checking continues. Put a new token in staging.jwt.`)
      return undefined
    }
    // Only a restart can show that a refused token is fine now, but a different one gets its own chance.
    if (token !== refusedToken) clearTokenProblem()
    return token
  }

  function tokenProblem(line: string) {
    if (lastTokenProblem !== line) alert(line)
    lastTokenProblem = line
  }

  function clearTokenProblem() {
    if (lastTokenProblem) log("There's a usable admin token again.")
    lastTokenProblem = undefined
    refusedToken = undefined
  }

  /** Alerts once per death, so a job that can't be restarted can't go unnoticed, or repeat every 30 s. */
  function cantRestart(ref: string, entry: Seen, why: string) {
    const line = `${ref} is FATAL and can't be restarted: ${why} It tries again every 30 s.`
    if (!entry.restartProblem) alert(line)
    else if (entry.restartProblem !== line) log(line)
    entry.restartProblem = line
  }

  async function restart(ref: string, entry: Seen) {
    const token = usableToken()
    if (!token) return cantRestart(ref, entry, "there's no usable admin token.")
    let response: Response
    try {
      response = await fetch(`${controller}${versionPath(ref)}`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      // Only the error's name, because a message can quote a request.
      return cantRestart(ref, entry, `the request failed (${error instanceof Error ? error.name : "unknown error"}).`)
    }
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) {
      refusedToken = token
      // Without a dataset or status, because this is one problem however many jobs run into it.
      tokenProblem("The admin token was refused, so a job that dies can't be restarted. Checking continues. Put a new token in staging.jwt.")
      return cantRestart(ref, entry, `the admin token was refused (${response.status}).`)
    }
    if (!response.ok) return cantRestart(ref, entry, `the controller returned ${response.status}.`)
    clearTokenProblem()
    entry.restartProblem = undefined
    entry.restartedAt = now()
    alert(`${ref} went FATAL, so its job was restarted.`)
  }

  async function check(ref: string) {
    const entry = seenFor(ref)
    try {
      const response = await fetch(`${controller}${versionPath(ref)}?view=basic`, {
        headers: { authorization: `Bearer ${env.AMP_QUERY_TOKEN ?? ""}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
      if (!response.ok) {
        await response.body?.cancel()
        problem(entry, ref, `checking it returned ${response.status}, so it can't be restarted until that clears`)
        return
      }
      const body = (await response.json()) as { status?: string; materialization?: { status?: string } }
      const status = body.materialization?.status === "FATAL" || body.status === "FATAL" ? "FATAL" : (body.materialization?.status ?? body.status ?? "UNKNOWN")
      if (entry.problem) log(`${ref}: requests work again`)
      entry.problem = undefined
      if (status !== entry.status) log(`${ref}: ${entry.status ?? "first check"} -> ${status}`)
      entry.status = status

      if (status !== "FATAL") {
        entry.restartProblem = undefined
        if (entry.restartedAt !== undefined && status === "RUNNING") {
          log(`${ref}: running again ${Math.round((now() - entry.restartedAt) / 1000)} s after the restart`)
          entry.restartedAt = undefined
        }
        return
      }
      if (entry.restartedAt === undefined) return await restart(ref, entry)
      if (now() - entry.restartedAt >= RESTART_AGAIN_AFTER_MS) {
        alert(`${ref} is still FATAL ${Math.round((now() - entry.restartedAt) / 60_000)} min after its restart, so it's being restarted again. It may need a person.`)
        entry.restartedAt = undefined
        await restart(ref, entry)
      }
    } catch (error) {
      // Only the error's name, because a message can quote a request.
      problem(entry, ref, `a request failed (${error instanceof Error ? error.name : "unknown error"}), so it can't be restarted until that clears`)
    }
  }

  return {
    async tick() {
      try {
        env = readEnv()
        if (lastEnvProblem) log("The env file can be read again.")
        lastEnvProblem = undefined
      } catch (error) {
        // Keeps watching what it last read.
        const line = `The env file can't be read (${error instanceof Error ? error.name : "unknown error"}), so this uses what it last read.`
        if (lastEnvProblem !== line) alert(line)
        lastEnvProblem = line
      }
      const datasets = datasetsIn(env)
      const list = datasets.join(", ")
      if (list !== lastDatasets) log(`Watching ${list || "nothing"}`)
      lastDatasets = list
      // Says so before anything dies, so an expired token isn't first found out during an outage.
      if (datasets.length > 0) usableToken()
      await Promise.all(datasets.map(check))
    },
    statuses: () => datasetsIn(env).map((ref) => `${ref} ${seen.get(ref)?.status ?? "not checked"}`),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const envPath = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "../.env.local")
  const logPath = join(homedir(), "Library/Logs/pricetag-job-watch.log")
  mkdirSync(dirname(logPath), { recursive: true })

  const log = (line: string) => appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`)
  const watch = createJobWatch({
    controller: CONTROLLER,
    fetch,
    readEnv: () => parseEnv(readFileSync(envPath, "utf8")),
    readAdminToken: () => readFileSync(join(homedir(), ".config/pricetag/staging.jwt"), "utf8"),
    now: Date.now,
    log,
    alert(line) {
      log(`ALERT ${line}`)
      execFile("osascript", ["-e", "on run argv\ndisplay notification (item 1 of argv) with title \"Pricetag job watch\"\nend run", line], (error) => {
        if (error) log("The notification above couldn't be shown.")
      })
    },
  })

  log(`Started, reading ${envPath}`)
  let lastHeartbeat = Date.now()
  for (;;) {
    await watch.tick()
    if (Date.now() - lastHeartbeat >= HEARTBEAT_EVERY_MS) {
      log(`Still watching: ${watch.statuses().join(", ")}`)
      lastHeartbeat = Date.now()
    }
    await new Promise((resolve) => setTimeout(resolve, CHECK_EVERY_MS))
  }
}
