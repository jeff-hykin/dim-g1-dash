// What the keys and the gamepad ask the G1 for: one body velocity, within what backend/g1.ts MOVE_LIMITS allows.
// DOM-free so it's testable (test/drive_test.ts).
import type { Axes } from "./gamepad.ts"

/** full boost (Shift, RB, LT pulled all the way): ×1.6 */
export const BOOST = 1.6
/** strafe as a fraction of forward */
export const VY_RATIO = 0.4 / 0.6
/** backend/g1.ts MOVE_LIMITS: the fastest speeds ×1.6 */
export const MOVE_LIMITS = { vx: 1.2 * 1.6, vy: 1.2 * 1.6 * (0.4 / 0.6), omega: 2.5 * 1.6 }

export type Velocity = { vx: number; vy: number; omega: number }
export const STOPPED: Velocity = { vx: 0, vy: 0, omega: 0 }

const clamp = (v: number, limit = 1) => Math.max(-limit, Math.min(limit, v))
const clean = (v: number) => Math.round(v * 1000) / 1000 || 0

/** keys (each -1/0/1) plus the pad's axes, each clamped to -1..1; `boost` 0..1 (Shift or RB = 1, LT its pull) */
export function velocityOf(
    keys: Axes,
    pad: Axes,
    speeds: { linearSpeed: number; turnSpeed: number },
    boost: number,
): Velocity {
    const factor = 1 + (BOOST - 1) * clamp(boost, 1)
    const forward = clamp(keys.forward + pad.forward)
    const strafe = clamp(keys.strafe + pad.strafe)
    const turn = clamp(keys.turn + pad.turn)
    return {
        vx: clean(clamp(forward * speeds.linearSpeed * factor, MOVE_LIMITS.vx)),
        vy: clean(clamp(strafe * speeds.linearSpeed * VY_RATIO * factor, MOVE_LIMITS.vy)),
        omega: clean(clamp(turn * speeds.turnSpeed * factor, MOVE_LIMITS.omega)),
    }
}

export const isMoving = (v: Velocity) => v.vx !== 0 || v.vy !== 0 || v.omega !== 0
