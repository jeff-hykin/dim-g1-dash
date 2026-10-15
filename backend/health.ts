// The Jetson's and the link's side of a problem (go2-dash's health.rs, for the G1). Every SAMPLE_MS a sample — CPU
// (machine and this app), load, memory, the Wi-Fi (interface, SSID, signal, bitrates, frequency, address), the default
// route, the helper link (up?, how long since the robot last reported) — goes into a RAM ring of the last BUFFER.
// Every LOG_EVERY samples one is a "health:" line in g1-ctrl.log and, while recording, {"type":"health"} on /logs.
// When something goes wrong (see `conditions`) — Wi-Fi dropped or changed network/address/route, weak signal, the
// helper down or silent, a pegged CPU — the samples since the last dump go to the log ("health detail:") and the
// recording ({"type":"health_dump", reason, samples}). Also per second while recording: rx_stats (what the helper sent,
// by type) and, every 5 s, the hottest motor; the lidar watch runs here too. Linux reads /proc, `iw` and `ip`; other
// systems (a dev Mac) get CPU load and memory only.
import { logLine } from "./applog.ts"
import { lidarWatch, recording, recordLog } from "./recording.ts"

// deno-lint-ignore no-explicit-any -- samples are free-form JSON
type Json = Record<string, any>

const SAMPLE_MS = 500
const BUFFER = 240 // 2 minutes
const LOG_EVERY = 4 // samples: every 2 s
export const WEAK_SIGNAL_DBM = -80
export const SILENT_MS = 1500
export const CPU_PEGGED = 95

// ── what the helper sent (robot.ts calls rx) ──
let rxCounts: Record<string, number> = {}
let lastRxAt = 0

export function rx(type: string) {
    rxCounts[type] = (rxCounts[type] ?? 0) + 1
    if (type === "state") {
        lastRxAt = Date.now()
    }
}

/** /proc/stat's first line: [busy, total] jiffies */
export function systemTicks(stat: string): [number, number] | null {
    const fields = (stat.split("\n")[0] ?? "").trim().split(/\s+/).slice(1).map(Number).filter(Number.isFinite)
    if (fields.length < 5) {
        return null
    }
    const total = fields.reduce((a, b) => a + b, 0)
    return [total - fields[3] - fields[4], total]
}

/** `iw dev <if> link`: SSID, signal, bitrates, frequency; {connected: false} when it isn't */
export function parseIwLink(text: string): Json {
    if (text.startsWith("Not connected")) {
        return { connected: false }
    }
    const field = (key: string) =>
        text.split("\n").map((line) => line.trim()).find((line) => line.startsWith(key))?.slice(key.length).trim() ??
            null
    return {
        ssid: field("SSID:"),
        signal: field("signal:"),
        txBitrate: field("tx bitrate:"),
        rxBitrate: field("rx bitrate:"),
        freq: field("freq:"),
    }
}

/** /proc/net/route: the default routes ("wlan0 via 192.168.12.1 metric 600"), joined by " | " */
export function defaultRoutes(table: string): string {
    return table.split("\n").slice(1).map((line) => line.trim().split(/\s+/)).filter((f) => f[1] === "00000000")
        .map((f) => {
            const gw = parseInt(f[2], 16)
            return `${f[0]} via ${gw & 255}.${(gw >> 8) & 255}.${(gw >> 16) & 255}.${(gw >>> 24) & 255} metric ${f[6]}`
        }).join(" | ")
}

const dbm = (text: unknown) => typeof text === "string" ? parseFloat(text) : NaN

/** Everything wrong in one sample, by key → what to say about it (a condition dumps once, when it starts). */
export function conditions(sample: Json): Map<string, string> {
    const wrong = new Map<string, string>()
    const wifi = sample.wifi
    if (wifi && wifi.connected === false) {
        wrong.set("wifi", "Wi-Fi disconnected")
    }
    const signal = Number.isFinite(dbm(wifi?.signal)) ? dbm(wifi?.signal) : dbm(wifi?.level)
    if (signal < WEAK_SIGNAL_DBM) {
        wrong.set("signal", `weak signal ${signal} dBm`)
    }
    const robot = sample.robot
    if (robot && robot.link !== "ready") {
        wrong.set("link", `robot link ${robot.link}`)
    }
    if (robot?.link === "ready" && typeof robot.silentMs === "number" && robot.silentMs > SILENT_MS) {
        wrong.set("silent", `robot silent for ${robot.silentMs} ms`)
    }
    if (typeof sample.cpu === "number" && sample.cpu > CPU_PEGGED) {
        wrong.set("cpu", `CPU ${sample.cpu}%`)
    }
    return wrong
}

/** What a "wifi changed" dump is about: the network, the address and the route, not the signal's wobble. */
export function linkKey(sample: Json): string {
    return `${sample.wifi?.ssid ?? null} ${sample.wifi?.addr ?? null} ${sample.route ?? ""}`
}

async function run(cmd: string, args: string[]): Promise<string> {
    try {
        const out = await new Deno.Command(cmd, { args, stdout: "piped", stderr: "null" }).output()
        return new TextDecoder().decode(out.stdout).trim()
    } catch {
        return ""
    }
}

