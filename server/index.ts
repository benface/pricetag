// `pnpm start`: serves the built app and the API. Binds to localhost, since this is a personal tool with a staging token.

import { createServer } from "node:http"
import { resolve } from "node:path"
import { createApi } from "./app.ts"
import { createHandler } from "./http.ts"

const port = Number(process.env.PORT || 8787)

createServer(createHandler(createApi(process.env), resolve(import.meta.dirname, "../dist"))).listen(port, "127.0.0.1", () => {
  console.log(`Pricetag is on http://localhost:${port}`)
})
