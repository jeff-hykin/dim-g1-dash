// G1 Dash: the camera fills the stage; telemetry, the pose and lidar views, the command dock and the drive pad float
// over it. Every action goes through the backend (api.ts → backend/routes.ts), which Desktop's agent can call too;
// what the robot is doing comes from api/state and the api/events/ws events.
//   keyboard: W/S forward·back  A/D turn  Q/E strafe  Shift boost  Space E-STOP  / action search
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { call, events } from "./api.ts"
import { type CameraStats, streamCamera } from "./camera.ts"
import { Icon } from "./icons.tsx"
import { createLidarScene, createPoseScene } from "./scenes.ts"
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
type Drive = "fwd" | "back" | "sl" | "sr" | "tl" | "tr"
type Velocity = { vx: number; vy: number; omega: number }
type PaletteAction = { label: string; hint: string; danger?: string; blocked?: boolean; run: () => void }

const deg = (rad: number) => rad * 180 / Math.PI
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

function loadCollapsed(): Set<string> {
    try {
        return new Set(JSON.parse(localStorage.getItem("g1CollapsedCards") || "[]"))
    } catch {
        return new Set()
    }
}

// served over plain http, navigator.clipboard is often missing (secure-context only): the textarea path is the real one
async function copyText(text: string) {
    try {
        if (navigator.clipboard && isSecureContext) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // fall through
    }
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
        ok = document.execCommand("copy")
    } catch {
        ok = false
    }
    area.remove()
    return ok
}

function Card(
    { title, collapsed, onToggle, children }: {
        title: string
        collapsed: boolean
        onToggle: () => void
        children: React.ReactNode
    },
) {
    return (
        <div className={"dim-panel glass card" + (collapsed ? " collapsed" : "")}>
            <h3 className="dim-label" title="click to collapse / expand" onClick={onToggle}>
                <span className="chev">
                    <Icon name="chevron-down" size={10} />
                </span>
                {title}
            </h3>
            {children}
        </div>
    )
}

