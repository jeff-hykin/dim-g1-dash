// What the G1 can be asked to do, in the panel's vocabulary. Modes name what the robot IS doing (derived from the loco
// service's FSM id + balance mode); commands say which mode they put it into and which modes they need. The backend
// gates on this (and the UI renders what api/commands says), so the panel and the agent can never disagree.

export type ModeKey = "walk" | "primitive_walk" | "stand" | "stiffen" | "squat" | "sit" | "collapse" | "limp"

export const MODES: Record<ModeKey, { fsms: number[]; blurb: string }> = {
    walk: { fsms: [801, 802], blurb: "advanced controller — natural walking, accepts drive commands" },
    primitive_walk: { fsms: [200], blurb: "primitive controller — stompier walking, accepts drive commands" },
    // a balancing controller with balance mode 0: holds still instead of stepping (no FSM id of its own)
    stand: { fsms: [], blurb: "balancing but holding still — Walk to step again" },
    stiffen: { fsms: [4], blurb: "joints locked and legs straight, not balancing yet" },
    // FSM 706 toggles squat but is never reported at rest, so there is no resting id to match
    squat: { fsms: [], blurb: "crouched on its own legs, no balance control" },
    sit: { fsms: [3], blurb: "seated, no balance control — needs a chair or support under it" },
    collapse: { fsms: [1], blurb: "damped — joints limp, the robot rests on whatever holds it" },
    limp: { fsms: [0], blurb: "zero torque — motors fully off" },
}

export const BALANCING_MODES: ModeKey[] = ["walk", "primitive_walk", "stand"]
export const DRIVING_MODES: ModeKey[] = ["walk", "primitive_walk"]
// up on its legs: a toggle (squat) pressed from one of these goes DOWN, from anything else it comes UP
const UPRIGHT_MODES: ModeKey[] = ["walk", "primitive_walk", "stand", "stiffen"]
const BALANCE_HOLD_STILL = 0

const FSM_TO_MODE = new Map<number, ModeKey>()
for (const [key, mode] of Object.entries(MODES) as [ModeKey, (typeof MODES)[ModeKey]][]) {
    for (const fsm of mode.fsms) {
        FSM_TO_MODE.set(fsm, key)
    }
}

export function resolveMode(fsm: unknown, balance: unknown): ModeKey | null {
    const fromFsm = typeof fsm === "number" ? FSM_TO_MODE.get(fsm) : undefined
    if ((fromFsm === "walk" || fromFsm === "primitive_walk") && balance === BALANCE_HOLD_STILL) {
        return "stand"
    }
    return fromFsm ?? null
}

type Wording = { label: string; confirmTitle?: string; warn?: string }

export type Command = Wording & {
    /** what agents and the UI call it (api/command `command`) */
    id: string
    /** the helper's command name, and gait for the primitive controller */
    name: string
    gait?: string
    /** puts the robot INTO this mode */
    mode?: ModeKey
    /** only works from these modes */
    requires?: ModeKey[]
    /** legal on the robot but wrong from these modes */
    notFrom?: ModeKey[]
    /** "red": the robot goes limp and FALLS if standing; "amber": it takes torque control or lets go in a controlled way */
    danger?: "red" | "amber"
    /** a multi-step engage sequence (progress arrives as `seq` events) */
    seq?: boolean
    /** hidden from the dock; the palette lists it */
    advanced?: boolean
    /** button style */
    tone?: "good" | "bad"
    hint?: string
    /** a toggle whose wording depends on the posture it starts from */
    directions?: { down: Wording; up: Wording }
}

