// The operator's safety and bookkeeping pieces (go2-dash's, for the G1): the overheat warning and its alarm, the
// motor-temperature badge, the gamepad (gamepad.ts has its rules) and its chip, and the Record button.
import { useEffect, useRef, useState } from "react"
import { Badge, Button, Icon } from "dimos-react"
import { call } from "./api.ts"
import {
    activePad,
    type Axes,
    BUTTON,
    GAMEPAD_BINDINGS,
    GamepadDriver,
    type GamepadStatus,
    joySample,
    noPad,
    type PadLike,
} from "./gamepad.ts"
import { logPress } from "./presses.ts"
import type { Overheat, RecordState, RobotState } from "./types.ts"

/** the pad is read at 60 Hz */
export const PAD_POLL_MS = 16
const ZERO_AXES: Axes = { forward: 0, strafe: 0, turn: 0 }
const UP_ON_ITS_LEGS = ["walk", "primitive_walk", "stand", "stiffen"]

/** Why the controlled squat (backend/squat.ts) can't run now, or null; the backend checks again and has the last word. */
export function squatBlocked(state: RobotState | null): string | null {
    if (!state?.link.ready) {
        return "the helper isn't connected"
    }
    if (!state.mode || !UP_ON_ITS_LEGS.includes(state.mode)) {
        return `the robot isn't up on its legs (${state.mode ?? "unknown mode"})`
    }
    if (state.loco?.motionMode !== "ai") {
        return `motion service is "${state.loco?.motionMode ?? "unknown"}", not "ai" (switching it would damp)`
    }
    if (state.loco?.sequenceRunning) {
        return "a sequence is still running"
    }
    return null
}

// ── the alarm: the page sounds it (the backend runs on the robot, not by the operator); a browser lets a page make
// sound only after a press on it, so the audio is unlocked on the first one ──
let audio: AudioContext | null = null

export function unlockAudio() {
    const unlock = () => {
        try {
            audio ??= new AudioContext()
            void audio.resume()
        } catch {
            // no Web Audio: the warning still shows
        }
    }
    addEventListener("pointerdown", unlock, { capture: true })
    addEventListener("keydown", unlock, { capture: true })
}

function beep() {
    if (!audio) {
        return
    }
    const now = audio.currentTime
    for (const [at, hz] of [[0, 880], [0.25, 660], [0.5, 880], [0.75, 660]]) {
        const tone = audio.createOscillator()
        const gain = audio.createGain()
        tone.type = "square"
        tone.frequency.value = hz
        gain.gain.setValueAtTime(0.0001, now + at)
        gain.gain.exponentialRampToValueAtTime(0.25, now + at + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22)
        tone.connect(gain).connect(audio.destination)
        tone.start(now + at)
        tone.stop(now + at + 0.24)
    }
}

/** The overheat warning: over everything until acknowledged, with the alarm every 2 s. Its default action (the focused
 * button, or a fresh press of the pad's A) is the controlled squat; Dismiss only acknowledges. Driving is refused
 * meanwhile (the backend's api/move, and App's keys and pad). */
