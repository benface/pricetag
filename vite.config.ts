import { defineConfig, loadEnv } from "vite"
import { createApi } from "./server/app.ts"

export default defineConfig(({ command, mode }) => ({
  server: { host: "127.0.0.1", port: 5173 },
  plugins: [
    {
      name: "pricetag-api",
      configureServer(server) {
        if (command !== "serve") return
        // Runs the API inside Vite in dev. Env vars reach this Node process only; Vite exposes just VITE_* to the browser.
        const handle = createApi({ ...process.env, ...loadEnv(mode, process.cwd(), "") })
        server.middlewares.use((req, res, next) => {
          void handle(req, res).then((handled) => {
            if (!handled) next()
          })
        })
      },
    },
  ],
}))
