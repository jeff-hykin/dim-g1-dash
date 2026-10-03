// The link to the G1: runs the native helper (g1_helper_cpp — MID360 + RealSense + unitree_sdk2, newline-JSON over
// stdio), keeps the latest of everything it reports, and forwards commands down to it. The routes read and drive the
// robot only through this module. A built-in simulator can stand in for the helper (G1_SIMULATE=1 or
// api/simulator) so the panel and the agent can be exercised with no robot; it never runs while a real helper is up.
import { publishEvent } from "./http.ts"
import { DRIVE_DEFAULTS, DRIVING_MODES, type ModeKey, MODES, MOTOR_NAMES, resolveMode } from "./g1.ts"

// deno-lint-ignore no-explicit-any -- helper events are free-form JSON
type Json = Record<string, any>

const RESTART_MS = 3000
const LOG_KEPT = 200

/** Where commands go: the helper's stdin, the simulator, or (tests) a recorder. */
export type Transport = { kind: "helper" | "simulator" | "test"; send(message: Json): void; stop(): void }

let transport: Transport | null = null
let helperReady = false
let note: string | null = null
let status: Json = {}
let telemetry: Json | null = null
let telemetryAt = 0
let loco: Json | null = null
let locoAt = 0
let sequence: Json | null = null
let lidar: { points: number; nearest: number | null; cloud: number[]; at: number } | null = null
const log: { at: string; level: string; message: string }[] = []

export const settings = { ...DRIVE_DEFAULTS, robotIp: "192.168.123.164" }

export function currentMode(): ModeKey | null {
    return loco ? resolveMode(loco.fsm, loco.balance) : null
}

export function linkKind() {
    return transport?.kind ?? null
}

export function ready() {
    return helperReady && transport !== null
}

export function cameraPort(): number {
    return typeof status.camPort === "number" ? status.camPort : 8190
}

export function lidarCloud() {
    return lidar
}

export function logLines(limit: number) {
    return log.slice(-limit)
}

function remember(level: string, message: string) {
    log.push({ at: new Date().toISOString(), level, message })
    log.splice(0, log.length - LOG_KEPT)
}

// ── battery runtime: the BMS reports whole percents, so time each clean 1% step and take the median of the recent
// ones; the countdown targets a 5% reserve, not 0 ──
const BATTERY_RESERVE = 5
const STEP_SAMPLES = 8
const MIN_SAMPLES = 3
const STEP_MIN_MS = 5_000
const STEP_MAX_MS = 30 * 60_000
const socSteps: number[] = []
let lastSoc: number | null = null
let lastSocAt = 0

function trackBattery(soc: number) {
    const now = Date.now()
    if (lastSoc === null) {
        lastSoc = soc
        lastSocAt = now
    } else if (soc !== lastSoc) {
        const elapsed = now - lastSocAt
        const dropped = lastSoc - soc
        if (dropped === 1 && elapsed >= STEP_MIN_MS && elapsed <= STEP_MAX_MS) {
            socSteps.push(elapsed)
            socSteps.splice(0, socSteps.length - STEP_SAMPLES)
        } else if (dropped < 0) {
            socSteps.length = 0 // charging: the old rate means nothing
        }
        lastSoc = soc
        lastSocAt = now
    }
}

