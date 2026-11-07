import { defineConfig, loadEnv } from "vite"
import { createApi } from "./server/app.ts"
import { localRefusal, refuse } from "./server/hosting.ts"
import { pathOf } from "./server/shared.ts"

export default defineConfig(({ mode }) => ({
  server: { host: "127.0.0.1", port: 5173 },
  // What the Mac app carries, for when it reads a hosted server: `macos/device-pages.sh`.
  ...(mode === "device-pages" ? { build: { outDir: "macos/build/device-pages", emptyOutDir: true, rollupOptions: { input: "device.html" } } } : {}),
  // Keystone's packages expect Node's. The trailing slashes are what pick the packages over the built-ins.
  resolve: { alias: { buffer: "buffer/", events: "events/", stream: "readable-stream" } },
  plugins: [
    {
      name: "pricetag-api",
      configureServer(server) {
        // Runs the API inside Vite in dev. Env vars reach this Node process only; Vite exposes just VITE_* to the browser.
        const handle = createApi({ ...process.env, ...loadEnv(mode, process.cwd(), "") })
        server.middlewares.use((req, res, next) => {
          // Vite has already turned away a foreign `Host` by now. This also turns away other sites' pages, and other machines, calling the API.
          const path = pathOf(req)
          const refusal = path?.startsWith("/api/") ? localRefusal(req, path) : null
          if (refusal) {
            refuse(res, 403, refusal)
            return
          }
          handle(req, res)
            .then((handled) => {
              if (!handled) next()
            })
            .catch(next)
        })
      },
    },
  ],
}))