export function OverheatWarning({ warning, state, onToast }: {
    warning: Overheat
    state: RobotState | null
    onToast: (text: string) => void
}) {
    const [sending, setSending] = useState(false)
    const blocked = squatBlocked(state)
    const act = (squat: boolean) => {
        if (sending) {
            return
        }
        setSending(true)
        const first = squat ? call("POST", "api/squat", { why: "overheat" }) : Promise.resolve()
        first.then(() => call("POST", "api/overheat/ack", { how: squat ? "squat" : "dismissed" }))
            // a refused squat leaves the warning up: the robot is still hot and still standing
            .catch((e) => onToast(e instanceof Error ? e.message : String(e)))
            .finally(() => setSending(false))
    }
    const latest = useRef(act)
    latest.current = act
    const squatLatest = useRef(!blocked)
    squatLatest.current = !blocked
    useEffect(() => {
        beep()
        const alarm = setInterval(beep, 2000)
        return () => clearInterval(alarm)
    }, [])
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.getGamepads) {
            return
        }
        // an A already held when the warning appears doesn't count: it has to be let go first
        let wasDown = true
        const timer = setInterval(() => {
            const down = [...navigator.getGamepads()].some((pad) => pad?.buttons[BUTTON.a]?.pressed)
            if (down && !wasDown) {
                const squat = squatLatest.current
                logPress(squat ? "overheat.squat" : "overheat.dismiss", "gamepad A")
                latest.current(squat)
            }
            wasDown = down
        }, PAD_POLL_MS)
        return () => clearInterval(timer)
    }, [])
    return (
        <div className="overheat-back" role="alertdialog" aria-labelledby="overheat-title">
            <div className="overheat">
                <header id="overheat-title">
                    <Icon name="warn" size={22} />
                    Warning: Robot Overheating
                </header>
                <div className="overheat-body">
                    <p>
                        {warning.joint ?? "A motor"} is at{" "}
                        <b>{warning.celsius}°C</b>. Driving is stopped. Please have the robot squat until it cools to
                        70°C.
                    </p>
                    {blocked && <p className="overheat-note">Squat isn't available here: {blocked}.</p>}
                </div>
                <footer>
                    <Button
                        data-ui="overheat.dismiss"
                        disabled={sending}
                        autoFocus={!!blocked}
                        onClick={() => act(false)}
                    >
                        Dismiss{blocked ? " (A)" : ""}
                    </Button>
                    <Button
                        data-ui="overheat.squat"
                        variant="warn"
                        disabled={sending || !!blocked}
                        autoFocus={!blocked}
                        title="A controlled crouch onto its own legs (FSM 706) — never a damp"
                        onClick={() => act(true)}
                    >
                        Squat (A)
                    </Button>
                </footer>
            </div>
        </div>
    )
}

/** The hottest motor above the commands, from 65°C: fading in to 68°C (blue), yellow to 70, pulsing yellow to 75, then
 * pulsing red; from 70 to 80°C it grows to 3× */
export function MotorHeat({ celsius, joint }: { celsius?: number | null; joint?: string | null }) {
    if (celsius == null || celsius <= 65) {
        return null
    }
    const tone = celsius >= 75 ? "red pulse" : celsius >= 70 ? "yellow pulse" : celsius >= 68 ? "yellow" : "blue"
    return (
        <div
            className={`motor-heat ${tone}`}
            style={{
                opacity: Math.min(1, (celsius - 65) / 3),
                scale: `${1 + 2 * Math.min(1, Math.max(0, (celsius - 70) / 10))}`,
            }}
            title={`The hottest motor${joint ? `: ${joint}` : ""}`}
        >
            Motors {Math.round(celsius)}°C
        </div>
    )
}

/** The page has the user's focus: this document, or Desktop's shell around it (a Steam Deck user never clicks in). */
function pageHasFocus(): boolean {
    if (document.hasFocus()) {
        return true
    }
    try {
        return globalThis.top !== globalThis.self && !!globalThis.top?.document.hasFocus()
    } catch {
        return false
    }
}

/** The gamepad (gamepad.ts has the rules): polled at 60 Hz; zeroed on blur, a hidden page, disconnect. `joy`: the raw
 * pad on every change, for the recording. */
