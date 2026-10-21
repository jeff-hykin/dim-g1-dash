import { readFileSync } from "node:fs"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { esmFetch } from "./tools/esm_fetch.ts"

const imports: Record<string, string> =
    JSON.parse(readFileSync(new URL("./deno.json", import.meta.url), "utf8")).imports
// deno (tests, deno check) reads dimos-react's TypeScript source at its tag; the page bundles esm.sh's build of that
// same tag, with react, react-dom and three left to this page's own
const dimosReact = Object.fromEntries(
    Object.entries(imports)
        .filter(([name]) => name.startsWith("dimos-react"))
        .map(([name, url]) => [
            name,
            url.replace(
                /^https:\/\/raw\.githubusercontent\.com\/jeff-hykin\/dimos-react\/([^/]+)\//,
                "https://esm.sh/gh/jeff-hykin/dimos-react@$1/",
            ) +
            "?external=react,react-dom,three",
        ]),
)

// base "./": every URL relative, so the app works under Desktop's /apps/<name>/ (docs/apps.md)
export default defineConfig({
    base: "./",
    // dimos-react comes from esm.sh (deno.json's URLs), fetched and bundled at build (tools/esm_fetch.ts)
    plugins: [esmFetch(dimosReact), react()],
    build: { chunkSizeWarningLimit: 1500 }, // three.js
    server: { proxy: { "/api": { target: "http://127.0.0.1:8787", ws: true } } },
})
