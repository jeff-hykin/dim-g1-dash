// Every G1 Ctrl action, as an endpoint (http.ts). The panel calls only these, and so can Desktop's agent. Anything
// that moves or reconfigures the robot takes `dryRun: true`, which validates and answers with what would be sent
// without sending it.
import { HttpError, publishEvent, type Route } from "./http.ts"
import {
    blockedReason,
    COMMANDS,
    describeCommand,
    DRIVE_DEFAULTS,
    DRIVE_LIMITS,
    MOVE_LIMITS,
    resolveCommand,
} from "./g1.ts"
import * as robot from "./robot.ts"

export const DESCRIPTION = "G1 Ctrl: drive and monitor a Unitree G1 humanoid from its onboard Jetson — modes, " +
    "postures, gestures, driving, E-STOP, the RealSense camera, the MID360 lidar and telemetry"

const dryRunParam = {
    type: "boolean",
    description: "validate and return what would be sent, without touching the robot",
}

function bool(value: unknown, name: string): boolean {
    if (typeof value === "boolean") {
        return value
    }
    if (value === "true" || value === "false") {
        return value === "true"
    }
    throw new HttpError(400, `${name} must be true or false`)
}

function number(value: unknown, name: string, fallback?: number): number {
    if (value === undefined && fallback !== undefined) {
        return fallback
    }
    const n = Number(value)
    if (value === null || value === "" || !Number.isFinite(n)) {
        throw new HttpError(400, `${name} must be a number`)
    }
    return n
}

/** Sends to the helper, or says what it would have sent. */
function deliver(message: Record<string, unknown>, dryRun: unknown, extra: Record<string, unknown> = {}) {
    if (dryRun === true || dryRun === "true") {
        return { dryRun: true, wouldSend: message, linkReady: robot.ready(), ...extra }
    }
    try {
        robot.send(message)
    } catch (error) {
        throw new HttpError(503, (error as Error).message)
    }
    return { ok: true, sent: message, ...extra }
}

function commandsNow() {
    const mode = robot.currentMode()
    return COMMANDS.map((command) => describeCommand(command, mode))
}

// ── the MJPEG stream the helper serves on its own port (127.0.0.1:<cameraPort>/stream) ──
function streamUrl() {
    return `http://127.0.0.1:${robot.cameraPort()}/stream`
}

