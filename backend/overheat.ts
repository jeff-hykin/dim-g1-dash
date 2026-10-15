// The overheat warning (go2-dash's, for the G1): a motor at OVERHEAT_C stops driving and raises a warning that stays
// up, with the page's alarm, until someone acknowledges it. Its default action is a controlled squat (squat.ts) —
// the operator presses it; nothing here moves the robot on its own. After an acknowledgement it comes back
// OVERHEAT_STEP_C hotter, or at OVERHEAT_C again once the motors have cooled below COOLED_C. Pure: robot.ts feeds it
// readings and acts on what it returns.

/** a motor this hot (°C) raises the warning */
export const OVERHEAT_C = 75
/** after an acknowledgement the warning comes back this much hotter */
export const OVERHEAT_STEP_C = 5
/** cooled this far (°C): the next warning is at OVERHEAT_C again — and what the warning asks to wait for */
export const COOLED_C = OVERHEAT_C - OVERHEAT_STEP_C

export type Warning = { celsius: number; joint: string | null; at: number; limit: number }

/** Whether a reading raises the warning: at OVERHEAT_C, unless it's up already or was acknowledged at a temperature
 * this one isn't OVERHEAT_STEP_C past. */
export function overheatRises(celsius: number, up: boolean, acked: number | null): boolean {
    return !up && celsius >= OVERHEAT_C && (acked === null || celsius >= acked + OVERHEAT_STEP_C)
}

export class OverheatWatch {
    warning: Warning | null = null
    /** the temperature it was last acknowledged at (null: cooled since, or never) */
    acked: number | null = null
    /** the hottest reading since the warning went up */
    #peak = 0

    /** One hottest-motor reading; returns the warning when this one raised it. */
    check(celsius: number, joint: string | null, now = Date.now()): Warning | null {
        if (this.warning) {
            this.#peak = Math.max(this.#peak, celsius)
        }
        if (celsius < COOLED_C) {
            this.acked = null
        }
        if (!overheatRises(Math.round(celsius), this.warning !== null, this.acked)) {
            return null
        }
        this.warning = { celsius: Math.round(celsius), joint, at: now, limit: OVERHEAT_C }
        this.#peak = celsius
        return this.warning
    }

    /** Takes the warning down; returns it (null: none was up). */
    acknowledge(): Warning | null {
        const warning = this.warning
        if (warning) {
            this.acked = Math.round(Math.max(this.#peak, warning.celsius))
            this.warning = null
        }
        return warning
    }

    reset() {
        this.warning = null
        this.acked = null
        this.#peak = 0
    }
}
