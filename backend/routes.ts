// Every G1 Ctrl action, as an endpoint (http.ts). The panel calls only these, and so can Desktop's agent. Anything
// that moves or reconfigures the robot takes `dryRun: true`, which validates and answers with what would be sent
// without sending it.
import { HttpError, type Info, publishEvent, type Route } from "./http.ts"
import {
    blockedReason,
    COMMANDS,
    describeCommand,
    DRIVE_DEFAULTS,
    DRIVE_LIMITS,
    MOVE_LIMITS,
    resolveCommand,
} from "./g1.ts"
import { logLine } from "./applog.ts"
import { platform } from "./platform.ts"
import { listRecordings, record, recordingStatus, recordLog, startRecording, stopRecording } from "./recording.ts"
import * as robot from "./robot.ts"

export const INFO: Info = {
    title: "G1 Ctrl",
    version: "1.0.0",
    description:
        "G1 Ctrl: drive and monitor a Unitree G1 humanoid from its onboard Jetson — modes, postures, gestures, " +
        "driving, E-STOP, the RealSense camera, the MID360 lidar and telemetry",
}

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

/** A short string argument (ids, labels, notes): trimmed and capped. */
function text(value: unknown, max = 200): string {
    return typeof value === "string" ? value.trim().slice(0, max) : ""
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
        when: "you want the robot's mode, battery, motor heat or link status",
        description: "The robot right now: link, devices (claimed/connected), mode, loco FSM, battery, attitude, " +
            "hottest motor, overheat warning, joint positions, lidar summary, drive settings",
        role: "context",
        handler: () => robot.snapshot(),
    },
    {
        method: "GET",
        path: "api/platform",
        when: "you need to know whether this app runs on the G1's own Jetson",
        description: "Whether this machine is the G1's onboard Jetson (jetson), plus its os, arch and device-tree " +
            "model, and overridden (G1_ONBOARD=1/0 forced jetson). G1 Ctrl only reaches the robot from the Jetson; " +
            "elsewhere the panel shows a setup guide instead.",
        handler: () => platform(),
    },
    {
        method: "GET",
        path: "api/commands",
        when: "you want the commands the robot can run now, and which are blocked",
        description: "Every mode/posture/gesture command for api/command, worded for the current mode: what mode it " +
            "puts the robot in, whether it's dangerous (needs confirm), and why it's blocked right now (if it is). " +
            "Returns {mode, commands: [{id, label, mode, danger, blocked, title, active, ...}]}",
        handler: () => ({ mode: robot.currentMode(), commands: commandsNow() }),
    },
    {
        method: "POST",
        path: "api/command",
        when: "you need the robot to change mode, posture or do a gesture",
        description: "Run a robot command by id (see api/commands): stiffen, walk, collapse, wave, shake, squat, " +
            "standup, sit, zerotorque, stand, primitive-walk-slow, primitive-walk-fast, wave-turn, release-arms, " +
            "high-stand, low-stand. MOVES THE ROBOT. Dangerous ones (danger red/amber) need confirm: true. Returns " +
            "{ok, sent, command, label, mode (the mode it leads to)}; 409 if blocked in the current mode or " +
            "dangerous without confirm; 503 if the robot's helper isn't connected.",
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
        when: "you need to drive the robot: walk forward, sideways or turn",
        description: "Drive: body velocity (vx forward m/s, vy left m/s, omega counter-clockwise rad/s). MOVES THE " +
            "ROBOT. The robot stops on its own ~0.4 s after the last move, so either repeat it (the panel sends 15/s) " +
            "or pass durationMs (≤ 5000) and the backend holds it that long, then stops. Needs mode walk or primitive_walk " +
            "(else it is sent with a warning). Returns {ok, sent, durationMs, warning?}; 409 while the overheat " +
            "warning is up (POST api/overheat/ack).",
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
            const moving = Math.abs(velocity.vx) + Math.abs(velocity.vy) + Math.abs(velocity.omega) > 1e-6
            if (moving && state.overheat) {
                throw new HttpError(
                    409,
                    `Robot overheating (${state.overheat.joint ?? "a motor"} at ${state.overheat.celsius}°C): ` +
                        "acknowledge the warning first (POST api/overheat/ack)",
                )
            }
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
        when: "the robot must stop right now, whatever it is doing",
        description: "E-STOP: abort any sequence, zero velocity and damp immediately (the robot goes limp). Always " +
            "allowed. Returns {ok, sent}.",
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
        when: "you need lidar data, or must free the lidar for another program",
        description: "Claim (connected: true) or release the MID360 lidar. It's exclusive: while claimed, other " +
            "programs (e.g. a SLAM stack) can't use it. Returns {ok, sent}.",
        params: {
            connected: { type: "boolean", required: true, description: "true claims the lidar, false releases it" },
            dryRun: dryRunParam,
        },
        handler: ({ connected, dryRun }) => deliver({ type: "config", lidar: bool(connected, "connected") }, dryRun),
    },
    {
        method: "PUT",
        path: "api/camera",
        when: "you need the camera turned on (or off) before viewing it",
        description: "Claim (connected: true) or release the RealSense color camera. Exclusive: on a stock G1 " +
            "Unitree's videohub holds it — see api/camera/takeover. Returns {ok, sent}.",
        params: {
            connected: { type: "boolean", required: true, description: "true claims the camera, false releases it" },
            dryRun: dryRunParam,
        },
        handler: ({ connected, dryRun }) => deliver({ type: "config", camera: bool(connected, "connected") }, dryRun),
    },
    {
        method: "POST",
        path: "api/camera/takeover",
        when: "turning the camera on fails because Unitree's videohub holds it",
        description: "Force the camera free: stop Unitree's master_service and its videohub_pc4 (which hold the " +
            "RealSense from boot), then claim it. The robot doesn't move, but its own video app loses the camera " +
            "until `sudo systemctl start master_service`. Needs the sudoers rules in the README. Returns {stopped, " +
            "message}; 403 if it couldn't stop them.",
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
        when: "the camera feed is too slow, laggy or low quality",
        description: "Tune the camera stream: maxFps caps the frame rate (0 = uncapped), quality pins JPEG quality " +
            "(0 = adapt to the link). Give either or both. Returns {ok, sent}.",
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
        when: "a page needs the continuous live camera video",
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
        when: "you want to see what the robot's camera sees",
        description:
            "What the robot's camera sees now, as one JPEG image; 503 if the camera isn't connected (PUT api/camera)",
        role: "view",
        handler: async () =>
            new Response(await firstFrame() as BodyInit, {
                headers: { "content-type": "image/jpeg", "cache-control": "no-store" },
            }),
    },
    {
        method: "GET",
        path: "api/lidar/cloud",
        when: "you want the lidar point cloud or the nearest obstacle's distance",
        description: "The MID360 point cloud accumulated over the last ~4 s, robot frame (z up, already flipped for " +
            "the G1's upside-down mount). Returns {points (count), nearest (m to the nearest obstacle, or null), " +
            "ageMs, cloud (flat [x,y,z,…] in meters)}; 404 before any lidar data (PUT api/lidar first)",
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
        when: "you want the drive speeds or robot IP the panel uses",
        description: "Drive settings: full-stick linear speed (m/s) and turn speed (rad/s) the panel's keys/pad use, " +
            "and the robot IP used to view its camera from a remote session: {linearSpeed, turnSpeed, robotIp}",
        handler: () => robot.settings,
    },
    {
        method: "PUT",
        path: "api/settings",
        when: "you need to change the panel's drive speeds or the robot IP",
        description:
            "Change drive settings (any subset); reset: true restores the default speeds first. Every open page " +
            "updates. Returns the new settings {linearSpeed, turnSpeed, robotIp}; 400 if a value is out of range",
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
        when: "something failed and you want the helper's recent log",
        description: "Recent helper log lines and errors, newest last: {lines: [{at (ISO time), level, message}]}",
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
        when: "you want to demo or test without a real robot",
        description: "Run against a built-in simulated G1 instead of the real helper (demos and testing with no " +
            "robot). Refused (409) while a real helper is connected. Returns {simulator (whether it's running)}.",
        params: {
            enabled: { type: "boolean", required: true, description: "true starts the simulated G1, false stops it" },
        },
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
    {
        method: "POST",
        path: "api/squat",
        when: "the robot should crouch down safely, e.g. a motor is overheating",
        description: "A CONTROLLED squat down (LocoClient FSM 706: the robot crouches onto its own legs under its " +
            "controller) — the overheat warning's default action. MOVES THE ROBOT. Zeroes the velocity first. Refused " +
            "unless the robot is up on its legs (walk, primitive_walk, stand, stiffen) with the 'ai' motion service " +
            "resident and no sequence running, so it never damps or stands a squatting robot up. Returns {ok, sent}; " +
            "409 with the reason when refused.",
        params: {
            why: { type: "string", description: "what asked for it, for the log (e.g. overheat, gamepad)" },
            dryRun: dryRunParam,
        },
        handler: ({ why, dryRun }) => {
            try {
                return robot.squatDown(dryRun === true || dryRun === "true", text(why, 40) || "api")
            } catch (error) {
                throw new HttpError(409, (error as Error).message)
            }
        },
    },
    {
        method: "POST",
        path: "api/overheat/ack",
        when: "the overheat warning is up and you've dealt with it",
        description:
            "Acknowledge the overheat warning (a motor at 75°C or more): silences it and lets driving resume; " +
            "it comes back 5°C hotter, or at 75°C again once the motors cool to 70°C. Returns {acknowledged, " +
            "warning, afterMs}, or {acknowledged: false, note} when no warning is up",
        params: { how: { type: "string", description: "how it was answered, for the log (e.g. dismissed, squat)" } },
        handler: ({ how }) => robot.acknowledgeOverheat(text(how, 40) || "acknowledged"),
    },
    {
        method: "POST",
        path: "api/overheat/simulate",
        when: "you want to try the overheat warning in the simulator",
        description: "Simulator only: make the simulated G1's hottest motor read celsius (default 76), to try the " +
            "overheat warning and the motor-temperature badge; celsius: 0 puts it back to normal. Returns {ok, " +
            "celsius}; 409 when not running the simulator",
        params: { celsius: { type: "number", description: "°C (0: back to the simulated normal)" } },
        handler: ({ celsius }) => {
            const value = number(celsius, "celsius", 76)
            try {
                robot.simulateMotorTemp(value > 0 ? value : null)
            } catch (error) {
                throw new HttpError(409, (error as Error).message)
            }
            return { ok: true, celsius: value > 0 ? value : null }
        },
    },
    {
        method: "POST",
        path: "api/ui/press",
        when: "a page needs to log a button the user pressed",
        description: "For pages: a button the user pressed (its data-ui id): logged to g1-ctrl.log, published as a " +
            "ui_press event and written to the recording's /logs. Returns {ok}.",
        params: {
            id: { type: "string", required: true, description: "the button's id (data-ui), e.g. control.record" },
            label: { type: "string", description: "its visible text or title, when that says more" },
        },
        handler: ({ id, label }) => {
            const press = { id: text(id, 100), label: text(label, 100) }
            logLine(`ui press: ${press.id}${press.label ? ` (${press.label})` : ""}`)
            recordLog({ type: "ui_press", ...press })
            publishEvent({ type: "ui_press", ...press })
            return { ok: true }
        },
    },
    {
        method: "POST",
        path: "api/joy",
        when: "a page needs to record the raw gamepad state",
        description: "For pages: the raw gamepad (axes, then the triggers' travel; buttons 0/1) on every change — " +
            "recorded on /joystick while a recording runs, never driven from. Returns {ok}.",
        params: {
            axes: {
                type: "array",
                required: true,
                description: "numbers: the sticks' axes, then the triggers' travel (first 32 kept)",
            },
            buttons: { type: "array", required: true, description: "0 or 1 per button (first 32 kept)" },
        },
        handler: ({ axes, buttons }) => {
            if (!Array.isArray(axes) || !Array.isArray(buttons)) {
                throw new HttpError(400, "axes and buttons must be arrays")
            }
            record("/joystick", { axes: axes.slice(0, 32).map(Number), buttons: buttons.slice(0, 32).map(Number) })
            return { ok: true }
        },
    },
    {
        method: "POST",
        path: "api/camera/video_note",
        when: "a page needs to log why its camera view failed or recovered",
        description:
            "For pages: why the camera view didn't start or stopped (or that it recovered) — logged, published " +
            "as a video_note event and written to the recording's /logs. Returns {ok}.",
        params: { note: { type: "string", required: true, description: "what happened" } },
        handler: ({ note }) => {
            const said = text(note, 300)
            logLine(`video note: ${said}`)
            recordLog({ type: "video_note", note: said })
            publishEvent({ type: "video_note", note: said })
            return { ok: true }
        },
    },
    {
        method: "GET",
        path: "api/record",
        when: "you want to know whether a recording is running, and its size",
        description:
            "The recording in progress: {active: true, file, path, startedAt (ms), seconds, bytes, messages, " +
            "lidarSilentS (seconds the lidar has been silent, or null)}; or {active: false}",
        handler: () => recordingStatus(),
    },
    {
        method: "POST",
        path: "api/record/start",
        when: "you need to record the robot's data to an mcap file",
        description: "Record to an .mcap in Desktop's recordings folder (g1/<date>_<time>_g1_<host>.mcap): state " +
            "(IMU, joints, battery, hottest motor), loco FSM, lidar, camera, velocities sent, commands, gamepad, and " +
            "/logs (presses, notices, overheat, health, Wi-Fi). Only ever started by a request like this one; it runs " +
            "until api/record/stop or the app quits. Returns its status (as GET api/record); if one is already " +
            "running, that one's.",
        handler: () => {
            try {
                const status = startRecording()
                publishEvent({ type: "record", record: status })
                return status
            } catch (error) {
                throw new HttpError(500, `couldn't start a recording: ${(error as Error).message}`)
            }
        },
    },
    {
        method: "POST",
        path: "api/record/stop",
        when: "you need to stop the recording in progress",
        description:
            "Stop the recording and finish its file: {active: false, stopped: true, file, bytes}, or {active: false, " +
            "stopped: false} if none was running",
        handler: () => {
            const result = stopRecording()
            publishEvent({ type: "record", record: recordingStatus() })
            return result
        },
    },
    {
        method: "GET",
        path: "api/recordings",
        when: "you want the list of this app's recording files",
        description:
            "This app's recordings: {directory, recordings: [{file, bytes, modified (ISO time), recording (still " +
            "being written)}]}, newest first",
        handler: () => listRecordings(),
    },
]
