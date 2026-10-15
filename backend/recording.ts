// The Record button's writer: one .mcap per recording in Desktop's recordings folder under g1/
// (<local date>_<time>_g1_<host>.mcap), JSON messages on these topics:
//   /state         the helper's lowstate summary, 10 Hz: IMU (rpy, gyro, accel), joint positions, battery, hottest motor
//   /loco          the loco service's FSM, balance mode and motion service, 1 Hz
//   /lidar         the MID360 cloud (foxglove.PointCloud), as the panel gets it
//   /color_image   the RealSense frames the helper serves (foxglove.CompressedImage), while the camera is connected
//   /cmd_vel       every velocity sent; /robot_action every command and E-STOP; /joystick the raw gamepad
//   /logs          everything else as typed JSON: button presses, notices, overheat, health, rx_stats, lidar watch, …
// Started only by a person (api/record/start); never on its own. It runs until api/record/stop or the app quits.
// A file a quit or crash left unfinished is finished on the next start (recoverRecordings).
import { logLine } from "./applog.ts"
import { recordingsDir } from "./dimos_app.ts"
import { type Channel, isFinished, McapWriter, recoverMcap } from "./mcap.ts"

// deno-lint-ignore no-explicit-any -- recorded messages are free-form JSON
type Json = Record<string, any>

/** a recording, standing robot with the lidar claimed that's sent no cloud for this long: the lidar watch fires */
export const LIDAR_SILENT_MS = 20_000

const TIME = { type: "object", properties: { sec: { type: "integer" }, nsec: { type: "integer" } } }
const SCHEMAS: Record<string, [string, unknown]> = {
    "/state": ["g1.State", { type: "object" }],
    "/loco": ["g1.Loco", { type: "object" }],
    "/cmd_vel": ["g1.Velocity", { type: "object" }],
    "/robot_action": ["g1.Action", { type: "object" }],
    "/joystick": ["g1.Joy", { type: "object" }],
    "/logs": ["g1.Log", { type: "object" }],
    "/color_image": ["foxglove.CompressedImage", {
        type: "object",
        properties: {
            timestamp: TIME,
            frame_id: { type: "string" },
            data: { type: "string", contentEncoding: "base64" },
            format: { type: "string" },
        },
    }],
    "/lidar": ["foxglove.PointCloud", {
        type: "object",
        properties: {
            timestamp: TIME,
            frame_id: { type: "string" },
            pose: { type: "object" },
            point_stride: { type: "integer" },
            fields: { type: "array" },
            data: { type: "string", contentEncoding: "base64" },
        },
    }],
}
export const TOPICS = Object.keys(SCHEMAS)

type Active = {
    writer: McapWriter
    file: string
    startedAt: number
    channels: Map<string, Channel>
    lidarSilentSince: number | null
    cameraAbort: AbortController
}

let active: Active | null = null
let lastLidarAt = 0
let cameraSource: () => string | null = () => null

export function base64(bytes: Uint8Array): string {
    let binary = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
}

const stamp = (ms: number) => ({ sec: Math.floor(ms / 1000), nsec: Math.round((ms % 1000) * 1e6) })

export function recording(): boolean {
    return active !== null
}

/** Writes `message` on `topic` when a recording runs (otherwise nothing). `atMs`: when it happened. */
export function record(topic: string, message: unknown, atMs = Date.now()) {
    if (!active) {
        return
    }
    let channel = active.channels.get(topic)
    if (!channel) {
        const [name, schema] = SCHEMAS[topic] ?? ["g1.Unknown", { type: "object" }]
        channel = active.writer.channel(topic, name, schema)
        active.channels.set(topic, channel)
    }
    active.writer.write(channel, BigInt(Math.round(atMs * 1e6)), message)
}

/** A typed event on /logs (it also needs to be in the app log: callers do that, in their own words). */
export function recordLog(event: Json) {
    record("/logs", { t: Date.now(), ...event })
}

