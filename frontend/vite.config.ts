import { readFileSync } from "node:fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { esmFetch } from "./tools/esm_fetch.ts"

const imports: Record<string, string> =
    JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8")).imports
// dimos-react: its TypeScript source at its tag on GitHub (deno.json's URLs, the same files deno reads), fetched and
// compiled into the page; its react, react-dom and three resolve to this page's own
const dimosReact = Object.fromEntries(Object.entries(imports).filter(([name]) => name.startsWith("dimos-react")))

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md)
export default defineConfig({
    base: "./",
    // dimos-react's source is fetched at build (tools/esm_fetch.ts)
    plugins: [esmFetch(dimosReact), react()],
    build: { chunkSizeWarningLimit: 1500 }, // three.js
    server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
})
