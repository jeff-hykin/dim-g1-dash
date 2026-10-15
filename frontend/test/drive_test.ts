// deno task test — the G1's velocity from the keys and the pad (drive.ts).
import { MOVE_LIMITS, STOPPED, velocityOf } from "../src/drive.ts"

function assertEquals(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
}
const none = { forward: 0, strafe: 0, turn: 0 }
const speeds = { linearSpeed: 0.6, turnSpeed: 1.5 }

Deno.test("the pad's full stick is the key's speed; boost is ×1.6 at most", () => {
    assertEquals(velocityOf(none, { forward: 1, strafe: 0, turn: 0 }, speeds, 0), { vx: 0.6, vy: 0, omega: 0 })
    assertEquals(velocityOf({ forward: 1, strafe: 0, turn: 0 }, none, speeds, 1).vx, 0.96)
    assertEquals(velocityOf(none, { forward: 0, strafe: 1, turn: -1 }, speeds, 0.5), { vx: 0, vy: 0.52, omega: -1.95 })
    assertEquals(velocityOf(none, none, speeds, 1), STOPPED)
})

Deno.test("keys and pad together never pass the stick's range or the backend's limits", () => {
    const fast = { linearSpeed: 1.2, turnSpeed: 2.5 }
    const both = velocityOf({ forward: 1, strafe: 1, turn: 1 }, { forward: 1, strafe: 1, turn: 1 }, fast, 5)
    assertEquals(both.vx <= MOVE_LIMITS.vx && both.vy <= MOVE_LIMITS.vy && both.omega <= MOVE_LIMITS.omega, true)
    assertEquals(both.vx, 1.92)
    assertEquals(velocityOf({ forward: -1, strafe: 0, turn: 0 }, { forward: 1, strafe: 0, turn: 0 }, fast, 0), STOPPED)
})
