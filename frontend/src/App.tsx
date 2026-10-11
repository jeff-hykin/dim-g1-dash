// G1 Ctrl: the camera fills the stage; telemetry, the pose and lidar views, the command dock and the drive pad float
// over it. Every action goes through the backend (api.ts → backend/routes.ts), which Desktop's agent can call too;
// what the robot is doing comes from api/state and the api/events/ws events. The UI is built from dimos-react.
//   keyboard: W/S forward·back  A/D turn  Q/E strafe  Shift boost  Space E-STOP  / action search
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
    AttitudeIndicator,
    Badge,
    Button,
    type ButtonVariant,
    CommandPalette,
    copyText,
    EmptyState,
    Field,
    IconButton,
    KeyValue,
    Modal,
    Panel,
    Slider,
    Spacer,
    StatusDot,
    Text,
    Toolbar,
    useToast,
} from "dimos-react"
import { PointCloud, RobotModel, Scene3D } from "dimos-react/three"
import { call, events } from "./api.ts"
import { type CameraStats, streamCamera } from "./camera.ts"
import { Skeleton } from "./skeleton.ts"
import type { CommandInfo, RobotState, Settings } from "./types.ts"

const BOOST = 1.6 // Shift
const VY_RATIO = 0.4 / 0.6 // strafe as a fraction of forward
const SEND_HZ = 15
const DRIVE_LIMITS = { linearSpeed: [0.1, 1.2], turnSpeed: [0.2, 2.5] }
const DRIVE_DEFAULTS = { linearSpeed: 0.6, turnSpeed: 1.5 }
const DRIVING_MODES = ["walk", "primitive_walk"]
const BATTERY_RESERVE = 5
const BATTERY_WARN = 30
const TEMP_WARM = 60
const TEMP_HOT = 75
const LOCO_STALE_MS = 4000
const LINK_DEAD_MS = 6000
const KEY_MAP: Record<string, Drive> = { KeyW: "fwd", KeyS: "back", KeyA: "tl", KeyD: "tr", KeyQ: "sl", KeyE: "sr" }
const DPAD: { dir: Drive; icon: string; help: string }[] = [
    { dir: "sl", icon: "arrow-left", help: "strafe left (Q)" },
    { dir: "fwd", icon: "arrow-up", help: "forward (W)" },
    { dir: "sr", icon: "arrow-right", help: "strafe right (E)" },
    { dir: "tl", icon: "rotate-left", help: "turn left (A)" },
    { dir: "back", icon: "arrow-down", help: "back (S)" },
    { dir: "tr", icon: "rotate-right", help: "turn right (D)" },
]
const TONE_VARIANT: Record<string, ButtonVariant> = { good: "ok", bad: "danger", warn: "warn" }
type Drive = "fwd" | "back" | "sl" | "sr" | "tl" | "tr"
type Velocity = { vx: number; vy: number; omega: number }
type Tone = "ok" | "warn" | "danger" | "info" | "default"

const deg = (rad: number) => rad * 180 / Math.PI
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const deviceTone = (up: boolean | null | undefined) => (up === true ? "ok" : up === false ? "danger" : "off")

