// dimos.yaml's `provides:` (an OpenAPI 3.1 document) must list exactly the backend's routes (method + path), so Desktop
// sees every endpoint even before the app runs; and its `uses:` must declare every Desktop endpoint the pages call (a
// path under /gateways/dimos/, /gateways/desktop/, /gateways/agent/ or /apps/@launcher/, absolute or ../-relative; the
// app's own api/ is relative). Desktop's old paths (/api/, /dimos-gateway/, ...) fail. `deno task check-endpoints` (CI
// runs it); `--write` rewrites its info and paths.
import { parse, stringify } from "@std/yaml"
import { openapi } from "../backend/http.ts"
import { INFO, routes } from "../backend/routes.ts"

/** An OpenAPI document's operations, as `GET api/thing`. */
function operations(doc: { paths?: object } | undefined): string[] {
    return Object.entries(doc?.paths ?? {}).flatMap(([path, item]) =>
        Object.keys(item).filter((method) => ["get", "post", "put", "patch", "delete"].includes(method))
            .map((method) => `${method.toUpperCase()} ${path.replace(/^\//, "")}`)
    )
}

const file = new URL("../dimos.yaml", import.meta.url)
const yaml = parse(await Deno.readTextFile(file)) as Record<string, unknown>
const want = openapi(INFO, routes)
if (Deno.args.includes("--write")) {
    const provides = (yaml.provides ?? {}) as { info?: object }
    yaml.provides = { ...provides, ...want, info: { ...provides.info, ...want.info } }
    await Deno.writeTextFile(file, stringify(yaml, { lineWidth: 120 }))
    console.log(`wrote ${operations(want).length} endpoints into dimos.yaml`)
    Deno.exit(0)
}
const have = new Set(operations(yaml.provides as { paths?: object }))
const need = new Set(operations(want))
const missing = [...need].filter((k) => !have.has(k))
const extra = [...have].filter((k) => !need.has(k))
if (missing.length || extra.length) {
    console.error(
        `dimos.yaml's provides: paths differ from backend/routes.ts:\n  missing: ${
            missing.join(", ") || "-"
        }\n  extra: ${extra.join(", ") || "-"}\nrun: deno task check-endpoints --write`,
    )
    Deno.exit(1)
}
console.log(`dimos.yaml lists all ${need.size} endpoints`)

// ── uses: every Desktop endpoint the pages call is declared ──
/** `{id}`, `${encodeURIComponent(id)}` → `{}`; no query */
const shape = (path: string) => path.split("?")[0].replace(/\$\{[^}]*\}|\{[^}]*\}/g, "{}").replace(/\/+$/, "")
const uses = (yaml.uses ?? {}) as Record<string, string[] | string>
const declared = (gateway: string) =>
    new Set(
        (Array.isArray(uses[gateway]) ? uses[gateway] as string[] : []).map((route) =>
            shape(route.split(" ")[1].replace(/^(?!\/)/, "/"))
        ),
    )
/** a page's path prefix → the `uses:` entry it belongs to (spec v1.4: its paths are relative to that prefix) */
const prefixes: [RegExp, string][] = [
    [/^\/gateways\/dimos\//, "@dimos-gateway"],
    [/^\/gateways\/desktop\//, "@desktop-gateway"],
    [/^\/gateways\/agent\//, "@agentic-gateway"],
    [/^\/apps\/@launcher\//, "@launcher"],
]
const gateways: Record<string, Set<string>> = Object.fromEntries(prefixes.map(([, name]) => [name, declared(name)]))
const found: [string, string, string][] = [] // gateway, path, where
const outdated: string[] = [] // Desktop's pre-v1.4 paths, with where
async function scan(dir: URL) {
    for await (const entry of Deno.readDir(dir)) {
        const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), dir)
        if (entry.isDirectory) {
            await scan(url)
            continue
        }
        if (!/\.(ts|tsx|js)$/.test(entry.name)) {
            continue
        }
        const lines = (await Deno.readTextFile(url)).split("\n")
        lines.forEach((line, n) => {
            if (/^\s*(\/\/|\*|\/\*)/.test(line)) {
                return // a comment
            }
            const where = `${url.pathname.split("/frontend/")[1] ?? url.pathname}:${n + 1}`
            for (
                const [, quoted] of line.matchAll(
                    /["'`]((?:\.\.\/)*\/?(?:gateways|apps|dimos-gateway|agent-gateway|dimos|api|recordings|desktop)\/[^"'`]*)["'`]/g,
                )
            ) {
                if (!/^(\.\.\/|\/)/.test(quoted)) {
                    continue // the app's own api/ (relative), not Desktop's
                }
                const path = quoted.replace(/^(\.\.\/)+/, "/")
                const prefix = prefixes.find(([pattern]) => pattern.test(path))
                if (!prefix) {
                    if (!/^\/apps\//.test(path)) {
                        outdated.push(`  ${path}  (${where})`)
                    }
                    continue // another app's page
                }
                const route = shape(path.replace(prefix[0], "/"))
                if (route === "" || route === "/{}") {
                    continue // a prefix, not an endpoint
                }
                found.push([prefix[1], route, where])
            }
        })
    }
}
await scan(new URL("../frontend/src/", import.meta.url))
if (outdated.length) {
    console.error(
        `the pages call Desktop's old paths (see Desktop's spec v1.4 for the new ones):\n${outdated.join("\n")}`,
    )
    Deno.exit(1)
}
const undeclared = found.filter(([gateway, route]) => !gateways[gateway].has(route))
if (undeclared.length) {
    console.error(
        `dimos.yaml's uses: doesn't declare Desktop endpoints the pages call:\n${
            undeclared.map(([gateway, route, where]) => `  ${gateway} ${route}  (${where})`).join("\n")
        }`,
    )
    Deno.exit(1)
}
console.log(`dimos.yaml declares all ${new Set(found.map(([g, r]) => g + r)).size} Desktop endpoints the pages call`)