export function useGamepad(handlers: {
    onAxes: (axes: Axes) => void
    onBoost: (boost: number) => void
    stop: () => void
    squat: () => void
    joy: (sample: { axes: number[]; buttons: number[] }) => void
}): GamepadStatus {
    const [status, setStatus] = useState<GamepadStatus>(noPad())
    const latest = useRef(handlers)
    latest.current = handlers
    useEffect(() => {
        if (typeof navigator === "undefined" || !navigator.getGamepads) {
            return
        }
        const driver = new GamepadDriver({
            setAxes: (axes) => latest.current.onAxes(axes),
            setBoost: (boost) => latest.current.onBoost(boost),
            stop: () => latest.current.stop(),
            squat: () => latest.current.squat(),
        }, setStatus)
        const pads = () => [...navigator.getGamepads()] as (PadLike | null)[]
        let lastJoy = ""
        const poll = () => {
            if (document.hidden || !pageHasFocus()) {
                driver.release()
            } else {
                driver.poll(pads(), performance.now())
            }
            const pad = activePad(pads())
            if (pad) {
                const sample = joySample(pad)
                const key = JSON.stringify(sample)
                if (key !== lastJoy) {
                    lastJoy = key
                    latest.current.joy(sample)
                }
            }
        }
        const timer = setInterval(poll, PAD_POLL_MS)
        const release = () => driver.release()
        const hidden = () => document.hidden && driver.release()
        addEventListener("blur", release)
        document.addEventListener("visibilitychange", hidden)
        return () => {
            clearInterval(timer)
            removeEventListener("blur", release)
            document.removeEventListener("visibilitychange", hidden)
            driver.release()
            latest.current.onAxes(ZERO_AXES)
        }
    }, [])
    return status
}

export function PadChip({ pad, linked }: { pad: GamepadStatus; linked: boolean }) {
    // a browser lists a pad only after a button press on this page (a reload hides it again until then)
    if (!pad.connected) {
        return (
            <Badge
                className="chip chip-pad"
                title="No gamepad seen yet: press any gamepad button (a browser lists a pad only after a press on this page)"
            >
                <Icon name="gamepad" size={12} /> <span className="fit">No gamepad</span>
            </Badge>
        )
    }
    const [tone, label] = !linked
        ? ["danger", "Disengaged"] as const
        : pad.stopped
        ? ["warn", "Stopped — press A"] as const
        : pad.squatHold > 0 && pad.squatHold < 1
        ? ["warn", "Hold B to squat…"] as const
        : pad.ready
        ? ["ok", "Gamepad"] as const
        : ["warn", "Center the sticks"] as const
    return (
        <Badge
            tone={tone}
            className="chip chip-pad"
            title={`Gamepad: ${pad.id}\n${GAMEPAD_BINDINGS.map(([b, a]) => `${b}: ${a}`).join("\n")}`}
        >
            <Icon name="gamepad" size={12} /> <span className="fit">{label}</span>
        </Badge>
    )
}

function clock(seconds: number): string {
    const s = Math.max(0, Math.floor(seconds))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`
}

export function megabytes(bytes: number): string {
    return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1)} MB`
}

/** Record: starts a recording when a person presses it — never on its own. Once on it stays on (pressing again says
 * so); "Stop recording" is in the / palette. */
export function RecordButton(
    { record, onToast }: { record: RecordState | undefined; onToast: (text: string) => void },
) {
    const [, tick] = useState(0)
    useEffect(() => {
        if (!record?.active) {
            return
        }
        const timer = setInterval(() => tick((n) => n + 1), 1000)
        return () => clearInterval(timer)
    }, [record?.active])
    const active = !!record?.active
    const seconds = active && record?.startedAt ? (Date.now() - record.startedAt) / 1000 : 0
    return (
        <Button
            data-ui="control.record"
            variant={active ? "danger" : "default"}
            size="sm"
            className={`rec-btn${active ? " on" : ""}`}
            title={active
                ? `Recording to ${record?.path ?? record?.file} — stays on (Stop recording is in the / palette)`
                : "Record this session (state, IMU, joints, battery, loco FSM, lidar, camera, velocities, commands, gamepad, presses, health) to an .mcap in Desktop's recordings folder"}
            onClick={() => {
                if (active) {
                    onToast("Recording stays on — Stop recording is in the / palette")
                    return
                }
                call("POST", "api/record/start").catch((e) => onToast(e instanceof Error ? e.message : String(e)))
            }}
        >
            <Icon name="record" size={14} />
            {active
                ? (
                    <span className="rec-text">
                        Recording · <span className="num rec-time">{clock(seconds)}</span> ·{" "}
                        <span className="num rec-size">{megabytes(record?.bytes ?? 0)}</span>
                    </span>
                )
                : <span className="rec-text">Record</span>}
        </Button>
    )
}