const read = (path: string) => {
    try {
        return Deno.readTextFileSync(path)
    } catch {
        return ""
    }
}

class Sampler {
    count = 0
    #lastSystem: [number, number] | null = null
    #lastApp: { ticks: number; at: number } | null = null
    #addr: string | null = null

    async sample(): Promise<Json> {
        const memory = (() => {
            try {
                return Math.round(Deno.systemMemoryInfo().available / 1024 / 1024)
            } catch {
                return null
            }
        })()
        const sample: Json = {
            load: (() => {
                try {
                    return Deno.loadavg().map((n) => n.toFixed(2)).join(" ")
                } catch {
                    return null
                }
            })(),
            memAvailableMb: memory,
            appRssMb: Math.round(Deno.memoryUsage().rss / 1024 / 1024),
        }
        if (Deno.build.os !== "linux") {
            return sample
        }
        const now = systemTicks(read("/proc/stat"))
        if (now && this.#lastSystem) {
            sample.cpu = Math.round(1000 * (now[0] - this.#lastSystem[0]) / Math.max(1, now[1] - this.#lastSystem[1])) /
                10
        }
        this.#lastSystem = now
        const stat = read("/proc/self/stat")
        const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
        const ticks = Number(rest[11]) + Number(rest[12])
        if (Number.isFinite(ticks)) {
            const at = performance.now()
            if (this.#lastApp) {
                sample.appCpu = Math.round(
                    (ticks - this.#lastApp.ticks) / Math.max(0.001, (at - this.#lastApp.at) / 1000),
                )
            }
            this.#lastApp = { ticks, at }
        }
        // "wlan0: 0000   54.  -56.  -256 …": the interface and its signal level, even without `iw`
        const wireless = read("/proc/net/wireless").split("\n")[2]
        const iface = wireless?.split(":")[0]?.trim()
        if (iface) {
            const wifi = parseIwLink(await run("iw", ["dev", iface, "link"]))
            wifi.iface = iface
            wifi.level = wireless.trim().split(/\s+/)[3]?.replace(/\.$/, "") ?? null
            if (this.count % LOG_EVERY === 0) {
                this.#addr = (await run("ip", ["-4", "-o", "addr", "show", iface])).split(/\s+/)[3] ?? null
            }
            wifi.addr = this.#addr
            sample.wifi = wifi
        }
        sample.route = defaultRoutes(read("/proc/net/route"))
        return sample
    }
}

export type HealthDeps = {
    /** the helper link: "ready" / "down" / "simulator" */
    link: () => string
    /** whether the lidar watch applies: the lidar claimed and the robot up on its legs */
    lidarWatched: () => boolean
    /** the hottest motor now (°C and its name), for /logs every 5 s */
    hottest: () => { celsius: number; name: string | null } | null
    /** the lidar watch fired or cleared: tell the page */
    onLidar: (event: "silent" | "resumed") => void
}

export function startHealth(deps: HealthDeps) {
    const sampler = new Sampler()
    const ring: Json[] = []
    let lastKey = ""
    let active = new Map<string, string>()
    let dumpedTo = 0
    let busy = false
    setInterval(async () => {
        if (busy) {
            return // a slow `iw`: skip a tick rather than pile up
        }
        busy = true
        try {
            const sample = await sampler.sample()
            sampler.count++
            const t = Date.now()
            sample.t = t
            const link = deps.link()
            sample.robot = { link, silentMs: lastRxAt ? t - lastRxAt : null }
            ring.push(sample)
            ring.splice(0, ring.length - BUFFER)

            const reasons: string[] = []
            const key = linkKey(sample)
            if (lastKey && key !== lastKey) {
                reasons.push(`wifi changed: ${JSON.stringify(sample.wifi ?? null)} route ${sample.route ?? ""}`)
            }
            lastKey = key
            const now = link === "simulator" ? new Map<string, string>() : conditions(sample)
            for (const [condition, text] of now) {
                if (!active.has(condition)) {
                    reasons.push(text)
                }
            }
            active = now

            const lidar = lidarWatch(deps.lidarWatched(), t)
            if (lidar) {
                logLine(`lidar watch: ${lidar === "silent" ? "no point clouds for 20 s" : "point clouds resumed"}`)
                deps.onLidar(lidar)
            }
            if (sampler.count % 2 === 0 && recording()) {
                recordLog({ type: "rx_stats", window_s: 1, counts: rxCounts })
            }
            if (sampler.count % 2 === 0) {
                rxCounts = {}
            }
            const hot = deps.hottest()
            if (sampler.count % 10 === 0 && hot && recording()) {
                recordLog({ type: "motor_temps", hottest: hot })
            }
            if (reasons.length) {
                const reason = reasons.join("; ")
                const samples = ring.filter((s) => s.t > dumpedTo)
                logLine(`health event: ${reason} (${samples.length} samples follow)`)
                for (const s of samples) {
                    logLine(`health detail: ${JSON.stringify(s)}`)
                }
                recordLog({ type: "health_dump", reason, samples })
                dumpedTo = t
            } else if (sampler.count % LOG_EVERY === 0) {
                logLine(`health: ${JSON.stringify(sample)}`)
                recordLog({ type: "health", ...sample })
            }
        } finally {
            busy = false
        }
    }, SAMPLE_MS)
}
