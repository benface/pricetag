// `pnpm invite <name>`: a new invite for the hosted server. It prints the invite once, for that person alone, and the line that
// goes in PRICETAG_INVITES, which holds only its hash. Removing that line takes the invite back. Nothing here is saved.

import { randomBytes } from "node:crypto"
import { hashOf } from "../server/hosting.ts"

const name = process.argv[2] ?? ""
if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(name)) {
  console.error("Usage: pnpm invite <name>, in lowercase letters, digits, - and _.")
  process.exit(1)
}
// From the system's secure random source, like any credential. It isn't a key: it only lets someone use the server, and it can be taken back.
const invite = randomBytes(32).toString("base64url")
console.log(`Send this to ${name}, and only them:\n  ${invite}\n\nAdd this to PRICETAG_INVITES, separated by a comma:\n  ${name}:${hashOf(invite)}`)
