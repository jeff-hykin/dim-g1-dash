// dimos-app-server: this app's API and its built frontend on the unix socket Desktop gives (DIMOS_APP's `socket`, the
// one interface: docs/apps.md), else port 8787 (G1_DASH_PORT) for a standalone run. `--frontend` is the nix wrapper's, not Desktop's.
import { initLog } from "./applog.ts"
import { dimosApp } from "./dimos_app.ts"
import { startHealth } from "./health.ts"
import { eventsSocket, handle, publishEvent } from "./http.ts"
import { recordingStatus, recoverRecordings } from "./recording.ts"
import { DESCRIPTION, routes } from "./routes.ts"
import { linkKind, ready, snapshot, start } from "./robot.ts"

function flag(name: string): string | undefined {
    const index = Deno.args.indexOf(`--${name}`)
    return index === -1 ? undefined : Deno.args[index + 1]
}

const frontend = flag("frontend") ?? new URL("../frontend/dist", import.meta.url).pathname
const types: Record<string, string> = {
    html: "text/html; charset=utf-8",
    js: "text/javascript",
    css: "text/css",
    svg: "image/svg+xml",
    png: "image/png",
    json: "application/json",
    jpg: "image/jpeg",
    wasm: "application/wasm",
}

async function file(path: string): Promise<Response> {
    const clean = path.split("/").filter((part) => part && part !== "..").join("/") || "index.html"
    for (const candidate of [clean, "index.html"]) {
        try {
            const bytes = await Deno.readFile(`${frontend}/${candidate}`)
            const type = types[candidate.split(".").pop() ?? ""] ?? "application/octet-stream"
            return new Response(bytes, { headers: { "content-type": type } })
        } catch {
            // next candidate: unknown paths get the app (hash routing)
        }
    }
    return new Response("not found", { status: 404 })
}

async function serve(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname
    if (path === "/api/events/ws") {
        return eventsSocket(request)
    }
    return (await handle(request, routes, DESCRIPTION)) ?? file(path)
}

initLog()
recoverRecordings() // a recording a quit or crash ended gets its footer, so it opens
start() // the robot link: the native helper (or G1_SIMULATE=1)
startHealth({
    link: () => (linkKind() === "simulator" ? "simulator" : ready() ? "ready" : "down"),
    lidarWatched: () => {
        const state = snapshot()
        return state.devices.lidarClaimed && ["walk", "primitive_walk", "stand", "stiffen"].includes(state.mode ?? "")
    },
    hottest: () => {
        const hot = snapshot().hottestMotor
        return hot ? { celsius: hot.celsius, name: hot.name } : null
    },
    onLidar: () => publishEvent({ type: "record", record: recordingStatus() }),
})

const socket = dimosApp().socket
if (socket) {
    try {
        Deno.removeSync(socket)
    } catch {
        // not there
    }
    Deno.serve({ path: socket, transport: "unix", onListen: () => console.error(`listening on ${socket}`) }, serve)
} else {
    Deno.serve({ port: Number(Deno.env.get("G1_DASH_PORT") ?? 8787) }, serve)
}
