// g1_dash — backend half (runs in the Deno dashboard process, onboard the G1's Jetson).
//
// The G1 controller runs *on the robot*, so this backend has direct hardware
// access. Talking to the MID360 (Livox), the RealSense, and the G1 itself
// (unitree_sdk2 over DDS) all needs native code, so this can't be pure Deno — we
// `nix run` the standalone C++ helper in ./g1_helper_cpp, which speaks
// newline-JSON over stdio. We relay that to/from the browser panel over the
// app-bus under the "g1" tag, and pipe the panel's control commands back down.
//
// Optionally we also subscribe to the dimos LCM bridge (ctx.Dimos) and forward
// any live streams to the panel under the "lcm" tag — handy when other dimos
// modules are already running alongside this app.

import { TextLineStream } from "https://deno.land/std@0.224.0/streams/text_line_stream.ts"
import { DimAppBackend, dimContext } from "https://esm.sh/gh/jeff-hykin/dim-app@v0.3.0/backend.js"

const HELPER_DIR = new URL("./g1_helper_cpp", import.meta.url).pathname
const RESTART_MS = 3000
const HOME = Deno.env.get("HOME") || "."

const dimApp = new DimAppBackend()
const ctx = dimContext()

let child = null
let writer = null
let helperReady = false
// Last status/state seen, replayed to a panel that opens mid-session so it isn't
// blank until the next event arrives.
let lastStatus = null
let lastState = null
// Why the helper can't come up (e.g. no nix on this machine) — shown by the
// panel instead of an eternal "waiting for the onboard helper".
let backendNote = null

// Find the `nix` binary. A GUI-launched dashboard may not inherit the shell PATH
// that has nix on it, so fall back to the usual install locations.
let cachedNixBin
async function resolveNixBin() {
    if (cachedNixBin !== undefined) return cachedNixBin
    const candidates = [
        "nix",
        `${HOME}/.nix-profile/bin/nix`,
        "/nix/var/nix/profiles/default/bin/nix",
        "/run/current-system/sw/bin/nix",
        "/usr/local/bin/nix",
        `${HOME}/Commands/nix`,
    ]
    for (const bin of candidates) {
        try {
            const out = await new Deno.Command(bin, { args: ["--version"], stdout: "null", stderr: "null" }).output()
            if (out.success) { cachedNixBin = bin; return bin }
        } catch { /* not here — try the next candidate */ }
    }
    cachedNixBin = null
    return null
}

function sendToHelper(obj) {
    if (!writer) return
    writer.write(new TextEncoder().encode(JSON.stringify(obj) + "\n"))
        .catch(() => { /* helper gone — status flips on exit */ })
}

function pushStatus() {
    dimApp.send("g1", { type: "status", ready: helperReady, status: lastStatus, state: lastState, note: backendNote })
}

async function start() {
    const nix = await resolveNixBin()
    if (!nix) {
        helperReady = false
        backendNote = "`nix` was not found on this machine, so the onboard C++ helper can't be built. " +
            "G1 Dash is meant to run on the G1's own Jetson — install the dim dashboard there and " +
            "`dim install` this app on the robot. (Or install nix here if this really is the robot.)"
        pushStatus()
        console.error("g1_dash: `nix` not found on PATH — cannot build the G1 helper")
        setTimeout(start, RESTART_MS)
        return
    }
    backendNote = null
    try {
        // `nix run` builds the helper on first launch (cached thereafter), then
        // execs it with stdio forwarded. The first build compiles the robot SDKs
        // and can take several minutes; the child stays alive during it.
        child = new Deno.Command(nix, {
            args: [
                "run",
                "--extra-experimental-features", "nix-command flakes",
                `path:${HELPER_DIR}`,
            ],
            stdin: "piped",
            stdout: "piped",
            stderr: "inherit", // surface nix build progress + helper logs in dashboard logs
        }).spawn()
    } catch (err) {
        helperReady = false
        pushStatus()
        console.error(`g1_dash: could not start helper — ${err.message}`)
        setTimeout(start, RESTART_MS)
        return
    }
    writer = child.stdin.getWriter()

    ;(async () => {
        const lines = child.stdout
            .pipeThrough(new TextDecoderStream())
            .pipeThrough(new TextLineStream())
        for await (const line of lines) {
            if (!line.trim()) continue
            let event
            try { event = JSON.parse(line) } catch { continue }
            if (event.type === "ready") { helperReady = true; pushStatus() }
            else if (event.type === "status") { lastStatus = event }
            else if (event.type === "state") { lastState = event }
            // Everything the helper emits is relayed verbatim to the panel.
            dimApp.send("g1", event)
        }
    })()

    child.status.then(() => {
        helperReady = false
        writer = null
        child = null
        pushStatus()
        setTimeout(start, RESTART_MS)
    })
}

// ── optional dimos LCM bridge ────────────────────────────────────────────────
// If a dimos bridge is reachable, forward its live streams to the panel too.
// Non-fatal: the app is fully functional on the C++ helper alone.
async function startLcmBridge() {
    if (!ctx?.Dimos || !ctx?.bridge) return
    try {
        const conn = await ctx.Dimos.connect({ dimosWs: { host: ctx.bridge.host, port: ctx.bridge.port } })
        conn.subscribeAll((message) => {
            dimApp.send("lcm", { stream: message.stream, data: message.data })
        })
        console.error("g1_dash: LCM bridge connected")
    } catch (err) {
        console.error(`g1_dash: LCM bridge unavailable (${err.message}) — helper-only mode`)
    }
}

dimApp.onReceive((kind, payload) => {
    if (kind === "move") {
        sendToHelper({ type: "move", vx: payload?.vx || 0, vy: payload?.vy || 0, omega: payload?.omega || 0 })
    } else if (kind === "cmd") {
        // name plus any extras (e.g. gait for the basic balance sequence)
        sendToHelper({ type: "cmd", ...(payload || {}) })
    } else if (kind === "estop") {
        sendToHelper({ type: "estop" })
    } else if (kind === "config") {
        sendToHelper({ type: "config", ...(payload || {}) })
    } else if (kind === "hello") {
        pushStatus() // bring a freshly-opened panel up to date
    }
})

start()
startLcmBridge()
