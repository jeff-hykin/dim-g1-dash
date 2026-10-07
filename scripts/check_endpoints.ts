// dimos.yaml's `provides:` must list exactly the backend's routes (method + path), so Desktop sees every endpoint even
// before the app runs. `deno task check-endpoints` (CI runs it); `--write` rewrites its description and endpoints.
import { parse, stringify } from "@std/yaml"
import { describe } from "../backend/http.ts"
import { DESCRIPTION, routes } from "../backend/routes.ts"

const file = new URL("../dimos.yaml", import.meta.url)
const yaml = parse(await Deno.readTextFile(file)) as Record<string, unknown>
const want = describe(DESCRIPTION, routes)
if (Deno.args.includes("--write")) {
    yaml.provides = { ...(yaml.provides as Record<string, unknown>), ...want }
    await Deno.writeTextFile(file, stringify(yaml, { lineWidth: 120 }))
    console.log(`wrote ${want.endpoints.length} endpoints into dimos.yaml`)
    Deno.exit(0)
}
const key = (e: { method: string; path: string }) => `${e.method} ${e.path}`
const have = new Set(((yaml.provides as { endpoints?: { method: string; path: string }[] })?.endpoints ?? []).map(key))
const need = new Set(want.endpoints.map(key))
const missing = [...need].filter((k) => !have.has(k))
const extra = [...have].filter((k) => !need.has(k))
if (missing.length || extra.length) {
    console.error(
        `dimos.yaml's provides endpoints differ from backend/routes.ts:\n  missing: ${
            missing.join(", ") || "-"
        }\n  extra: ${extra.join(", ") || "-"}\nrun: deno task check-endpoints --write`,
    )
    Deno.exit(1)
}
console.log(`dimos.yaml lists all ${need.size} endpoints`)
