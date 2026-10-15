// The one posture this app sends for a hot robot, and for the gamepad's hold-B: a CONTROLLED squat down. The helper's
// "squat" is LocoClient SetFsmId(706) (g1_helper_cpp unitree_bridge.cpp kFsmSquatToggle, sent once by
// run_fsm_transition) — the robot crouches onto its own legs under its controller. But on the way there the helper
// runs ensure_ai_mode(), which DAMPS (FSM 1) when the resident motion service isn't "ai", and 706 is a toggle that
// stands a squatting robot back up. So this only sends it when neither can happen: a robot that is up on its legs
// (walk / primitive_walk / stand / stiffen, so 706 goes down), with the "ai" motion service already resident (no damp),
// no sequence running and a link up. Anything else is refused with the reason.
import type { ModeKey } from "./g1.ts"

/** what the helper is sent: its "squat" command (FSM 706) */
export const SQUAT_MESSAGE = { type: "cmd", name: "squat" } as const
/** the FSM id that command sets (unitree_bridge.cpp kFsmSquatToggle) */
export const SQUAT_FSM = 706
const UP_ON_ITS_LEGS: ModeKey[] = ["walk", "primitive_walk", "stand", "stiffen"]
const RESIDENT_SERVICE = "ai"

export type SquatInputs = {
    ready: boolean
    mode: ModeKey | null
    motionMode: string | null
    sequenceRunning: boolean
}

/** Why a controlled squat can't be sent now, or null when it can. */
export function squatRefusal({ ready, mode, motionMode, sequenceRunning }: SquatInputs): string | null {
    if (!ready) {
        return "the robot's helper isn't connected"
    }
    if (!mode || !UP_ON_ITS_LEGS.includes(mode)) {
        return `the robot isn't up on its legs (mode ${mode ?? "unknown"}): a squat from here could stand it up`
    }
    if (motionMode !== RESIDENT_SERVICE) {
        return `the motion service is "${
            motionMode ?? "unknown"
        }", not "${RESIDENT_SERVICE}": switching it damps the ` +
            "robot first, so squat with the robot's remote instead"
    }
    if (sequenceRunning) {
        return "a sequence is still running"
    }
    return null
}