export function App() {
    const [state, setState] = useState<RobotState | null>(null)
    const [commands, setCommands] = useState<CommandInfo[]>([])
    const [lastReach, setLastReach] = useState(0) // last time the backend answered
    const [now, setNow] = useState(Date.now())
    const [toast, setToast] = useState<string | null>(null)
    const [confirm, setConfirm] = useState<{ command: CommandInfo; run: () => void } | null>(null)
    const [paletteOpen, setPaletteOpen] = useState(false)
    const [paletteQuery, setPaletteQuery] = useState("")
    const [paletteIndex, setPaletteIndex] = useState(0)
    const [collapsed, setCollapsed] = useState(loadCollapsed)
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
    const [copied, setCopied] = useState(false)
    const [lidarInfo, setLidarInfo] = useState<{ points: number; nearest: number | null } | null>(null)

    const toastTimer = useRef<number>(0)
    const keys = useRef({ fwd: false, back: false, sl: false, sr: false, tl: false, tr: false, boost: false })
    const sendTimer = useRef<number | null>(null)
    const driveHintAt = useRef(0)
    const moveErrorAt = useRef(0)
    const stateRef = useRef<RobotState | null>(null)
    const speedsRef = useRef<Settings | null>(null)
    const camCanvas = useRef<HTMLCanvasElement>(null)
    const poseCanvas = useRef<HTMLCanvasElement>(null)
    const lidarCanvas = useRef<HTMLCanvasElement>(null)
    const pose = useRef<ReturnType<typeof createPoseScene> | null>(null)
    const lidar = useRef<ReturnType<typeof createLidarScene> | null>(null)
    const topbar = useRef<HTMLDivElement>(null)
    const paletteInput = useRef<HTMLInputElement>(null)
    const cancelButton = useRef<HTMLButtonElement>(null)
    const throttled = useRef({ on: false, highSince: null as number | null })
    stateRef.current = state
    speedsRef.current = speeds

    const showToast = useCallback((text: string) => {
        setToast(text)
        clearTimeout(toastTimer.current)
        toastTimer.current = setTimeout(() => setToast(null), 2600)
    }, [])

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
                lidar.current?.update(event.cloud ?? [])
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

    // ── 3D views ──
    useEffect(() => {
        pose.current = createPoseScene(poseCanvas.current!)
        lidar.current = createLidarScene(lidarCanvas.current!)
        return () => {
            pose.current?.dispose()
            lidar.current?.dispose()
        }
    }, [])
    useEffect(() => {
        pose.current?.update(
            state?.jointPositions ?? null,
            state?.attitude ? [state.attitude.roll, state.attitude.pitch, state.attitude.yaw] : null,
        )
    }, [state?.jointPositions, state?.attitude])
    useEffect(() => {
        requestAnimationFrame(() => {
            pose.current?.resize()
            lidar.current?.resize()
        })
    }, [poseBig, lidarBig, collapsed])

    // the bar wraps on a phone, by how much depends on the mode text: measure it for the dock's offset
    useEffect(() => {
        const sync = () =>
            document.documentElement.style.setProperty(
                "--topbar-h",
                Math.ceil(topbar.current!.getBoundingClientRect().height) + "px",
            )
        const observer = new ResizeObserver(sync)
        observer.observe(topbar.current!)
        sync()
        return () => observer.disconnect()
    }, [])

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

    // remote session: watch the MJPEG served by the G1 Dash running ON the robot (cross-origin, so an <img>)
    const useRobotStream = useCallback(() => {
        const ip = prompt(
            "Robot IP (the Jetson running G1 Dash):",
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

    // ── palette ──
    const openPalette = useCallback(() => {
        setPaletteOpen(true)
        setPaletteQuery("")
        setPaletteIndex(0)
        releaseAll() // typing must not drive
        requestAnimationFrame(() => paletteInput.current?.focus())
    }, [releaseAll])
    const paletteActions = useMemo((): PaletteAction[] => {
        const actions: PaletteAction[] = commands.map((command) => ({
            label: command.mode ? `${command.label} → mode: ${command.mode}` : command.label,
            hint: command.blocked ??
                (command.danger === "red"
                    ? "danger"
                    : command.advanced
                    ? "advanced"
                    : command.seq
                    ? "sequence"
                    : command.danger === "amber"
                    ? "balance"
                    : ""),
            danger: command.danger,
            blocked: !!command.blocked,
            run: () => runCommand(command),
        }))
        actions.push({
            label: cameraClaimed ? "Release camera (free it for other apps)" : "Connect camera",
            hint: "device",
            run: () => setClaim("camera", !cameraClaimed),
        })
        const lidarClaimed = state?.devices.lidarClaimed ?? false
        actions.push({
            label: lidarClaimed ? "Release MID360 (free it for other apps)" : "Connect MID360",
            hint: "device",
            run: () => setClaim("lidar", !lidarClaimed),
        })
        if (state?.link.remote) {
            actions.push({ label: "View robot's onboard camera stream", hint: "remote", run: useRobotStream })
        }
        actions.push({
            label: lidarBig ? "Shrink lidar view" : "Expand lidar view",
            hint: "view",
            run: () => setLidarBig((big) => !big),
        })
        actions.push({ label: "E-STOP", hint: "danger", danger: "red", run: estop })
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
    ])
    const paletteMatches = useMemo(() => {
        const words = paletteQuery.trim().toLowerCase().split(/\s+/).filter(Boolean)
        return paletteActions.filter((action) => words.every((word) => action.label.toLowerCase().includes(word)))
    }, [paletteActions, paletteQuery])
    const selected = Math.max(0, Math.min(paletteIndex, paletteMatches.length - 1))
    const firePalette = (i: number) => {
        const action = paletteMatches[i]
        if (action) {
            setPaletteOpen(false)
            action.run()
        }
    }

    // ── keyboard ──
    useEffect(() => {
        // Escape in the CAPTURE phase: Desktop's shell also listens for it and can win the bubble-phase race
        const escape = (e: KeyboardEvent) => {
            if (e.code !== "Escape" || (!paletteOpen && !confirm)) {
                return
            }
            e.preventDefault()
            e.stopImmediatePropagation()
            if (paletteOpen) {
                setPaletteOpen(false)
            } else {
                setConfirm(null)
            }
        }
        const down = (e: KeyboardEvent) => {
            if (paletteOpen) {
                return
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
        addEventListener("keydown", escape, true)
        addEventListener("keydown", down)
        addEventListener("keyup", up)
        addEventListener("blur", releaseAll)
        return () => {
            removeEventListener("keydown", escape, true)
            removeEventListener("keydown", down)
            removeEventListener("keyup", up)
            removeEventListener("blur", releaseAll)
        }
    }, [paletteOpen, confirm, estop, openPalette, updateDrive, releaseAll])

    useEffect(() => {
        if (confirm) {
            cancelButton.current?.focus() // a stray Enter backs out; Tab reaches confirm
        }
    }, [confirm])

    const toggleCard = (title: string) => {
        setCollapsed((current) => {
            const next = new Set(current)
            if (!next.delete(title)) {
                next.add(title)
            }
            try {
                localStorage.setItem("g1CollapsedCards", JSON.stringify([...next]))
            } catch {
                // private mode
            }
            return next
        })
    }

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
    let modeClass = "dim-badge dim-mono mode"
    let modeTitle = mode
        ? state?.modeBlurb ?? ""
        : loco
        ? `FSM ${loco.fsm} is not one this panel has a name for — the raw ids are what the robot reports`
        : "click to copy the full state"
    if (linkDead) {
        modeText = `no link ${Math.round((now - lastReach) / 1000)}s · ${lastLocoText}`
        modeClass += " stale"
        modeTitle =
            "The dashboard is not reaching the robot at all — this is the last value received, not the current state"
    } else if (locoStale) {
        modeText = `stale ${Math.round(loco!.ageMs / 1000)}s · ${lastLocoText}`
        modeClass += " stale"
        modeTitle =
            "The robot has stopped reporting its mode — the dashboard is still connected, so this is the helper or the loco service"
    } else if (showSequence) {
        modeText = sequenceText!.text
        modeClass += sequenceText!.failed ? " damp" : ""
    } else {
        modeClass += (mode && DRIVING_MODES.includes(mode) ? " walking" : "") +
            (mode === "collapse" || mode === "limp" ? " damp" : "")
    }
    if (copied) {
        modeClass += " copied"
    }

    const helperReady = state?.link.ready ?? false
    const devices = state?.devices
    const drivable = !mode || DRIVING_MODES.includes(mode)
    const battery = state?.battery
    const hot = state?.hottestMotor
    const tempLevel = hot ? (hot.celsius >= TEMP_HOT ? "danger" : hot.celsius >= TEMP_WARM ? "warn" : "ok") : "ok"
    const attitude = state?.attitude
    const pitchPx = attitude ? Math.max(-40, Math.min(40, deg(attitude.pitch) * 1.4)) : 0
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
    let placeholder: React.ReactNode = null
    let placeholderButton: { label: string; run: () => void; variant: string; title?: string } | null = null
    if (!live) {
        if (state?.link.onboard === false) {
            placeholder = (
                <div className="note-block">
                    <p>
                        <b>This machine doesn't look like the G1.</b>{" "}
                        There's no network interface on the robot LAN (<code>192.168.123.x</code>), so the robot, camera
                        and lidar can't be reached.
                    </p>
                    <p>
                        G1 Dash runs <b>onboard the robot</b>: install dimOS Desktop on the G1's Jetson (usually{" "}
                        <code>ssh unitree@192.168.123.164</code> from a machine plugged into the robot), then install
                        {" "}
                        <code>https://github.com/jeff-hykin/dim-g1-dash</code>{" "}
                        there and open the panel served from the robot.
                    </p>
                    <p>
                        If your robot uses a different LAN plan, set <code>G1_LIDAR_IP</code> (and{" "}
                        <code>G1_NET_IFACE</code> for DDS) in Desktop's environment.
                    </p>
                </div>
            )
        } else if (state?.link.note && !helperReady) {
            placeholder = (
                <div className="note-block">
                    <p>
                        <b>The onboard helper can't start.</b>
                    </p>
                    <p>{state.link.note}</p>
                    <p>
                        No robot? Press <code>/</code> or call <code>PUT api/simulator</code>{" "}
                        to try the panel against a simulated G1.
                    </p>
                </div>
            )
            placeholderButton = {
                label: "Use the simulator",
                variant: "good",
                run: () => call("PUT", "api/simulator", { enabled: true }).catch((e) => showToast(message(e))),
            }
        } else if (cameraMessage) {
            placeholder = cameraMessage
            if (remoteCamUrl) {
                placeholderButton = { label: "Retry robot stream", variant: "good", run: useRobotStream }
            }
        } else if (state?.link.remote && helperReady && !cameraClaimed && !remoteCamUrl) {
            placeholder = (
                <div className="note-block">
                    <p>
                        <b>Remote session</b>{" "}
                        — this machine is on the robot's LAN but isn't the robot itself. Driving, telemetry and the
                        MID360 all work from here; the RealSense is attached to the robot.
                    </p>
                    <p>If the robot is also running G1 Dash, view its camera feed:</p>
                </div>
            )
            placeholderButton = { label: "View robot's camera stream", variant: "good", run: useRobotStream }
        } else if (!helperReady) {
            placeholder = "Waiting for the onboard helper…"
        } else if (cameraClaimed) {
            placeholder = devices?.camera === false
                ? "Camera off — device busy (Unitree's videohub owns it?) or unplugged. Retrying…"
                : "Connecting to camera stream…"
            // a stock G1 boots Unitree's videohub holding the RealSense; the helper can only retry quietly
            placeholderButton = {
                label: "Force takeover camera",
                variant: "warn",
                run: takeoverCamera,
                title:
                    "Stops the robot's videohub service so the dash can open the RealSense. Anything else using that camera — the Unitree app included — loses video until you run `sudo systemctl start master_service` on the robot. The robot does not move.",
            }
        } else {
            placeholder = "Camera not connected"
            placeholderButton = { label: "Connect camera", variant: "good", run: () => setClaim("camera", true) }
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
                                `Robot stream unreachable (${remoteCamUrl}) — is G1 Dash running on the robot? Press / to retry.`,
                            )
                        }
                    }}
                />
                <canvas id="cam-canvas" ref={camCanvas} />
                <div className="cam-ph">
                    <div className="glyph">
                        <Icon name="camera" size={46} />
                    </div>
                    <div>{placeholder}</div>
                    {placeholderButton && (
                        <button
                            type="button"
                            className={`dim-btn act ${placeholderButton.variant} ph-connect`}
                            title={placeholderButton.title}
                            onClick={placeholderButton.run}
                        >
                            {placeholderButton.label}
                        </button>
                    )}
                </div>
            </div>
            <div className="vignette" />

            <div className="topbar" ref={topbar}>
                <button
                    type="button"
                    className="dim-btn icon ghost panels-btn"
                    title="show/hide the telemetry panels"
                    aria-label="panels"
                    onClick={() => setPanelsOpen((open) => !open)}
                >
                    <Icon name="menu" />
                </button>
                <div className="brand">
                    <svg
                        className="mark"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                    >
                        <path d="M12 3.6 V5.1" />
                        <circle cx="12" cy="2.9" r="0.55" fill="currentColor" stroke="none" />
                        <rect x="6.8" y="5.1" width="10.4" height="8.2" rx="2.9" />
                        <path d="M9.9 8.5 v1.4" />
                        <path d="M14.1 8.5 v1.4" />
                        <path d="M4.6 21 c0.6-3.4 3.6-5.2 7.4-5.2 s6.8 1.8 7.4 5.2" />
                    </svg>
                    <span className="name">G1</span>
                </div>
                <div className={"dim-badge pill " + (helperReady ? "ok" : "danger")}>
                    <span className="dot" />
                    <span>{state ? linkLabel : "Connecting…"}</span>
                </div>
                <div className="dim-badge subs">
                    <span
                        className={"s" +
                            (devices?.unitree === true ? " up" : devices?.unitree === false ? " down" : "")}
                    >
                        <span className="dot" />SDK
                    </span>
                    <span
                        className={"s click" +
                            (devices?.lidar === true ? " up" : devices?.lidar === false ? " down" : "")}
                        title={lidarClaimed
                            ? "MID360 claimed by the dash — click to release it for other apps"
                            : "MID360 released — click to connect"}
                        onClick={() => setClaim("lidar", !lidarClaimed)}
                    >
                        <span className="dot" />MID360
                    </span>
                    <span
                        className={"s click" +
                            (devices?.camera === true ? " up" : devices?.camera === false ? " down" : "")}
                        title={cameraClaimed
                            ? "Camera claimed by the dash — click to release it for other apps"
                            : "Camera released — click to connect"}
                        onClick={() => setClaim("camera", !cameraClaimed)}
                    >
                        <span className="dot" />RS
                    </span>
                </div>
                <div
                    className={modeClass}
                    title={modeTitle}
                    onClick={async () => {
                        if (await copyText(modeText)) {
                            setCopied(true)
                            setTimeout(() => setCopied(false), 700)
                            showToast("copied: " + modeText)
                        } else {
                            showToast("couldn't copy — " + modeText)
                        }
                    }}
                >
                    {modeText}
                </div>
                {battery && (
                    <div
                        className={"dim-badge dim-mono pill " + (battery.percent <= BATTERY_RESERVE
                            ? "danger"
                            : battery.percent <= BATTERY_WARN
                            ? "warn"
                            : "ok")}
                        title="battery charge, and estimated time until 5% reserve"
                    >
                        <span className="dot" />
                        <span>{battery.percent}%{battery.remaining ? " - " + battery.remaining : ""}</span>
                    </div>
                )}
                {hot && (
                    <div
                        className={"dim-badge dim-mono pill " + tempLevel}
                        title="hottest motor — the hotter it runs, the sooner it derates"
                    >
                        <span className="dot" />
                        <span>{hot.celsius.toFixed(0)}°C{hot.name ? " " + hot.name : ""}</span>
                    </div>
                )}
                <div className="spacer" />
                <button
                    type="button"
                    className="dim-btn danger estop"
                    title="Zero velocity + Damp (Space)"
                    onClick={estop}
                >
                    E-STOP
                </button>
            </div>

            <div className={"left-col" + (panelsOpen ? " open" : "")}>
                <div className="rail">
                    <Card title="Speed" collapsed={collapsed.has("Speed")} onToggle={() => toggleCard("Speed")}>
                        <div className={"speed" + (tuned ? " tuned" : "")}>
                            <label htmlFor="sp-vx">
                                linear{" "}
                                <span className="v">{speeds ? `${speeds.linearSpeed.toFixed(2)} m/s` : "—"}</span>
                            </label>
                            <input
                                className="dim-range"
                                type="range"
                                id="sp-vx"
                                min={DRIVE_LIMITS.linearSpeed[0]}
                                max={DRIVE_LIMITS.linearSpeed[1]}
                                step="0.05"
                                value={speeds?.linearSpeed ?? DRIVE_DEFAULTS.linearSpeed}
                                onChange={(e) => saveSpeed("linearSpeed", parseFloat(e.target.value))}
                            />
                            <label htmlFor="sp-omega">
                                turn <span className="v">{speeds ? `${speeds.turnSpeed.toFixed(2)} rad/s` : "—"}</span>
                            </label>
                            <input
                                className="dim-range"
                                type="range"
                                id="sp-omega"
                                min={DRIVE_LIMITS.turnSpeed[0]}
                                max={DRIVE_LIMITS.turnSpeed[1]}
                                step="0.05"
                                value={speeds?.turnSpeed ?? DRIVE_DEFAULTS.turnSpeed}
                                onChange={(e) => saveSpeed("turnSpeed", parseFloat(e.target.value))}
                            />
                            <div className="speed-foot">
                                <span>Shift boosts &times;1.6</span>
                                <button
                                    type="button"
                                    onClick={() =>
                                        call("PUT", "api/settings", { reset: true }).then(
                                            (s) => setSpeeds(s as Settings),
                                            (e) => showToast(message(e)),
                                        )}
                                >
                                    reset
                                </button>
                            </div>
                        </div>
                    </Card>

                    <Card title="Robot" collapsed={collapsed.has("Robot")} onToggle={() => toggleCard("Robot")}>
                        <div className="kv">
                            <span className="k">controller</span>
                            <span className="v">
                                {loco
                                    ? (loco.fsm < 0 ? "unreachable" : mode ? `${mode} (${loco.fsm})` : loco.fsm)
                                    : "—"}
                            </span>
                            <span className="k">motion svc</span>
                            <span className="v">{loco?.motionMode ?? "—"}</span>
                            <span className="k">FSM machine</span>
                            <span className="v">{state?.fsmMachine ?? "—"}</span>
                        </div>
                    </Card>

                    <Card
                        title="Attitude"
                        collapsed={collapsed.has("Attitude")}
                        onToggle={() => toggleCard("Attitude")}
                    >
                        <div className="horizon">
                            <div
                                className="sky"
                                style={attitude
                                    ? {
                                        transform: `rotate(${(-deg(attitude.roll)).toFixed(1)}deg) translateY(${
                                            pitchPx.toFixed(0)
                                        }px)`,
                                    }
                                    : undefined}
                            />
                            <div className="cross" />
                            <div className="yaw">yaw {attitude ? deg(attitude.yaw).toFixed(0) : "—"}°</div>
                        </div>
                        <div className="kv" style={{ marginTop: 9 }}>
                            <span className="k">roll</span>
                            <span className="v">{attitude ? deg(attitude.roll).toFixed(1) + "°" : "—"}</span>
                            <span className="k">pitch</span>
                            <span className="v">{attitude ? deg(attitude.pitch).toFixed(1) + "°" : "—"}</span>
                        </div>
                    </Card>

                    <Card title="Health" collapsed={collapsed.has("Health")} onToggle={() => toggleCard("Health")}>
                        <div className="kv">
                            <span className="k">hottest joint</span>
                            <span className={"v" + (tempLevel === "danger" ? " hot" : "")}>
                                {hot ? `${hot.celsius.toFixed(0)}°C${hot.name ? ` (${hot.name})` : ""}` : "—"}
                            </span>
                            <span className="k">nearest obst.</span>
                            <span
                                className={"v" + (lidarInfo?.nearest != null && lidarInfo.nearest < 0.6 ? " near" : "")}
                            >
                                {lidarInfo?.nearest != null ? lidarInfo.nearest.toFixed(2) + " m" : "—"}
                            </span>
                            <span className="k">lidar pts/s</span>
                            <span className="v">{lidarInfo?.points ? lidarInfo.points.toLocaleString() : "—"}</span>
                            <span className="k">camera fps</span>
                            <span className="v">{cameraStats.fps || "—"}</span>
                            <span className="k">camera lag</span>
                            <span
                                className={"v" + (cameraStats.lagMs !== null && cameraStats.lagMs > 500 ? " hot" : "")}
                            >
                                {cameraStats.lagMs === null ? "—" : `${Math.round(cameraStats.lagMs)} ms`}
                            </span>
                        </div>
                    </Card>
                </div>

                <div
                    className={"dim-panel glass card pose-card" + (poseBig ? " big" : "") +
                        (collapsed.has("POSE") ? " collapsed" : "")}
                >
                    <div className="pose-head">
                        <h3 className="dim-label" title="click to collapse / expand" onClick={() => toggleCard("POSE")}>
                            <span className="chev">
                                <Icon name="chevron-down" size={10} />
                            </span>POSE
                        </h3>
                        <span className="m">{poseText}</span>
                        <button
                            type="button"
                            className={"dim-btn icon ghost expand" + (poseBig ? " on" : "")}
                            title={poseBig ? "Shrink" : "Expand"}
                            aria-label="Expand"
                            onClick={() => setPoseBig((big) => !big)}
                        >
                            <Icon name={poseBig ? "shrink" : "expand"} />
                        </button>
                    </div>
                    <canvas ref={poseCanvas} />
                </div>

                <div
                    className={"dim-panel glass card lidar-card" + (lidarBig ? " big" : "") +
                        (collapsed.has("MID360") ? " collapsed" : "")}
                >
                    <div className="lidar-head">
                        <h3
                            className="dim-label"
                            title="click to collapse / expand"
                            onClick={() => toggleCard("MID360")}
                        >
                            <span className="chev">
                                <Icon name="chevron-down" size={10} />
                            </span>MID360
                        </h3>
                        <span className="m">{lidarInfo ? `${(lidarInfo.points / 1000).toFixed(0)}k pts` : "—"}</span>
                        <button
                            type="button"
                            className="dim-btn sm ghost expand"
                            id="lidar-conn"
                            onClick={() => setClaim("lidar", !lidarClaimed)}
                        >
                            {lidarClaimed ? "Release" : "Connect"}
                        </button>
                        <button
                            type="button"
                            className={"dim-btn icon ghost expand" + (lidarBig ? " on" : "")}
                            title={lidarBig ? "Shrink" : "Expand"}
                            aria-label="Expand"
                            onClick={() => setLidarBig((big) => !big)}
                        >
                            <Icon name={lidarBig ? "shrink" : "expand"} />
                        </button>
                    </div>
                    <canvas ref={lidarCanvas} />
                </div>
            </div>

            <div className={"dim-panel glass dim-mono vel" + (held.size ? " on" : "")}>
                <div className="row">
                    <span>vx</span>
                    <span>{velocity.vx.toFixed(2)}</span>
                </div>
                <div className="row">
                    <span>vy</span>
                    <span>{velocity.vy.toFixed(2)}</span>
                </div>
                <div className="row">
                    <span>ω</span>
                    <span>{velocity.omega.toFixed(2)}</span>
                </div>
            </div>

            <div className="dpad">
                {DPAD.map(({ dir, icon, help }) => (
                    <button
                        key={dir}
                        type="button"
                        className={`dim-btn icon db ${dir}` + (held.has(dir) ? " held" : "") +
                            (drivable ? "" : " blocked")}
                        title={drivable
                            ? help
                            : `driving needs mode: ${DRIVING_MODES.join(", ")} — robot is in ${mode}`}
                        onPointerDown={(e) => {
                            e.preventDefault()
                            pressPad(dir, true)
                        }}
                        onPointerUp={() => pressPad(dir, false)}
                        onPointerLeave={() => held.has(dir) && pressPad(dir, false)}
                        onPointerCancel={() => pressPad(dir, false)}
                    >
                        <Icon name={icon} />
                    </button>
                ))}
            </div>

            <div className={"scrim" + (panelsOpen ? " open" : "")} onClick={() => setPanelsOpen(false)} />
            <div className="dock">
                {commands.filter((command) => !command.advanced).map((command) => (
                    <button
                        key={command.id}
                        type="button"
                        className={"dim-btn act " + (command.tone ?? "") + (command.active ? " on" : "")}
                        disabled={!!command.blocked}
                        title={command.title}
                        onClick={() => runCommand(command)}
                    >
                        {command.label}
                    </button>
                ))}
            </div>
            <div className="dim-toasts toast-stack">
                <div className={"dim-toast toast" + (toast ? " show" : "")}>{toast}</div>
            </div>

            <div
                className={"dim-panel glass palette" + (paletteOpen ? " show" : "")}
            >
                <input
                    ref={paletteInput}
                    type="text"
                    placeholder="Search actions… (↑↓ select · Enter run · Esc close)"
                    autoComplete="off"
                    spellCheck={false}
                    value={paletteQuery}
                    onChange={(e) => {
                        setPaletteQuery(e.target.value)
                        setPaletteIndex(0)
                    }}
                    onBlur={() => setTimeout(() => setPaletteOpen(false), 150)}
                    onKeyDown={(e) => {
                        e.stopPropagation() // typed W/A/Space must not drive or E-STOP the robot
                        e.nativeEvent.stopImmediatePropagation()
                        if (e.code === "ArrowDown") {
                            e.preventDefault()
                            setPaletteIndex(selected + 1)
                        } else if (e.code === "ArrowUp") {
                            e.preventDefault()
                            setPaletteIndex(Math.max(0, selected - 1))
                        } else if (e.code === "Enter") {
                            e.preventDefault()
                            firePalette(selected)
                        }
                    }}
                />
                <div className="palette-list">
                    {paletteMatches.length === 0 && <div className="palette-empty">No matching action</div>}
                    {paletteMatches.map((action, i) => (
                        <div
                            key={action.label}
                            className={"palette-item" + (i === selected ? " sel" : "") +
                                (action.danger ? ` ${action.danger}-danger` : "") + (action.blocked ? " blocked" : "")}
                            ref={(element) => {
                                if (i === selected) {
                                    element?.scrollIntoView?.({ block: "nearest" })
                                }
                            }}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => firePalette(i)}
                        >
                            <span>{action.label}</span>
                            {action.hint && <span className="hint dim-label">{action.hint}</span>}
                        </div>
                    ))}
                </div>
                <div className="palette-foot">
                    drive: W/S fwd·back &nbsp;A/D turn &nbsp;Q/E strafe &nbsp;Shift boost &nbsp;·&nbsp; Space E-STOP
                </div>
            </div>

            <div
                className={"confirm" + (confirm ? " show " + confirm.command.danger : "")}
                onClick={(e) => e.target === e.currentTarget && setConfirm(null)}
            >
                {confirm && (
                    <div className="confirm-box">
                        <div className="glyph">
                            <Icon name="warn" size={44} />
                        </div>
                        <h2>
                            {confirm.command.confirmTitle
                                ? `${confirm.command.label} — ${confirm.command.confirmTitle}`
                                : confirm.command.danger === "red"
                                ? `${confirm.command.label} — robot will drop`
                                : `${confirm.command.label} — robot will self-balance`}
                        </h2>
                        {/* the warnings are the app's own text (backend/g1.ts), with <b>/<br> for emphasis */}
                        <p dangerouslySetInnerHTML={{ __html: confirm.command.warn ?? "" }} />
                        <div className="confirm-actions">
                            <button
                                type="button"
                                className="dim-btn"
                                ref={cancelButton}
                                onClick={() => setConfirm(null)}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="dim-btn danger"
                                id="confirm-go"
                                onClick={() => {
                                    const run = confirm.run
                                    setConfirm(null)
                                    run()
                                }}
                            >
                                {confirm.command.label} now
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