/** The lidar cloud as a foxglove.PointCloud ([x,y,z,…] floats, robot frame). */
export function recordLidar(cloud: number[], atMs = Date.now()) {
    lastLidarAt = atMs
    if (!active) {
        return
    }
    const points = new Float32Array(cloud)
    record("/lidar", {
        timestamp: stamp(atMs),
        frame_id: "base_link",
        pose: { position: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
        point_stride: 12,
        fields: ["x", "y", "z"].map((name, i) => ({ name, offset: 4 * i, type: 7 })),
        data: base64(new Uint8Array(points.buffer)),
    }, atMs)
}

/** Where the camera's MJPEG is while it's connected (robot.ts), null while it isn't. */
export function setCameraSource(source: () => string | null) {
    cameraSource = source
}

function exists(path: string) {
    try {
        Deno.statSync(path)
        return true
    } catch {
        return false
    }
}

function fileName(now = new Date()) {
    const two = (n: number) => String(n).padStart(2, "0")
    const date = `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
    const time = `${two(now.getHours())}-${two(now.getMinutes())}-${two(now.getSeconds())}`
    const host = (Deno.hostname?.() ?? "host").replace(/[^\w.-]+/g, "-")
    return `${date}_${time}_g1_${host}.mcap`
}

export function recordingStatus() {
    if (!active) {
        return { active: false }
    }
    return {
        active: true,
        file: active.file,
        path: active.writer.path,
        startedAt: active.startedAt,
        seconds: Math.round((Date.now() - active.startedAt) / 1000),
        bytes: active.writer.bytes,
        messages: active.writer.messages,
        lidarSilentS: active.lidarSilentSince === null
            ? null
            : Math.round((Date.now() - active.lidarSilentSince) / 1000),
    }
}

/** Starts a recording (a person pressed Record, or an agent asked); a running one is left as it is. */
export function startRecording(dir = recordingsDir()) {
    if (active) {
        return recordingStatus()
    }
    Deno.mkdirSync(dir, { recursive: true })
    // two in the same second (stop, Record again): the second gets _2
    const base = fileName()
    let file = base
    for (let n = 2; exists(`${dir}/${file}`); n++) {
        file = base.replace(/\.mcap$/, `_${n}.mcap`)
    }
    const writer = new McapWriter(`${dir}/${file}`)
    active = {
        writer,
        file,
        startedAt: Date.now(),
        channels: new Map(),
        lidarSilentSince: null,
        cameraAbort: new AbortController(),
    }
    logLine(`recording started: ${writer.path}`)
    recordLog({ type: "recording_started", file })
    captureCamera(active)
    return recordingStatus()
}

export function stopRecording() {
    const ending = active
    if (!ending) {
        return { active: false, stopped: false }
    }
    recordLog({ type: "recording_stopped" })
    active = null
    ending.cameraAbort.abort()
    ending.writer.close()
    logLine(
        `recording stopped: ${ending.writer.path} (${ending.writer.messages} messages, ${ending.writer.bytes} bytes)`,
    )
    return { active: false, stopped: true, file: ending.file, bytes: ending.writer.bytes }
}

/** This app's recordings, newest first. */
export function listRecordings(dir = recordingsDir()) {
    const files: { file: string; bytes: number; modified: string | null; recording: boolean }[] = []
    try {
        for (const entry of Deno.readDirSync(dir)) {
            if (!entry.isFile || !entry.name.endsWith(".mcap")) {
                continue
            }
            const info = Deno.statSync(`${dir}/${entry.name}`)
            files.push({
                file: entry.name,
                bytes: info.size,
                modified: info.mtime?.toISOString() ?? null,
                recording: active?.file === entry.name,
            })
        }
    } catch {
        // no folder yet
    }
    return { directory: dir, recordings: files.sort((a, b) => b.file.localeCompare(a.file)) }
}

/** At start: finish every recording a quit or crash left without its footer, so each one opens. */
export function recoverRecordings(dir = recordingsDir()): string[] {
    const finished: string[] = []
    for (const { file } of listRecordings(dir).recordings) {
        const path = `${dir}/${file}`
        try {
            if (isFinished(path)) {
                continue
            }
            const records = recoverMcap(path)
            if (records !== null) {
                finished.push(file)
                logLine(
                    `recording ${file} was left unfinished (a quit or crash): finished it (${records} records kept)`,
                )
            }
        } catch (error) {
            logLine(`recording ${file}: couldn't finish it: ${(error as Error).message}`)
        }
    }
    return finished
}