export const COMMANDS: Command[] = [
    {
        id: "stiffen",
        name: "ready",
        mode: "stiffen",
        label: "Stiffen",
        seq: true,
        danger: "amber",
        notFrom: BALANCING_MODES,
        confirmTitle: "robot damps, then straightens up",
        hint: "locks the joints and straightens the legs — the step before balancing",
        warn:
            "The robot straightens its legs and locks the joints under torque, ready to balance. Give it clear space. (From zero torque it damps first to wake the controller — it never damps a robot that is already holding itself up.)",
    },
    {
        id: "walk",
        name: "stand",
        mode: "walk",
        label: "Walk",
        tone: "good",
        seq: true,
        danger: "amber",
        warn:
            "The robot will straighten its legs and take torque control to self-balance, then walk on command. Make sure the G1 is on a gantry or on flat ground with clear space around it.",
    },
    {
        id: "collapse",
        name: "damp",
        mode: "collapse",
        label: "Collapse",
        tone: "bad",
        danger: "red",
        warn:
            "All joints go limp immediately. If the robot is standing or balancing, <b>IT WILL FALL</b>. Only confirm if it is seated, crouched, or on a gantry. For a moving emergency use E-STOP.",
    },
    { id: "wave", name: "wavehand", label: "Wave", requires: BALANCING_MODES },
    { id: "shake", name: "shakehand", label: "Shake", requires: BALANCING_MODES },
    {
        // one id (706) toggles both ways; the robot picks the direction from its posture
        id: "squat",
        name: "squat",
        mode: "squat",
        label: "Stand (from Squat)",
        seq: true,
        danger: "amber",
        directions: {
            down: {
                label: "Squat",
                confirmTitle: "robot will crouch",
                warn:
                    "The robot crouches down onto its own legs and lets go of balance control. It holds itself up, so it needs no chair and no clearance — press again to come back up.",
            },
            up: {
                label: "Stand (from Squat)",
                confirmTitle: "robot will rise and self-balance",
                warn:
                    "The robot straightens its legs out of a squat and takes torque control to balance. Give it clear space.",
            },
        },
    },
    {
        id: "standup",
        name: "lie2standup",
        label: "Stand Up (from lying)",
        seq: true,
        danger: "amber",
        confirmTitle: "robot will get up off the floor",
        warn:
            "The robot pushes itself up from lying on its back and ends up balancing. It needs clear space around and above it, and the floor to be flat.",
    },
    {
        id: "sit",
        name: "sit",
        mode: "sit",
        label: "Sit (Chair)",
        danger: "amber",
        confirmTitle: "put a chair behind the robot",
        warn:
            "Sitting turns <b>balance control off</b>: the robot lowers backwards expecting a chair or support underneath it. <b>With nothing there it comes down on the floor.</b><br><br>Check that a chair is in place behind the robot before confirming. This is the posture Unitree uses for shutdown.",
    },
    {
        id: "zerotorque",
        name: "zerotorque",
        mode: "limp",
        label: "Zero Torque",
        tone: "bad",
        danger: "red",
        advanced: true,
        warn:
            "Motor torque cuts out instantly — an even harder collapse than <b>Collapse</b>. If the robot is standing, <b>IT WILL FALL</b>. Only confirm if it is seated, crouched, or on a gantry.",
    },
    {
        id: "stand",
        name: "balancestand",
        mode: "stand",
        label: "Stand",
        advanced: true,
        requires: BALANCING_MODES,
        hint: "stop stepping and balance in place, staying under torque control",
    },
    {
        id: "primitive-walk-slow",
        name: "balance",
        gait: "walk",
        mode: "primitive_walk",
        label: "Primitive Walk (slow)",
        seq: true,
        danger: "amber",
        advanced: true,
        warn:
            "Engages the <b>primitive</b> walking controller, which balances and walks with a stompier, less refined gait than <b>Walk</b>. The robot takes torque control — make sure it is on a gantry or on flat ground with clear space around it.",
    },
    {
        id: "primitive-walk-fast",
        name: "balance",
        gait: "run",
        mode: "primitive_walk",
        label: "Primitive Walk (fast)",
        seq: true,
        danger: "amber",
        advanced: true,
        warn:
            "Same as <b>Primitive Walk (slow)</b> but with longer, faster strides. The robot takes torque control — make sure it is on a gantry or on flat ground with clear space around it.",
    },
    { id: "wave-turn", name: "waveturn", label: "Wave + Turn", advanced: true, requires: BALANCING_MODES },
    {
        id: "release-arms",
        name: "releasearm",
        label: "Release Arms",
        advanced: true,
        requires: BALANCING_MODES,
        hint: "return the arms to their neutral pose after a gesture",
    },
    {
        id: "high-stand",
        name: "highstand",
        label: "High Stand",
        advanced: true,
        requires: BALANCING_MODES,
        hint: "raises the standing height",
    },
    {
        id: "low-stand",
        name: "lowstand",
        label: "Low Stand",
        advanced: true,
        requires: BALANCING_MODES,
        hint: "lowers the standing height",
    },
]

/** The command the way it behaves from `mode` (a toggle takes the wording of the direction it will go). */
export function resolveCommand(command: Command, mode: ModeKey | null): Command {
    if (!command.directions) {
        return command
    }
    return { ...command, ...command.directions[mode && UPRIGHT_MODES.includes(mode) ? "down" : "up"] }
}

/** Why `command` can't run from `mode`, or null. An unknown mode blocks nothing: the robot's own refusal decides. */
export function blockedReason(command: Command, mode: ModeKey | null): string | null {
    if (command.mode && command.mode === mode) {
        return `already in ${mode}`
    }
    if (command.notFrom && mode && command.notFrom.includes(mode)) {
        return `not from ${mode} — Collapse first`
    }
    if (!command.requires || !mode || command.requires.includes(mode)) {
        return null
    }
    return `needs mode: ${command.requires.join(", ")} — robot is in ${mode}`
}

/** One command as api/commands lists it: resolved for the current mode, with why it's blocked. */
export function describeCommand(raw: Command, mode: ModeKey | null) {
    const command = resolveCommand(raw, mode)
    const blocked = blockedReason(command, mode)
    const title = blocked
        ? `${command.label} — ${blocked}`
        : command.mode
        ? `${command.label} → mode: ${command.mode} (${MODES[command.mode].blurb})`
        : command.hint
        ? `${command.label} — ${command.hint}`
        : command.label
    const { directions: _directions, notFrom: _notFrom, ...rest } = command
    return { ...rest, blocked, title, active: !!command.mode && command.mode === mode }
}

export const DRIVE_DEFAULTS = { linearSpeed: 0.6, turnSpeed: 1.5 }
export const DRIVE_LIMITS = { linearSpeed: [0.1, 1.2], turnSpeed: [0.2, 2.5] } as const
/** the most a move may ask for: the speed limits with the panel's Shift boost (×1.6) */
export const MOVE_LIMITS = { vx: 1.2 * 1.6, vy: 1.2 * 1.6 * (0.4 / 0.6), omega: 2.5 * 1.6 }

/** URDF revolute-joint names in motor order, for naming the hottest motor */
export const MOTOR_NAMES = [
    "L hip pitch",
    "L hip roll",
    "L hip yaw",
    "L knee",
    "L ankle pitch",
    "L ankle roll",
    "R hip pitch",
    "R hip roll",
    "R hip yaw",
    "R knee",
    "R ankle pitch",
    "R ankle roll",
    "waist yaw",
    "waist roll",
    "waist pitch",
    "L shoulder pitch",
    "L shoulder roll",
    "L shoulder yaw",
    "L elbow",
    "L wrist roll",
    "L wrist pitch",
    "L wrist yaw",
    "R shoulder pitch",
    "R shoulder roll",
    "R shoulder yaw",
    "R elbow",
    "R wrist roll",
    "R wrist pitch",
    "R wrist yaw",
]
