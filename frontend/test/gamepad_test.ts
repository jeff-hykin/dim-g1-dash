// deno task test — the pad's safety rules (gamepad.ts), with a fake pad and target.
import { activePad, type Axes, boostOf, GamepadDriver, joySample, type PadLike, SQUAT_HOLD_MS } from "../src/gamepad.ts"

function assertEquals(actual: unknown, expected: unknown) {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(
            `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
        )
    }
}

function fake() {
    const pad: PadLike = {
        index: 0,
        id: "Steam Deck",
        mapping: "standard",
        connected: true,
        axes: [0, 0, 0, 0],
        buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    }
    const log: string[] = []
    let axes: Axes = { forward: 0, strafe: 0, turn: 0 }
    const driver = new GamepadDriver({
        setAxes: (a) => (axes = a),
        setBoost: (b) => log.push(`boost ${b}`),
        stop: () => log.push("stop"),
        squat: () => log.push("squat"),
    })
    const press = (i: number, down: boolean) => {
        ;(pad.buttons as { pressed: boolean; value: number }[])[i] = {
            pressed: down,
            value: down ? 1 : 0,
        }
    }
    return { pad, log, driver, press, axes: () => axes }
}

Deno.test("a stick held at connect drives nothing until it rests", () => {
    const { pad, driver, axes } = fake()
    pad.axes = [0, -1, 0, 0]
    driver.poll([pad], 0)
    assertEquals(axes(), { forward: 0, strafe: 0, turn: 0 })
    pad.axes = [0, 0, 0, 0]
    driver.poll([pad], 30)
    pad.axes = [0, -1, 0, 0]
    driver.poll([pad], 60)
    assertEquals(axes().forward, 1)
})

Deno.test("LT + RT stops and latches until A, then needs rest again", () => {
    const { pad, driver, press, log, axes } = fake()
    driver.poll([pad], 0)
    pad.axes = [0, -1, 0, 0]
    press(6, true)
    press(7, true)
    driver.poll([pad], 30)
    assertEquals(log, ["stop"])
    assertEquals(axes().forward, 0)
    press(6, false)
    press(7, false)
    press(0, true)
    driver.poll([pad], 60)
    press(0, false)
    driver.poll([pad], 90)
    assertEquals(axes().forward, 0) // stick still held: not at rest
    pad.axes = [0, 0, 0, 0]
    driver.poll([pad], 120)
    pad.axes = [0, -1, 0, 0]
    driver.poll([pad], 150)
    assertEquals(axes().forward, 1)
})

Deno.test("hold B: stop at once, squat after a second, once", () => {
    const { pad, driver, press, log } = fake()
    driver.poll([pad], 0)
    press(1, true)
    driver.poll([pad], 10)
    assertEquals(log, ["stop"])
    driver.poll([pad], 10 + SQUAT_HOLD_MS / 2)
    assertEquals(log, ["stop"])
    driver.poll([pad], 20 + SQUAT_HOLD_MS)
    driver.poll([pad], 40 + SQUAT_HOLD_MS)
    assertEquals(log, ["stop", "squat"])
})

Deno.test("disconnect zeroes", () => {
    const { pad, driver, axes } = fake()
    driver.poll([pad], 0)
    pad.axes = [0.5, 0, 0, 0]
    driver.poll([pad], 30)
    assertEquals(axes().strafe < 0, true)
    driver.poll([null], 60)
    assertEquals(axes(), { forward: 0, strafe: 0, turn: 0 })
})

Deno.test("Joy samples are the raw axes, then the triggers' analog travel, and 0/1 buttons", () => {
    const { pad, press } = fake()
    pad.axes = [0.12345, -1, 0, 0.5]
    press(7, true)
    ;(pad.buttons[6] as { value: number }).value = 0.4567
    const sample = joySample(pad)
    assertEquals(sample.axes, [0.1235, -1, 0, 0.5, 0.4567, pad.buttons[7].value])
    assertEquals(sample.buttons[7], 1)
    assertEquals(sample.buttons.length, 17)
})

Deno.test("LT boosts while held, releases on blur, and both triggers still stop", () => {
    const { pad, driver, press, log, axes } = fake()
    driver.poll([pad], 0)
    pad.axes = [0, -1, 0, 0]
    press(6, true)
    driver.poll([pad], 30)
    assertEquals(log, ["boost 1"])
    assertEquals(axes().forward, 1)
    press(6, false)
    driver.poll([pad], 60)
    assertEquals(log, ["boost 1", "boost 0"])
    press(6, true)
    driver.poll([pad], 90)
    press(7, true)
    driver.poll([pad], 120)
    assertEquals(log, [
        "boost 1",
        "boost 0",
        "boost 1",
        "stop",
        "boost 0",
    ])
    assertEquals(axes().forward, 0)
    assertEquals(driver.status.stopped, true)
})

Deno.test("LT boost is cleared on blur and requires rest before driving again", () => {
    const { pad, driver, press, log } = fake()
    driver.poll([pad], 0)
    press(6, true)
    driver.poll([pad], 30)
    driver.release()
    assertEquals(log, ["boost 1", "boost 0"])
    driver.poll([pad], 60)
    assertEquals(driver.status.ready, false)
    assertEquals(log, ["boost 1", "boost 0"])
})

Deno.test("LT boost follows how far it's pulled", () => {
    assertEquals([boostOf(0), boostOf(0.04), boostOf(0.5), boostOf(1)], [0, 0, 0.45, 1])
    const { pad, driver, log } = fake()
    driver.poll([pad], 0)
    ;(pad.buttons as { pressed: boolean; value: number }[])[6] = { pressed: false, value: 0.3 }
    driver.poll([pad], 30)
    ;(pad.buttons as { pressed: boolean; value: number }[])[6] = { pressed: false, value: 0.3 }
    driver.poll([pad], 60)
    assertEquals(log, ["boost 0.25"])
})

Deno.test("a standard-mapped pad wins over a raw one, even if the raw one moved last", () => {
    const pad = (id: string, mapping: string, timestamp: number): PadLike => ({
        index: 0,
        id,
        mapping,
        connected: true,
        timestamp,
        axes: [0, 0, 0, 0],
        buttons: [],
    })
    const raw = pad("1a86-e310 Legion Go S", "", 99)
    const steam = pad("Steam Virtual Gamepad", "standard", 5)
    assertEquals(activePad([raw, steam])?.id, steam.id)
    assertEquals(activePad([raw])?.id, raw.id)
})