function batteryRemaining(soc: number): string | null {
    if (socSteps.length < MIN_SAMPLES) {
        return null
    }
    if (soc <= BATTERY_RESERVE) {
        return "reserve"
    }
    const median = [...socSteps].sort((a, b) => a - b)[Math.floor(socSteps.length / 2)]
    const minutes = Math.round((soc - BATTERY_RESERVE) * median / 60_000)
    return minutes < 1 ? "<1 min" : minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** Everything the panel shows, as one object (api/state, and the `state` event). */
export function snapshot() {
    const mode = currentMode()
    const soc = typeof telemetry?.soc === "number" && telemetry.soc >= 0 ? telemetry.soc : null
    const hottest = typeof telemetry?.hottestTemp === "number" && telemetry.hottestTemp >= 0 ? telemetry : null
    return {
        link: {
            kind: linkKind(),
            ready: ready(),
            note,
            onboard: typeof status.onboard === "boolean" ? status.onboard : null,
            remote: status.remote === true,
            iface: status.iface ?? null,
        },
        devices: {
            unitree: status.unitree ?? null,
            lidar: status.lidar ?? null,
            camera: status.camera ?? null,
            lidarClaimed: status.lidarWanted === true,
            cameraClaimed: status.camWanted === true,
            cameraPort: cameraPort(),
            cameraQuality: status.camQuality ?? null,
            cameraMaxFps: status.camMaxFps ?? null,
        },
        mode,
        modeBlurb: mode ? MODES[mode].blurb : null,
        drivable: !mode || DRIVING_MODES.includes(mode),
        loco: loco
            ? {
                fsm: loco.fsm,
                balance: loco.balance ?? null,
                motionMode: loco.motionMode ?? null,
                sequenceRunning: loco.seqRunning === true,
                ageMs: Date.now() - locoAt,
            }
            : null,
        sequence,
        battery: soc === null ? null : { percent: soc, remaining: batteryRemaining(soc) },
        attitude: Array.isArray(telemetry?.rpy)
            ? { roll: telemetry!.rpy[0], pitch: telemetry!.rpy[1], yaw: telemetry!.rpy[2] }
            : null,
        hottestMotor: hottest
            ? {
                celsius: hottest.hottestTemp,
                index: hottest.hottestJoint,
                name: MOTOR_NAMES[hottest.hottestJoint] ?? null,
            }
            : null,
        fsmMachine: telemetry?.fsmMachine ?? null,
        jointPositions: Array.isArray(telemetry?.q) ? telemetry!.q : null,
        telemetryAgeMs: telemetry ? Date.now() - telemetryAt : null,
        lidar: lidar ? { points: lidar.points, nearest: lidar.nearest, ageMs: Date.now() - lidar.at } : null,
        settings,
    }
}

// state goes out at most 10×/s, always with the latest values
let stateTimer: number | null = null
export function publishState() {
    if (stateTimer !== null) {
        return
    }
    stateTimer = setTimeout(() => {
        stateTimer = null
        publishEvent({ type: "state", state: snapshot() })
    }, 100)
}

/** Something to tell whoever is watching (the panel shows it as a toast). */
export function notify(message: string, level: "info" | "error" = "info") {
    remember(level, message)
    publishEvent({ type: "notice", level, message })
}

/** One line from the helper (or the simulator). */
export function onHelperEvent(event: Json) {
    switch (event.type) {
        case "ready":
            helperReady = true
            break
        case "status":
            status = { ...status, ...event }
            break
        case "state":
            telemetry = event
            telemetryAt = Date.now()
            if (typeof event.soc === "number" && event.soc >= 0) {
                trackBattery(event.soc)
            }
            break
        case "loco": {
            const before = currentMode()
            loco = event
            locoAt = Date.now()
            if (currentMode() !== before) {
                publishEvent({ type: "mode", mode: currentMode() })
            }
            break
        }
        case "seq":
            sequence = { name: event.seq, step: event.step, state: event.state, at: new Date().toISOString() }
            publishEvent({ type: "seq", sequence })
            break
        case "lidar":
            lidar = {
                points: event.points ?? 0,
                nearest: typeof event.nearest === "number" && event.nearest > 0 ? event.nearest : null,
                cloud: Array.isArray(event.cloud) ? event.cloud : [],
                at: Date.now(),
            }
            publishEvent({ type: "lidar", points: lidar.points, nearest: lidar.nearest, cloud: lidar.cloud })
            return
        case "log":
            remember(event.level ?? "info", String(event.msg ?? ""))
            return
        case "error":
            notify(String(event.msg ?? "helper error"), "error")
            return
    }
    publishState()
}

function reset() {
    helperReady = false
    status = {}
    telemetry = null
    loco = null
    sequence = null
    lidar = null
}

/** Sends `message` to the helper; throws when there is no link. */
export function send(message: Json) {
    if (!transport || !helperReady) {
        throw new Error(note ?? "the robot's helper isn't running")
    }
    transport.send(message)
}

// ── the real helper ──
async function exists(path: string) {
    try {
        return (await Deno.stat(path)).isFile
    } catch {
        return false
    }
}

async function helperBinary(): Promise<string | null> {
    const dir = Deno.env.get("G1_HELPER_DIR") ?? new URL("../g1_helper_cpp/bin", import.meta.url).pathname
    for (const path of [Deno.env.get("G1_HELPER"), `${dir}/g1_helper-${Deno.build.os}-${Deno.build.arch}`]) {
        if (path && await exists(path)) {
            return path
        }
    }
    return null
}

let wantHelper = false

async function startHelper() {
    if (!wantHelper || transport) {
        return
    }
    if (Deno.build.os !== "linux") {
        note = "G1 Dash's onboard helper only runs on Linux (the G1's Jetson). " +
            "This machine can show the panel, but install the app on the robot to drive it."
        publishState()
        return
    }
    const binary = await helperBinary()
    if (!binary) {
        note = `No g1_helper for ${Deno.build.os}-${Deno.build.arch}: install with \`nix build .#dimosApp\` ` +
            "(it ships the helper for aarch64 and x86_64 Linux) or set G1_HELPER."
        publishState()
        setTimeout(startHelper, RESTART_MS)
        return
    }
    let child: Deno.ChildProcess
    try {
        child = new Deno.Command(binary, { stdin: "piped", stdout: "piped", stderr: "inherit" }).spawn()
    } catch (error) {
        note = `could not start the helper: ${(error as Error).message}`
        publishState()
        setTimeout(startHelper, RESTART_MS)
        return
    }
    note = null
    const writer = child.stdin.getWriter()
    const encoder = new TextEncoder()
    const self: Transport = {
        kind: "helper",
        send: (message) => void writer.write(encoder.encode(JSON.stringify(message) + "\n")).catch(() => {}),
        stop: () => child.kill(),
    }
    transport = self
    ;(async () => {
        let buffer = ""
        for await (const chunk of child.stdout.pipeThrough(new TextDecoderStream())) {
            buffer += chunk
            const lines = buffer.split("\n")
            buffer = lines.pop()!
            for (const line of lines) {
                try {
                    onHelperEvent(JSON.parse(line))
                } catch {
                    // not JSON
                }
            }
        }
    })()
    child.status.then(() => {
        if (transport === self) {
            transport = null
            reset()
            publishState()
            setTimeout(startHelper, RESTART_MS)
        }
    })
}

/** Connects to the robot: the helper, or the simulator when G1_SIMULATE=1. */
export function start() {
    if (Deno.env.get("G1_SIMULATE") === "1") {
        startSimulator()
        return
    }
    wantHelper = true
    startHelper()
}

/** Tests: route commands to `sink` and mark the link up (null: no link at all). */
export function useTestTransport(sink: ((message: Json) => void) | null) {
    wantHelper = false
    transport?.stop()
    reset()
    transport = sink ? { kind: "test", send: sink, stop: () => {} } : null
    helperReady = sink !== null
}

// ── camera takeover: on a stock G1 Unitree's videohub_pc4 holds the RealSense from boot and master_service respawns
// it within a second, so stop the supervisor, then the process, then re-ask for the camera. master_service on the
// Jetson supervises only the two videohubs and the OTA pipe — nothing here can move the robot. Needs, in
// /etc/sudoers.d/dim-g1-dash-camera:
//   unitree ALL=(root) NOPASSWD: /usr/bin/systemctl stop master_service
//   unitree ALL=(root) NOPASSWD: /usr/bin/systemctl start master_service
//   unitree ALL=(root) NOPASSWD: /usr/bin/pkill -x videohub_pc4
// (-x: the chest camera runs as videohub_pc4_chest, which a substring match would also kill) ──
const VIDEOHUB = "videohub_pc4"
const SUPERVISOR = "master_service"

async function run(command: string, args: string[]) {
    try {
        return (await new Deno.Command(command, { args, stdout: "null", stderr: "null" }).output()).code
    } catch {
        return null
    }
}

const videohubRunning = async () => (await run("pgrep", ["-x", VIDEOHUB])) === 0

export async function cameraTakeover(): Promise<{ stopped: boolean; message: string }> {
    await run("sudo", ["-n", "systemctl", "stop", SUPERVISOR])
    // pkill exits 0 when it matched even if the signal was refused, so ask whether the process actually died
    for (const [command, args] of [["pkill", ["-x", VIDEOHUB]], ["sudo", ["-n", "pkill", "-x", VIDEOHUB]]] as const) {
        if (!(await videohubRunning())) {
            break
        }
        await run(command, [...args])
        await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (await videohubRunning()) {
        const message = `${VIDEOHUB} is still running — it belongs to root. Add the sudoers rules from the README ` +
            "to /etc/sudoers.d/dim-g1-dash-camera on the robot."
        notify(`camera takeover: ${message}`, "error")
        return { stopped: false, message }
    }
    send({ type: "config", camera: true })
    const message = `stopped ${VIDEOHUB} (restore the robot's video with: sudo systemctl start ${SUPERVISOR})`
    notify(`camera takeover: ${message}`)
    return { stopped: true, message }
}

// ── timed moves: the helper stops the robot unless a move arrives every ~0.4 s, so a move with a duration is
// re-sent at 15 Hz until it ends, then zeroed. Any newer move or E-STOP cancels it. ──
let moveTimer: number | null = null

export function cancelTimedMove() {
    if (moveTimer !== null) {
        clearInterval(moveTimer)
        moveTimer = null
    }
}

export function move(velocity: { vx: number; vy: number; omega: number }, durationMs?: number) {
    cancelTimedMove()
    send({ type: "move", ...velocity })
    if (durationMs) {
        const end = Date.now() + durationMs
        moveTimer = setInterval(() => {
            try {
                if (Date.now() >= end) {
                    cancelTimedMove()
                    send({ type: "move", vx: 0, vy: 0, omega: 0 })
                } else {
                    send({ type: "move", ...velocity })
                }
            } catch {
                cancelTimedMove() // link gone: the helper has already stopped the robot
            }
        }, 1000 / 15)
    }
}

// ── simulator ──
const SIM_FSM: Record<string, [number, number]> = {
    ready: [4, 0],
    stand: [801, 1],
    lie2standup: [801, 1],
    damp: [1, 0],
    zerotorque: [0, 0],
    sit: [3, 0],
    balancestand: [801, 0],
}
let simTimers: number[] = []

export function simulatorRunning() {
    return transport?.kind === "simulator"
}

export function startSimulator() {
    if (transport?.kind === "helper" && helperReady) {
        throw new Error("a real helper is connected — refusing to simulate over a real robot")
    }
    wantHelper = false
    transport?.stop()
    reset()
    note = null
    let fsm = 1
    let balance = 0
    let lidarOn = false
    let soc = 87
    const emit = (event: Json) => queueMicrotask(() => transport?.kind === "simulator" && onHelperEvent(event))
    const sim: Transport = {
        kind: "simulator",
        send(message) {
            if (message.type === "cmd") {
                const name = String(message.name)
                if (message.name === "balance") {
                    ;[fsm, balance] = [200, message.gait === "run" ? 2 : 1]
                } else if (name === "squat") {
                    ;[fsm, balance] = [fsm === 706 ? 801 : 706, fsm === 706 ? 1 : 0]
                } else if (SIM_FSM[name]) {
                    ;[fsm, balance] = SIM_FSM[name]
                } else {
                    emit({ type: "log", msg: `simulated ${name}` })
                }
                emit({ type: "seq", seq: name, step: "sequence", state: "done" })
            } else if (message.type === "estop") {
                ;[fsm, balance] = [1, 0]
            } else if (message.type === "config") {
                if (typeof message.lidar === "boolean") {
                    lidarOn = message.lidar
                    emit({ type: "status", lidar: lidarOn, lidarWanted: lidarOn })
                }
                if (typeof message.camera === "boolean") {
                    emit({ type: "status", camera: false, camWanted: message.camera })
                }
            }
            if (message.type === "cmd" || message.type === "estop") {
                emit({ type: "loco", fsm, balance, motionMode: "ai", seqRunning: false })
            }
        },
        stop() {
            simTimers.forEach(clearInterval)
            simTimers = []
        },
    }
    transport = sim
    onHelperEvent({
        type: "status",
        onboard: true,
        remote: true,
        unitree: true,
        lidar: false,
        lidarWanted: false,
        camera: false,
        camWanted: false,
        camPort: 8190,
        iface: "simulated",
    })
    onHelperEvent({ type: "ready" })
    const started = Date.now()
    simTimers = [
        setInterval(() => onHelperEvent({ type: "loco", fsm, balance, motionMode: "ai", seqRunning: false }), 1000),
        setInterval(() => {
            const t = (Date.now() - started) / 1000
            if (Math.random() < 0.005) {
                soc = Math.max(0, soc - 1)
            }
            onHelperEvent({
                type: "state",
                soc,
                rpy: [0.02 * Math.sin(t), 0.03 * Math.sin(t / 1.7), 0.1 * t % (2 * Math.PI)],
                hottestJoint: 3,
                hottestTemp: 41 + 2 * Math.sin(t / 9),
                q: Array.from(
                    { length: 29 },
                    (_, i) => (fsm === 1 || fsm === 0 ? 0.4 : 0.15) * Math.sin(t + i) * (i % 3 === 0 ? 1 : 0.3),
                ),
                fsmMachine: fsm === 1 ? 0 : 5,
            })
        }, 200),
        setInterval(() => {
            if (!lidarOn) {
                return
            }
            // a 6 m × 4 m room around the robot
            const cloud: number[] = []
            for (let i = 0; i < 1500; i++) {
                const a = Math.random() * 2 * Math.PI
                const r = Math.min(3 / Math.abs(Math.cos(a)), 2 / Math.abs(Math.sin(a)))
                cloud.push(r * Math.cos(a), r * Math.sin(a), Math.random() * 2.2 - 0.6)
            }
            onHelperEvent({ type: "lidar", points: cloud.length / 3, nearest: 2, cloud })
        }, 500),
    ]
}

export function stopSimulator() {
    if (transport?.kind !== "simulator") {
        return
    }
    transport.stop()
    transport = null
    reset()
    wantHelper = true
    startHelper()
    publishState()
}
