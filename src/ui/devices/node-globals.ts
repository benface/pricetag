// Keystone's packages were written for Node and expect a little of it to be there. This has to be imported before they are. It's only
// what they read when they load, and only on this page once someone picks Keystone.

import { Buffer } from "buffer"

const page = globalThis as unknown as { process?: unknown; Buffer?: unknown; global?: unknown }
page.global ??= globalThis
page.Buffer ??= Buffer
page.process ??= { env: {}, browser: true, version: "", nextTick: (run: (...args: unknown[]) => void, ...args: unknown[]) => queueMicrotask(() => run(...args)) }