async function openStream(signal?: AbortSignal): Promise<Response> {
    if (!robot.ready() || robot.snapshot().devices.camera !== true) {
        throw new HttpError(503, "the camera isn't connected — PUT api/camera { connected: true } first")
    }
    try {
        const response = await fetch(`${streamUrl()}?t=${Date.now()}`, { signal })
        if (!response.ok || !response.body) {
            throw new Error(`HTTP ${response.status}`)
        }
        return response
    } catch (error) {
        if (error instanceof HttpError) {
            throw error
        }
        throw new HttpError(503, `the camera stream isn't reachable (${(error as Error).message})`)
    }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0) {
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

async function firstFrame(): Promise<Uint8Array> {
    const abort = new AbortController()
    const timeout = setTimeout(() => abort.abort(), 5000)
    try {
        const reader = (await openStream(abort.signal)).body!.getReader()
        const headerEnd = new TextEncoder().encode("\r\n\r\n")
        let buffer = new Uint8Array(0)
        for (;;) {
            const { done, value } = await reader.read()
            if (done) {
                throw new HttpError(503, "the camera stream ended before a frame arrived")
            }
            const merged = new Uint8Array(buffer.length + value.length)
            merged.set(buffer)
            merged.set(value, buffer.length)
            buffer = merged
            const headerAt = indexOf(buffer, headerEnd)
            if (headerAt < 0) {
                continue
            }
            const length = Number(
                /content-length:\s*(\d+)/i.exec(new TextDecoder().decode(buffer.subarray(0, headerAt)))?.[1],
            )
            const bodyAt = headerAt + headerEnd.length
            if (length && buffer.length >= bodyAt + length) {
                return buffer.slice(bodyAt, bodyAt + length)
            }
        }
    } catch (error) {
        if (error instanceof HttpError) {
            throw error
        }
        throw new HttpError(503, `no camera frame (${(error as Error).message})`)
    } finally {
        clearTimeout(timeout)
        abort.abort()
    }
}

export const routes: Route[] = [
    {
        method: "GET",
        path: "api/state",
        description: "The robot right now: link, devices (claimed/connected), mode, loco FSM, battery, attitude, " +
            "hottest motor, joint positions, lidar summary, drive settings",
        role: "context",
        handler: () => robot.snapshot(),
    },
    {
        method: "GET",
        path: "api/commands",
        description: "Every mode/posture/gesture command for api/command, worded for the current mode: what mode it " +
            "puts the robot in, whether it's dangerous (needs confirm), and why it's blocked right now (if it is)",
        handler: () => ({ mode: robot.currentMode(), commands: commandsNow() }),
    },
    {
        method: "POST",
        path: "api/command",
        description: "Run a robot command by id (see api/commands): stiffen, walk, collapse, wave, shake, squat, " +
            "standup, sit, zerotorque, stand, primitive-walk-slow, primitive-walk-fast, wave-turn, release-arms, " +
            "high-stand, low-stand. MOVES THE ROBOT. Dangerous ones (danger red/amber) need confirm: true.",
        params: {
            command: { type: "string", required: true, description: "the command id" },
            confirm: {
                type: "boolean",
                description: "required for dangerous commands: the robot may fall or self-balance",
            },
            dryRun: dryRunParam,
        },
        handler: ({ command, confirm, dryRun }) => {
            const raw = COMMANDS.find((c) => c.id === command)
            if (!raw) {
                throw new HttpError(
                    400,
                    `unknown command "${command}" — one of: ${COMMANDS.map((c) => c.id).join(", ")}`,
                )
            }
            const mode = robot.currentMode()
            const resolved = resolveCommand(raw, mode)
            const blocked = blockedReason(resolved, mode)
            if (blocked) {
                throw new HttpError(409, `${resolved.label} ${blocked}`)
            }
            if (resolved.danger && confirm !== true && confirm !== "true") {
                const plain = (resolved.warn ?? "").replace(/<br>/g, " ").replace(/<[^>]+>/g, "")
                throw new HttpError(409, `${resolved.label} is dangerous — ${plain} Pass confirm: true to run it.`)
            }
            const message = { type: "cmd", name: raw.name, ...(raw.gait ? { gait: raw.gait } : {}) }
            const result = deliver(message, dryRun, {
                command: raw.id,
                label: resolved.label,
                mode: resolved.mode ?? null,
            })
            if (!("dryRun" in result)) {
                robot.notify(resolved.seq ? `${resolved.label} — engaging…` : resolved.label)
            }
            return result
        },
    },
    {
        method: "POST",
        path: "api/move",
        description: "Drive: body velocity (vx forward m/s, vy left m/s, omega counter-clockwise rad/s). MOVES THE " +
            "ROBOT. The robot stops on its own ~0.4 s after the last move, so either repeat it (the panel sends 15/s) " +
            "or pass durationMs (≤ 5000) and the backend holds it that long, then stops. Needs mode walk or primitive_walk.",
        params: {
            vx: { type: "number", description: `m/s, |vx| ≤ ${MOVE_LIMITS.vx.toFixed(2)}` },
            vy: { type: "number", description: `m/s, |vy| ≤ ${MOVE_LIMITS.vy.toFixed(2)}` },
            omega: { type: "number", description: `rad/s, |omega| ≤ ${MOVE_LIMITS.omega.toFixed(2)}` },
            durationMs: { type: "number", description: "hold this velocity for this long, then stop (max 5000)" },
            dryRun: dryRunParam,
        },
        handler: ({ vx, vy, omega, durationMs, dryRun }) => {
            const velocity = { vx: number(vx, "vx", 0), vy: number(vy, "vy", 0), omega: number(omega, "omega", 0) }
            for (const [key, limit] of Object.entries(MOVE_LIMITS)) {
                if (Math.abs(velocity[key as keyof typeof velocity]) > limit + 1e-9) {
                    throw new HttpError(400, `${key} is limited to ±${limit.toFixed(2)}`)
                }
            }
            const duration = durationMs === undefined ? undefined : number(durationMs, "durationMs")
            if (duration !== undefined && (duration <= 0 || duration > 5000)) {
                throw new HttpError(400, "durationMs must be between 1 and 5000")
            }
            const state = robot.snapshot()
            const warning = state.drivable
                ? undefined
                : `driving needs mode walk or primitive_walk — robot is in ${state.mode}; the robot will likely ignore this`
            const message = { type: "move", ...velocity }
            if (dryRun === true || dryRun === "true") {
                return deliver(message, true, { durationMs: duration ?? null, ...(warning ? { warning } : {}) })
            }
            try {
                robot.move(velocity, duration)
            } catch (error) {
                throw new HttpError(503, (error as Error).message)
            }
            return { ok: true, sent: message, durationMs: duration ?? null, ...(warning ? { warning } : {}) }
        },
    },
    {
        method: "POST",
        path: "api/estop",
        description:
            "E-STOP: abort any sequence, zero velocity and damp immediately (the robot goes limp). Always allowed.",
        params: { dryRun: dryRunParam },
        handler: ({ dryRun }) => {
            if (dryRun !== true && dryRun !== "true") {
                robot.cancelTimedMove()
            }
            const result = deliver({ type: "estop" }, dryRun)
            if (!("dryRun" in result)) {
                robot.notify("E-STOP — damping")
            }
            return result
        },
    },
    {
        method: "PUT",
        path: "api/lidar",
        description: "Claim (connected: true) or release the MID360 lidar. It's exclusive: while claimed, other " +
            "programs (e.g. a SLAM stack) can't use it.",
        params: { connected: { type: "boolean", required: true }, dryRun: dryRunParam },
        handler: ({ connected, dryRun }) => deliver({ type: "config", lidar: bool(connected, "connected") }, dryRun),
    },
    {
        method: "PUT",
        path: "api/camera",
        description: "Claim (connected: true) or release the RealSense color camera. Exclusive: on a stock G1 " +
            "Unitree's videohub holds it — see api/camera/takeover.",
        params: { connected: { type: "boolean", required: true }, dryRun: dryRunParam },
        handler: ({ connected, dryRun }) => deliver({ type: "config", camera: bool(connected, "connected") }, dryRun),
    },
    {
        method: "POST",
        path: "api/camera/takeover",
        description: "Force the camera free: stop Unitree's master_service and its videohub_pc4 (which hold the " +
            "RealSense from boot), then claim it. The robot doesn't move, but its own video app loses the camera " +
            "until `sudo systemctl start master_service`. Needs the sudoers rules in the README.",
        params: { dryRun: dryRunParam },
        handler: async ({ dryRun }) => {
            if (dryRun === true || dryRun === "true") {
                return {
                    dryRun: true,
                    wouldRun: ["sudo -n systemctl stop master_service", "pkill -x videohub_pc4"],
                    wouldSend: { type: "config", camera: true },
                    linkReady: robot.ready(),
                }
            }
            if (!robot.ready()) {
                throw new HttpError(503, robot.snapshot().link.note ?? "the robot's helper isn't running")
            }
            const result = await robot.cameraTakeover()
            if (!result.stopped) {
                throw new HttpError(403, result.message)
            }
            return result
        },
    },
    {
        method: "PUT",
        path: "api/camera/stream",
        description: "Tune the camera stream: maxFps caps the frame rate (0 = uncapped), quality pins JPEG quality " +
            "(0 = adapt to the link)",
        params: {
            maxFps: { type: "number", description: "0-60, 0 = uncapped" },
            quality: { type: "number", description: "0-100, 0 = adaptive" },
        },
        handler: ({ maxFps, quality }) => {
            const message: Record<string, unknown> = { type: "config" }
            if (maxFps !== undefined) {
                const fps = number(maxFps, "maxFps")
                if (fps < 0 || fps > 60) {
                    throw new HttpError(400, "maxFps must be 0-60")
                }
                message.camMaxFps = Math.round(fps)
            }
            if (quality !== undefined) {
                const q = number(quality, "quality")
                if (q < 0 || q > 100) {
                    throw new HttpError(400, "quality must be 0-100")
                }
                message.camQuality = Math.round(q)
            }
            if (Object.keys(message).length === 1) {
                throw new HttpError(400, "give maxFps and/or quality")
            }
            return deliver(message, false)
        },
    },
    {
        method: "GET",
        path: "api/camera/stream",
        description: "The live camera as an MJPEG stream (multipart/x-mixed-replace; each part has an X-Timestamp " +
            "in ms) — for the page; agents want api/camera/snapshot",
        handler: async (_args, request) => {
            const upstream = await openStream(request.signal)
            return new Response(upstream.body, {
                headers: {
                    "content-type": upstream.headers.get("content-type") ?? "multipart/x-mixed-replace; boundary=frame",
                    "cache-control": "no-store",
                },
            })
        },
    },
    {
        method: "GET",
        path: "api/camera/snapshot",
        description: "What the robot's camera sees now, as a JPEG (needs the camera connected)",
        role: "view",
        handler: async () =>
            new Response(await firstFrame() as BodyInit, {
                headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
            }),
    },
    {
        method: "GET",
        path: "api/lidar/cloud",
        description: "The MID360 point cloud accumulated over the last ~4 s, robot frame (z up, already flipped for " +
            "the G1's upside-down mount): flat [x,y,z,…] in meters, plus the nearest obstacle range",
        handler: () => {
            const cloud = robot.lidarCloud()
            if (!cloud) {
                throw new HttpError(404, "no lidar data yet — PUT api/lidar { connected: true }")
            }
            return { points: cloud.points, nearest: cloud.nearest, ageMs: Date.now() - cloud.at, cloud: cloud.cloud }
        },
    },
    {
        method: "GET",
        path: "api/settings",
        description: "Drive settings: full-stick linear speed (m/s) and turn speed (rad/s) the panel's keys/pad use, " +
            "and the robot IP used to view its camera from a remote session",
        handler: () => robot.settings,
    },
    {
        method: "PUT",
        path: "api/settings",
        description: "Change drive settings (any subset); reset: true restores the defaults",
        params: {
            linearSpeed: { type: "number", description: `m/s, ${DRIVE_LIMITS.linearSpeed.join("-")}` },
            turnSpeed: { type: "number", description: `rad/s, ${DRIVE_LIMITS.turnSpeed.join("-")}` },
            robotIp: { type: "string", description: "the Jetson running G1 Ctrl, for a remote session's camera view" },
            reset: { type: "boolean", description: "restore the default speeds" },
        },
        handler: ({ linearSpeed, turnSpeed, robotIp, reset }) => {
            const next = { ...robot.settings }
            if (reset === true || reset === "true") {
                Object.assign(next, DRIVE_DEFAULTS)
            }
            for (const [key, value] of [["linearSpeed", linearSpeed], ["turnSpeed", turnSpeed]] as const) {
                if (value !== undefined) {
                    const n = number(value, key)
                    const [low, high] = DRIVE_LIMITS[key]
                    if (n < low || n > high) {
                        throw new HttpError(400, `${key} must be ${low}-${high}`)
                    }
                    next[key] = n
                }
            }
            if (robotIp !== undefined) {
                if (typeof robotIp !== "string" || !/^[\w.:-]+$/.test(robotIp)) {
                    throw new HttpError(400, "robotIp must be a host name or IP")
                }
                next.robotIp = robotIp
            }
            Object.assign(robot.settings, next)
            publishEvent({ type: "settings", settings: robot.settings })
            robot.publishState()
            return robot.settings
        },
    },
    {
        method: "GET",
        path: "api/log",
        description: "Recent helper log lines and errors (newest last)",
        params: { limit: { type: "number", description: "how many (default 50, max 200)" } },
        handler: ({ limit }) => {
            const n = number(limit, "limit", 50)
            if (n < 1 || n > 200) {
                throw new HttpError(400, "limit must be 1-200")
            }
            return { lines: robot.logLines(n) }
        },
    },
    {
        method: "PUT",
        path: "api/simulator",
        description: "Run against a built-in simulated G1 instead of the real helper (demos and testing with no " +
            "robot). Refused while a real helper is connected.",
        params: { enabled: { type: "boolean", required: true } },
        handler: ({ enabled }) => {
            if (bool(enabled, "enabled")) {
                try {
                    robot.startSimulator()
                } catch (error) {
                    throw new HttpError(409, (error as Error).message)
                }
            } else {
                robot.stopSimulator()
            }
            publishEvent({ type: "mode", mode: robot.currentMode() })
            return { simulator: robot.simulatorRunning() }
        },
    },
]