export function App() {
    const toast = useToast()
    const [state, setState] = useState<RobotState | null>(null)
    const [commands, setCommands] = useState<CommandInfo[]>([])
    const [lastReach, setLastReach] = useState(0) // last time the backend answered
    const [now, setNow] = useState(Date.now())
    const [confirm, setConfirm] = useState<{ command: CommandInfo; run: () => void } | null>(null)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [lidarBig, setLidarBig] = useState(false)
    const [poseBig, setPoseBig] = useState(false)
    const [panelsOpen, setPanelsOpen] = useState(false)
    const [held, setHeld] = useState<Set<Drive>>(new Set())
    const [velocity, setVelocity] = useState<Velocity>({ vx: 0, vy: 0, omega: 0 })
    const [speeds, setSpeeds] = useState<Settings | null>(null)
    const [cameraLive, setCameraLive] = useState<"canvas" | "img" | null>(null)
    const [cameraStats, setCameraStats] = useState<CameraStats>({ fps: 0, lagMs: null })
    const [cameraMessage, setCameraMessage] = useState<string | null>(null)
    const [remoteCamUrl, setRemoteCamUrl] = useState<string | null>(null)
    const [sequenceText, setSequenceText] = useState<{ text: string; failed: boolean; at: number } | null>(null)
    const [lidarInfo, setLidarInfo] = useState<{ points: number; nearest: number | null } | null>(null)
    const [cloud, setCloud] = useState<Float32Array | null>(null)

    const keys = useRef({ fwd: false, back: false, sl: false, sr: false, tl: false, tr: false, boost: false })
    const sendTimer = useRef<number | null>(null)
    const driveHintAt = useRef(0)
    const moveErrorAt = useRef(0)
    const stateRef = useRef<RobotState | null>(null)
    const speedsRef = useRef<Settings | null>(null)
    const camCanvas = useRef<HTMLCanvasElement>(null)
    const throttled = useRef({ on: false, highSince: null as number | null })
    stateRef.current = state
    speedsRef.current = speeds

    const showToast = useCallback((text: string) => toast(text), [toast])

    const applyState = useCallback((next: RobotState) => {
        setState(next)
        setLastReach(Date.now())
        setSpeeds((current) => current ?? next.settings)
    }, [])

    const refreshCommands = useCallback(() => {
        call<{ commands: CommandInfo[] }>("GET", "api/commands").then((r) => setCommands(r.commands), () => {})
    }, [])

    // ── state: one GET now and every 2 s (the heartbeat that tells "no link" from "robot quiet"), events in between ──
    useEffect(() => {
        const poll = () => call<RobotState>("GET", "api/state").then(applyState, () => {})
        poll()
        refreshCommands()
        const timer = setInterval(() => {
            poll()
            setNow(Date.now())
        }, 2000)
        const stop = events((event) => {
            if (event.type === "state") {
                applyState(event.state)
            } else if (event.type === "mode") {
                refreshCommands()
            } else if (event.type === "notice") {
                showToast(event.message)
            } else if (event.type === "settings") {
                setSpeeds(event.settings)
            } else if (event.type === "lidar") {
                setCloud(Float32Array.from(event.cloud ?? []))
                setLidarInfo({ points: event.points, nearest: event.nearest })
            } else if (event.type === "seq") {
                const { name, step, state: phase } = event.sequence
                if (step === "sequence") {
                    showToast(phase === "done" ? `${name} — engaged` : `${name} — ${phase}`)
                } else if (phase !== "start") {
                    showToast(`${name}: ${step} ${phase}`)
                }
                setSequenceText({
                    text: step === "sequence"
                        ? (phase === "done" ? `${name} done` : phase)
                        : `${name}: ${step} ${phase}`,
                    failed: phase === "failed" || phase === "timeout",
                    at: Date.now(),
                })
            }
        })
        return () => {
            clearInterval(timer)
            stop()
        }
    }, [applyState, refreshCommands, showToast])

    // the link (re)connecting changes what can run
    const ready = state?.link.ready ?? false
    useEffect(refreshCommands, [ready, refreshCommands])

    // ── camera ──
    const cameraClaimed = state?.devices.cameraClaimed ?? false
    const cameraUp = state?.devices.camera === true
    const [cameraAttempt, setCameraAttempt] = useState(0)
    useEffect(() => {
        if (!cameraUp || remoteCamUrl) {
            return
        }
        setCameraMessage(null)
        const stop = streamCamera(camCanvas.current!, {
            onFirstFrame: () => setCameraLive("canvas"),
            onStats: (stats) => {
                setCameraStats(stats)
                // ask the robot to ease off when the viewer is behind, and to let go once it catches up
                const t = throttled.current
                if (stats.lagMs === null) {
                    return
                }
                if (stats.lagMs > 500) {
                    t.highSince ??= performance.now()
                    if (!t.on && performance.now() - t.highSince > 3000) {
                        t.on = true
                        call("PUT", "api/camera/stream", { maxFps: 10 }).catch(() => {})
                        showToast("Camera lagging — asked the robot for 10 fps")
                    }
                } else {
                    t.highSince = null
                    if (t.on && stats.lagMs < 200) {
                        t.on = false
                        call("PUT", "api/camera/stream", { maxFps: 0 }).catch(() => {})
                        showToast("Camera caught up — frame rate uncapped")
                    }
                }
            },
            onFail: () => {
                setCameraLive(null)
                setCameraMessage("Camera stream offline — retrying… (device busy or unplugged)")
                setTimeout(() => setCameraAttempt((n) => n + 1), 3000)
            },
        })
        return () => {
            stop()
            setCameraLive(null)
            setCameraStats({ fps: 0, lagMs: null })
        }
    }, [cameraUp, remoteCamUrl, cameraAttempt, showToast])

    // ── commands ──
    const runCommand = useCallback((command: CommandInfo) => {
        if (!stateRef.current?.link.ready) {
            return showToast("Helper not connected yet")
        }
        if (command.blocked) {
            return showToast(`${command.label} ${command.blocked}`)
        }
        const fire = () =>
            call("POST", "api/command", { command: command.id, confirm: true }).catch((error) =>
                showToast(message(error))
            )
        if (command.danger) {
            setConfirm({ command, run: fire })
        } else {
            fire()
        }
    }, [showToast])

    const estop = useCallback(() => {
        call("POST", "api/estop").catch((error) => showToast(message(error)))
    }, [showToast])

    const setClaim = useCallback((device: "camera" | "lidar", connected: boolean) => {
        if (device === "camera" && connected) {
            setRemoteCamUrl(null) // the local camera takes over from a robot stream
        }
        showToast(
            device === "camera"
                ? (connected ? "Connecting camera…" : "Camera released for other apps")
                : (connected ? "Connecting MID360…" : "MID360 released for other apps"),
        )
        call("PUT", `api/${device}`, { connected }).catch((error) => showToast(message(error)))
    }, [showToast])

    const takeoverCamera = useCallback(() => {
        showToast("Taking the camera over…")
        setCameraMessage("Stopping the robot's video service…")
        call("POST", "api/camera/takeover").catch((error) => showToast(message(error)))
    }, [showToast])

    // remote session: watch the MJPEG served by the G1 Ctrl running ON the robot (cross-origin, so an <img>)
    const useRobotStream = useCallback(() => {
        const ip = prompt(
            "Robot IP (the Jetson running G1 Ctrl):",
            stateRef.current?.settings.robotIp ?? "192.168.123.164",
        )
        if (!ip) {
            return
        }
        call("PUT", "api/settings", { robotIp: ip }).catch(() => {})
        const url = `http://${ip}:${stateRef.current?.devices.cameraPort ?? 8190}/stream`
        setRemoteCamUrl(url)
        setCameraMessage(`Connecting to ${url}…`)
    }, [])

    // ── driving: keys/pad → api/move at 15 Hz while held; releasing sends a stop ──
    const computeVelocity = useCallback((): Velocity => {
        const k = keys.current
        const speed = speedsRef.current ?? { ...DRIVE_DEFAULTS, robotIp: "" }
        const boost = k.boost ? BOOST : 1
        return {
            vx: ((k.fwd ? 1 : 0) - (k.back ? 1 : 0)) * speed.linearSpeed * boost,
            vy: ((k.sl ? 1 : 0) - (k.sr ? 1 : 0)) * speed.linearSpeed * VY_RATIO * boost,
            omega: ((k.tl ? 1 : 0) - (k.tr ? 1 : 0)) * speed.turnSpeed * boost,
        }
    }, [])
    const driving = () => {
        const k = keys.current
        return k.fwd || k.back || k.sl || k.sr || k.tl || k.tr
    }
    const sendMove = useCallback((v: Velocity) => {
        setVelocity(v)
        if (!stateRef.current?.link.ready) {
            return
        }
        call("POST", "api/move", v).catch((error) => {
            if (Date.now() - moveErrorAt.current > 5000) {
                moveErrorAt.current = Date.now()
                showToast(message(error))
            }
        })
    }, [showToast])
    const updateDrive = useCallback(() => {
        setHeld(new Set((Object.keys(KEY_MAP).map((code) => KEY_MAP[code])).filter((dir) => keys.current[dir])))
        if (driving()) {
            const mode = stateRef.current?.mode
            if (mode && !DRIVING_MODES.includes(mode) && Date.now() - driveHintAt.current > 5000) {
                driveHintAt.current = Date.now()
                showToast(`Driving needs mode: ${DRIVING_MODES.join(", ")} — robot is in ${mode}`)
            }
            if (sendTimer.current === null) {
                sendTimer.current = setInterval(() => sendMove(computeVelocity()), 1000 / SEND_HZ)
                sendMove(computeVelocity())
            }
        } else if (sendTimer.current !== null) {
            clearInterval(sendTimer.current)
            sendTimer.current = null
            sendMove({ vx: 0, vy: 0, omega: 0 })
        }
    }, [computeVelocity, sendMove, showToast])
    const releaseAll = useCallback(() => {
        for (const key of Object.keys(keys.current) as (keyof typeof keys.current)[]) {
            keys.current[key] = false
        }
        updateDrive()
    }, [updateDrive])

    // ── speed sliders: shown live while dragging, saved to the backend's settings ──
    const saveSpeed = useCallback((key: "linearSpeed" | "turnSpeed", value: number) => {
        setSpeeds((current) => current && { ...current, [key]: value })
        speedsRef.current = speedsRef.current && { ...speedsRef.current, [key]: value }
        if (driving()) {
            setVelocity(computeVelocity())
        }
        call("PUT", "api/settings", { [key]: value }).catch((error) => showToast(message(error)))
    }, [computeVelocity, showToast])

    // ── palette (/) ──
    const openPalette = useCallback(() => {
        releaseAll() // typing must not drive
        setPaletteOpen(true)
    }, [releaseAll])
    const paletteCommands = useMemo(() => {
        const actions: {
            id: string
            label: string
            group: string
            shortcut?: string
            icon?: string
            run: () => void
        }[] = commands.map((command) => ({
            id: `cmd-${command.id}`,
            label: command.mode ? `${command.label} → mode: ${command.mode}` : command.label,
            group: "Robot",
            shortcut: command.blocked ??
                (command.danger === "red"
                    ? "danger"
                    : command.advanced
                    ? "advanced"
                    : command.seq
                    ? "sequence"
                    : command.danger === "amber"
                    ? "balance"
                    : undefined),
            icon: command.danger ? "warn" : undefined,
            run: () => runCommand(command),
        }))
        actions.push({
            id: "camera",
            label: cameraClaimed ? "Release camera (free it for other apps)" : "Connect camera",
            group: "Devices",
            icon: "camera",
            run: () => setClaim("camera", !cameraClaimed),
        })
        const lidarClaimed = state?.devices.lidarClaimed ?? false
        actions.push({
            id: "lidar",
            label: lidarClaimed ? "Release MID360 (free it for other apps)" : "Connect MID360",
            group: "Devices",
            icon: "signal",
            run: () => setClaim("lidar", !lidarClaimed),
        })
        if (state?.link.remote) {
            actions.push({
                id: "robot-stream",
                label: "View robot's onboard camera stream",
                group: "Devices",
                run: useRobotStream,
            })
        }
        actions.push({
            id: "lidar-view",
            label: lidarBig ? "Shrink lidar view" : "Expand lidar view",
            group: "View",
            icon: lidarBig ? "shrink" : "expand",
            run: () => setLidarBig((big) => !big),
        })
        const simulating = state?.link.kind === "simulator"
        if (simulating || !state?.link.ready) {
            actions.push({
                id: "simulator",
                label: simulating ? "Stop the simulator" : "Use the simulator (no robot)",
                group: "Simulator",
                run: () => call("PUT", "api/simulator", { enabled: !simulating }).catch((e) => showToast(message(e))),
            })
        }
        actions.push({ id: "estop", label: "E-STOP", group: "Robot", shortcut: "Space", icon: "stop", run: estop })
        return actions
    }, [
        commands,
        cameraClaimed,
        state?.devices.lidarClaimed,
        state?.link.remote,
        lidarBig,
        runCommand,
        setClaim,
        useRobotStream,
        estop,
        state?.link.kind,
        state?.link.ready,
        showToast,
    ])

    // ── keyboard ──
    useEffect(() => {
        const down = (e: KeyboardEvent) => {
            if (paletteOpen) {
                return // typed W/A/Space in the search box must not drive or E-STOP the robot
            }
            if (e.code === "Space") {
                e.preventDefault()
                estop()
                return
            }
            if (confirm) {
                return // don't drive under a dialog
            }
            if (e.code === "Slash") {
                e.preventDefault()
                openPalette()
                return
            }
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
                keys.current.boost = true
                return
            }
            const dir = KEY_MAP[e.code]
            if (dir && !keys.current[dir]) {
                keys.current[dir] = true
                updateDrive()
            }
        }
        const up = (e: KeyboardEvent) => {
            if (e.code === "ShiftLeft" || e.code === "ShiftRight") {
                keys.current.boost = false
                return
            }
            const dir = KEY_MAP[e.code]
            if (dir) {
                keys.current[dir] = false
                updateDrive()
            }
        }
        // focus lost mid-drive: release everything (safety)
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", releaseAll)
        return () => {
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", releaseAll)
        }
    }, [paletteOpen, confirm, estop, openPalette, updateDrive, releaseAll])

    // ── derived display ──
    const linkDead = lastReach !== 0 && now - lastReach > LINK_DEAD_MS
    const loco = state?.loco
    const mode = state?.mode ?? null
    const raw = loco
        ? [
            `fsm ${loco.fsm}`,
            ...(typeof loco.balance === "number" ? [`bal ${loco.balance}`] : []),
            loco.motionMode ?? "?",
        ].join(" · ")
        : ""
    const lastLocoText = loco ? `mode: ${mode ?? (loco.fsm < 0 ? "unreachable" : "?")} · ${raw}` : "—"
    const showSequence = sequenceText && (loco?.sequenceRunning || Date.now() - sequenceText.at < 1500)
    const locoStale = loco && loco.ageMs > LOCO_STALE_MS
    let modeText = lastLocoText
    let modeTone: Tone = "default"
    let modeTitle = mode
        ? state?.modeBlurb ?? ""
        : loco
        ? `FSM ${loco.fsm} is not one this panel has a name for — the raw ids are what the robot reports`
        : "click to copy the full state"
    if (linkDead) {
        modeText = `no link ${Math.round((now - lastReach) / 1000)}s · ${lastLocoText}`
        modeTone = "warn"
        modeTitle =
            "The dashboard is not reaching the robot at all — this is the last value received, not the current state"
    } else if (locoStale) {
        modeText = `stale ${Math.round(loco!.ageMs / 1000)}s · ${lastLocoText}`
        modeTone = "warn"
        modeTitle =
            "The robot has stopped reporting its mode — the dashboard is still connected, so this is the helper or the loco service"
    } else if (showSequence) {
        modeText = sequenceText!.text
        modeTone = sequenceText!.failed ? "danger" : "info"
    } else if (mode && DRIVING_MODES.includes(mode)) {
        modeTone = "ok"
    } else if (mode === "collapse" || mode === "limp") {
        modeTone = "danger"
    }

    const helperReady = state?.link.ready ?? false
    const devices = state?.devices
    const drivable = !mode || DRIVING_MODES.includes(mode)
    const battery = state?.battery
    const hot = state?.hottestMotor
    const tempTone: Tone = hot ? (hot.celsius >= TEMP_HOT ? "danger" : hot.celsius >= TEMP_WARM ? "warn" : "ok") : "ok"
    const attitude = state?.attitude
    const lidarClaimed = devices?.lidarClaimed ?? false
    const live = cameraLive !== null
    const tuned = speeds &&
        (speeds.linearSpeed !== DRIVE_DEFAULTS.linearSpeed || speeds.turnSpeed !== DRIVE_DEFAULTS.turnSpeed)
    const poseAge = state?.telemetryAgeMs ?? null
    const poseText = !state?.jointPositions
        ? "no encoder data"
        : poseAge !== null && poseAge > 3000
        ? `stale ${Math.round(poseAge / 1000)}s`
        : `${state.jointPositions.length} joints`

    // the center placeholder: the off-robot / no-helper explainers out-rank every transient stream message
    let placeholder: { title?: string; message: React.ReactNode } | null = null
    let placeholderButton: { label: string; run: () => void; variant: ButtonVariant; title?: string } | null = null
    if (!live) {
        if (state?.link.onboard === false) {
            placeholder = {
                title: "This machine doesn't look like the G1",
                message: (
                    <>
                        <p>
                            There's no network interface on the robot LAN (<code>192.168.123.x</code>), so the robot,
                            camera and lidar can't be reached.
                        </p>
                        <p>
                            G1 Ctrl runs <b>onboard the robot</b>: install dimOS Desktop on the G1's Jetson (usually
                            {" "}
                            <code>ssh unitree@192.168.123.164</code>{" "}
                            from a machine plugged into the robot), then install{" "}
                            <code>https://github.com/jeff-hykin/dim-g1-dash</code>{" "}
                            there and open the panel served from the robot.
                        </p>
                        <p>
                            If your robot uses a different LAN plan, set <code>G1_LIDAR_IP</code> (and{" "}
                            <code>G1_NET_IFACE</code> for DDS) in Desktop's environment.
                        </p>
                    </>
                ),
            }
        } else if (state?.link.note && !helperReady) {
            placeholder = {
                title: "The onboard helper can't start",
                message: (
                    <>
                        <p>{state.link.note}</p>
                        <p>
                            No robot? Press <code>/</code> or call <code>PUT api/simulator</code>{" "}
                            to try the panel against a simulated G1.
                        </p>
                    </>
                ),
            }
            placeholderButton = {
                label: "Use the simulator",
                variant: "ok",
                run: () => call("PUT", "api/simulator", { enabled: true }).catch((e) => showToast(message(e))),
            }
        } else if (cameraMessage) {
            placeholder = { message: cameraMessage }
            if (remoteCamUrl) {
                placeholderButton = { label: "Retry robot stream", variant: "ok", run: useRobotStream }
            }
        } else if (state?.link.remote && helperReady && !cameraClaimed && !remoteCamUrl) {
            placeholder = {
                title: "Remote session",
                message: (
                    <>
                        <p>
                            This machine is on the robot's LAN but isn't the robot itself. Driving, telemetry and the
                            MID360 all work from here; the RealSense is attached to the robot.
                        </p>
                        <p>If the robot is also running G1 Ctrl, view its camera feed:</p>
                    </>
                ),
            }
            placeholderButton = { label: "View robot's camera stream", variant: "ok", run: useRobotStream }
        } else if (!helperReady) {
            placeholder = { message: "Waiting for the onboard helper…" }
        } else if (cameraClaimed) {
            placeholder = {
                message: devices?.camera === false
                    ? "Camera off — device busy (Unitree's videohub owns it?) or unplugged. Retrying…"
                    : "Connecting to camera stream…",
            }
            // a stock G1 boots Unitree's videohub holding the RealSense; the helper can only retry quietly
            placeholderButton = {
                label: "Force takeover camera",
                variant: "warn",
                run: takeoverCamera,
                title:
                    "Stops the robot's videohub service so the dash can open the RealSense. Anything else using that camera — the Unitree app included — loses video until you run `sudo systemctl start master_service` on the robot. The robot does not move.",
            }
        } else {
            placeholder = { message: "Camera not connected" }
            placeholderButton = { label: "Connect camera", variant: "ok", run: () => setClaim("camera", true) }
        }
    }

    const pressPad = (dir: Drive, down: boolean) => {
        keys.current[dir] = down
        updateDrive()
    }

    const linkLabel = !helperReady
        ? "Helper down"
        : state?.link.kind === "simulator"
        ? "Simulated"
        : state?.link.remote
        ? "Remote"
        : "Onboard"
    const batteryTone: Tone = battery
        ? (battery.percent <= BATTERY_RESERVE ? "danger" : battery.percent <= BATTERY_WARN ? "warn" : "ok")
        : "default"
    const dash = "—"

    return (
        <div className="stage">
            <div className={"cam-wrap" + (live ? " live via-" + cameraLive : "")}>
                <img
                    id="cam"
                    alt="G1 camera"
                    src={remoteCamUrl ? `${remoteCamUrl}?t=${cameraAttempt}` : undefined}
                    onLoad={() => remoteCamUrl && (setCameraLive("img"), setCameraMessage(null))}
                    onError={() => {
                        if (remoteCamUrl) {
                            setCameraLive(null)
                            setCameraMessage(
                                `Robot stream unreachable (${remoteCamUrl}) — is G1 Ctrl running on the robot? Press / to retry.`,
                            )
                        }
                    }}
                />
                <canvas id="cam-canvas" ref={camCanvas} />
                {placeholder && (
                    <EmptyState
                        layer
                        icon="camera"
                        className="cam-placeholder"
                        title={placeholder.title}
                        message={placeholder.message}
                        actions={placeholderButton && (
                            <Button
                                variant={placeholderButton.variant}
                                title={placeholderButton.title}
                                onClick={placeholderButton.run}
                            >
                                {placeholderButton.label}
                            </Button>
                        )}
                    />
                )}
            </div>

            <Toolbar floating className="topbar">
                <IconButton
                    icon="panels"
                    label="show/hide the telemetry panels"
                    className="panels-btn"
                    onClick={() => setPanelsOpen((open: boolean) => !open)}
                />
                {/* inside Desktop, its window bar already shows the app's icon and name */}
                {window.parent === window && <Text className="brand">G1 Ctrl</Text>}
                <Badge dot tone={helperReady ? "ok" : "danger"}>{state ? linkLabel : "Connecting…"}</Badge>
                <Text small>
                    <StatusDot tone={deviceTone(devices?.unitree)} /> SDK
                </Text>
                <Button
                    variant="ghost"
                    size="sm"
                    title={lidarClaimed
                        ? "MID360 claimed by the dash — click to release it for other apps"
                        : "MID360 released — click to connect"}
                    onClick={() => setClaim("lidar", !lidarClaimed)}
                >
                    <StatusDot tone={deviceTone(devices?.lidar)} />
                    MID360
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    title={cameraClaimed
                        ? "Camera claimed by the dash — click to release it for other apps"
                        : "Camera released — click to connect"}
                    onClick={() => setClaim("camera", !cameraClaimed)}
                >
                    <StatusDot tone={deviceTone(devices?.camera)} />
                    RS
                </Button>
                <Button
                    variant="ghost"
                    size="sm"
                    className="mode"
                    title={modeTitle}
                    onClick={async () => {
                        showToast(await copyText(modeText) ? "copied: " + modeText : "couldn't copy — " + modeText)
                    }}
                >
                    <Badge tone={modeTone}>
                        <Text mono>{modeText}</Text>
                    </Badge>
                </Button>
                {battery && (
                    <Badge dot tone={batteryTone} title="battery charge, and estimated time until 5% reserve">
                        <Text mono>{battery.percent}%{battery.remaining ? " - " + battery.remaining : ""}</Text>
                    </Badge>
                )}
                {hot && (
                    <Badge dot tone={tempTone} title="hottest motor — the hotter it runs, the sooner it derates">
                        <Text mono>{hot.celsius.toFixed(0)}°C{hot.name ? " " + hot.name : ""}</Text>
                    </Badge>
                )}
                <Spacer />
                <Button variant="danger" className="estop" title="Zero velocity + Damp (Space)" onClick={estop}>
                    E-STOP
                </Button>
            </Toolbar>

            <div className={"left-col" + (panelsOpen ? " open" : "")}>
                <Panel glass collapsible persistKey="g1.speed" title="Speed">
                    <Field
                        label="linear"
                        hint={tuned ? "tuned" : undefined}
                    >
                        <Slider
                            min={DRIVE_LIMITS.linearSpeed[0]}
                            max={DRIVE_LIMITS.linearSpeed[1]}
                            step={0.05}
                            value={speeds?.linearSpeed ?? DRIVE_DEFAULTS.linearSpeed}
                            format={(v: number) => speeds ? `${v.toFixed(2)} m/s` : dash}
                            onChange={(v: number) => saveSpeed("linearSpeed", v)}
                        />
                    </Field>
                    <Field label="turn">
                        <Slider
                            min={DRIVE_LIMITS.turnSpeed[0]}
                            max={DRIVE_LIMITS.turnSpeed[1]}
                            step={0.05}
                            value={speeds?.turnSpeed ?? DRIVE_DEFAULTS.turnSpeed}
                            format={(v: number) => speeds ? `${v.toFixed(2)} rad/s` : dash}
                            onChange={(v: number) => saveSpeed("turnSpeed", v)}
                        />
                    </Field>
                    <div className="row-between">
                        <Text muted small>Shift boosts ×1.6</Text>
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                                call("PUT", "api/settings", { reset: true }).then(
                                    (s) => setSpeeds(s as Settings),
                                    (e) => showToast(message(e)),
                                )}
                        >
                            reset
                        </Button>
                    </div>
                </Panel>

                <Panel glass collapsible persistKey="g1.robot" title="Robot">
                    <KeyValue
                        items={[
                            [
                                "controller",
                                loco
                                    ? (loco.fsm < 0 ? "unreachable" : mode ? `${mode} (${loco.fsm})` : loco.fsm)
                                    : dash,
                            ],
                            ["motion svc", loco?.motionMode ?? dash],
                            ["FSM machine", state?.fsmMachine ?? dash],
                        ]}
                    />
                </Panel>

                <Panel glass collapsible persistKey="g1.attitude" title="Attitude">
                    <AttitudeIndicator
                        roll={attitude?.roll ?? null}
                        pitch={attitude?.pitch ?? null}
                        yaw={attitude?.yaw ?? null}
                    />
                    <KeyValue
                        items={[
                            ["roll", attitude ? deg(attitude.roll).toFixed(1) + "°" : dash],
                            ["pitch", attitude ? deg(attitude.pitch).toFixed(1) + "°" : dash],
                        ]}
                    />
                </Panel>

                <Panel glass collapsible persistKey="g1.health" title="Health">
                    <KeyValue
                        items={[
                            [
                                "hottest joint",
                                <Text tone={tempTone === "danger" ? "danger" : undefined}>
                                    {hot ? `${hot.celsius.toFixed(0)}°C${hot.name ? ` (${hot.name})` : ""}` : dash}
                                </Text>,
                            ],
                            [
                                "nearest obst.",
                                <Text tone={lidarInfo?.nearest != null && lidarInfo.nearest < 0.6 ? "warn" : undefined}>
                                    {lidarInfo?.nearest != null ? lidarInfo.nearest.toFixed(2) + " m" : dash}
                                </Text>,
                            ],
                            ["lidar pts/s", lidarInfo?.points ? lidarInfo.points.toLocaleString() : dash],
                            ["camera fps", cameraStats.fps || dash],
                            [
                                "camera lag",
                                <Text
                                    tone={cameraStats.lagMs !== null && cameraStats.lagMs > 500 ? "danger" : undefined}
                                >
                                    {cameraStats.lagMs === null ? dash : `${Math.round(cameraStats.lagMs)} ms`}
                                </Text>,
                            ],
                        ]}
                    />
                </Panel>

                <Panel
                    glass
                    collapsible
                    persistKey="g1.pose"
                    title="Pose"
                    className={"view-panel" + (poseBig ? " big" : "")}
                    actions={
                        <>
                            <Text muted mono small>{poseText}</Text>
                            <IconButton
                                size="sm"
                                icon={poseBig ? "shrink" : "expand"}
                                label={poseBig ? "Shrink" : "Expand"}
                                pressed={poseBig}
                                onClick={() => setPoseBig((big: boolean) => !big)}
                            />
                        </>
                    }
                >
                    <Scene3D
                        fixedFrame="world"
                        className="view"
                        cameraPosition={[1.05, -1.05, 0.95]}
                        cameraTarget={[0, 0, 0.6]}
                    >
                        <Skeleton
                            positions={state?.jointPositions ?? null}
                            rpy={attitude ? [attitude.roll, attitude.pitch, attitude.yaw] : null}
                        />
                    </Scene3D>
                </Panel>

                <Panel
                    glass
                    collapsible
                    persistKey="g1.lidar"
                    title="MID360"
                    className={"view-panel" + (lidarBig ? " big" : "")}
                    actions={
                        <>
                            <Text muted mono small>
                                {lidarInfo ? `${(lidarInfo.points / 1000).toFixed(0)}k pts` : dash}
                            </Text>
                            <Button variant="ghost" size="sm" onClick={() => setClaim("lidar", !lidarClaimed)}>
                                {lidarClaimed ? "Release" : "Connect"}
                            </Button>
                            <IconButton
                                size="sm"
                                icon={lidarBig ? "shrink" : "expand"}
                                label={lidarBig ? "Shrink" : "Expand"}
                                pressed={lidarBig}
                                onClick={() => setLidarBig((big: boolean) => !big)}
                            />
                        </>
                    }
                >
                    <Scene3D
                        fixedFrame="world"
                        className="view"
                        cameraPosition={[-3.4, -3.4, 2.6]}
                        cameraTarget={[0, 0, 0.4]}
                    >
                        {cloud && (
                            <PointCloud
                                points={cloud}
                                frame=""
                                colorMode="height"
                                rangeMin={-0.5}
                                rangeMax={2}
                                size={0.035}
                                style="disc"
                            />
                        )}
                        <RobotModel kind="humanoid" pose={{ x: 0, y: 0, z: 0.8, yaw: 0 }} />
                    </Scene3D>
                </Panel>
            </div>

            <div className="drive">
                <KeyValue
                    className={"vel dr-glass" + (held.size ? " on" : "")}
                    items={[
                        ["vx", velocity.vx.toFixed(2)],
                        ["vy", velocity.vy.toFixed(2)],
                        ["ω", velocity.omega.toFixed(2)],
                    ]}
                />
                <div className="dpad">
                    {DPAD.map(({ dir, icon, help }) => (
                        <IconButton
                            key={dir}
                            icon={icon}
                            size="lg"
                            variant="default"
                            className={drivable ? undefined : "blocked"}
                            pressed={held.has(dir)}
                            label={drivable
                                ? help
                                : `driving needs mode: ${DRIVING_MODES.join(", ")} — robot is in ${mode}`}
                            style={{ touchAction: "none" }}
                            onPointerDown={(e: React.PointerEvent) => {
                                e.preventDefault()
                                pressPad(dir, true)
                            }}
                            onPointerUp={() => pressPad(dir, false)}
                            onPointerLeave={() => held.has(dir) && pressPad(dir, false)}
                            onPointerCancel={() => pressPad(dir, false)}
                            onContextMenu={(e: React.MouseEvent) => e.preventDefault()}
                        />
                    ))}
                </div>
            </div>

            {panelsOpen && <div className="scrim" onClick={() => setPanelsOpen(false)} />}
            <Toolbar floating className="dock">
                {commands.filter((command) => !command.advanced).map((command) => (
                    <Button
                        key={command.id}
                        variant={TONE_VARIANT[command.tone ?? ""] ?? "default"}
                        pressed={command.active || undefined}
                        disabled={!!command.blocked}
                        title={command.title}
                        onClick={() => runCommand(command)}
                    >
                        {command.label}
                    </Button>
                ))}
            </Toolbar>

            <CommandPalette
                open={paletteOpen}
                onClose={() => setPaletteOpen(false)}
                commands={paletteCommands}
                placeholder="Search actions… (drive: W/S A/D Q/E · Space E-STOP)"
            />

            <Modal
                open={!!confirm}
                onClose={() => setConfirm(null)}
                size="sm"
                title={confirm &&
                    (confirm.command.confirmTitle
                        ? `${confirm.command.label} — ${confirm.command.confirmTitle}`
                        : confirm.command.danger === "red"
                        ? `${confirm.command.label} — robot will drop`
                        : `${confirm.command.label} — robot will self-balance`)}
                footer={confirm && (
                    <>
                        {/* Cancel first: the modal focuses it, so a stray Enter backs out; Tab reaches confirm */}
                        <Button onClick={() => setConfirm(null)}>Cancel</Button>
                        <Button
                            variant={confirm.command.danger === "red" ? "danger" : "warn"}
                            onClick={() => {
                                const run = confirm.run
                                setConfirm(null)
                                run()
                            }}
                        >
                            {confirm.command.label} now
                        </Button>
                    </>
                )}
            >
                {/* the warnings are the app's own text (backend/g1.ts), with <b>/<br> for emphasis */}
                {confirm && <Text as="p" dangerouslySetInnerHTML={{ __html: confirm.command.warn ?? "" }} />}
            </Modal>
        </div>
    )
}