/** The lidar watch: a recording, standing robot with the lidar claimed that's sent no cloud for LIDAR_SILENT_MS.
 * Returns "silent" / "resumed" when that starts or ends (health.ts calls it every sample). */
export function lidarWatch(watching: boolean, now = Date.now()): "silent" | "resumed" | null {
    if (!active) {
        return null
    }
    const last = Math.max(lastLidarAt, active.startedAt)
    const silent = watching && now - last >= LIDAR_SILENT_MS
    if (silent && active.lidarSilentSince === null) {
        active.lidarSilentSince = last
        recordLog({ type: "lidar_silent", since_ms: last, silent_s: Math.round((now - last) / 1000) })
        return "silent"
    }
    if (!silent && active.lidarSilentSince !== null) {
        recordLog({ type: "lidar_resumed", silent_s: Math.round((now - active.lidarSilentSince) / 1000) })
        active.lidarSilentSince = null
        return "resumed"
    }
    return null
}

const HEADER_END = new TextEncoder().encode("\r\n\r\n")

function find(haystack: Uint8Array, needle: Uint8Array, from: number) {
    outer: for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                continue outer
            }
        }
        return i
    }
    return -1
}

/** Frames of a multipart MJPEG body: each part's JPEG and its X-Timestamp (ms), by Content-Length. */
export async function* mjpegFrames(
    body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ jpeg: Uint8Array; atMs: number }> {
    let buffer = new Uint8Array(0)
    for await (const chunk of body) {
        const merged = new Uint8Array(buffer.length + chunk.length)
        merged.set(buffer)
        merged.set(chunk, buffer.length)
        buffer = merged
        for (;;) {
            const headerAt = find(buffer, HEADER_END, 0)
            if (headerAt < 0) {
                break
            }
            const head = new TextDecoder().decode(buffer.subarray(0, headerAt))
            const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1])
            const bodyAt = headerAt + HEADER_END.length
            if (!length) {
                buffer = buffer.slice(bodyAt) // a part without a length: skip its header
                continue
            }
            if (buffer.length < bodyAt + length) {
                break
            }
            const sent = Number(/x-timestamp:\s*(\d+)/i.exec(head)?.[1])
            yield {
                jpeg: buffer.slice(bodyAt, bodyAt + length),
                atMs: Number.isFinite(sent) && sent > 0 ? sent : Date.now(),
            }
            buffer = buffer.slice(bodyAt + length)
        }
    }
}

/** While `rec` runs: the camera's frames onto /color_image whenever it's connected; retried every 2 s. */
async function captureCamera(rec: Active) {
    const signal = rec.cameraAbort.signal
    while (!signal.aborted) {
        const url = cameraSource()
        if (url) {
            try {
                const response = await fetch(url, { signal })
                if (response.ok && response.body) {
                    for await (const { jpeg, atMs } of mjpegFrames(response.body)) {
                        record("/color_image", {
                            timestamp: stamp(atMs),
                            frame_id: "camera",
                            data: base64(jpeg),
                            format: "jpeg",
                        }, atMs)
                    }
                } else {
                    await response.body?.cancel()
                }
            } catch {
                // the camera went away (or the recording stopped): try again below
            }
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
    }
}
