// Every route: a happy path and an error. Nothing here reaches a robot — commands go to a recording transport, and
// actuating calls are also exercised with dryRun.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { handle } from "./http.ts"
import { DESCRIPTION, routes } from "./routes.ts"
import { detectPlatform } from "./platform.ts"
import * as robot from "./robot.ts"

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        DESCRIPTION,
    )
    const type = response!.headers.get("content-type") ?? ""
    return {
        status: response!.status,
        json: type.includes("json") ? await response!.json() : null,
        bytes: type.includes("json") ? null : new Uint8Array(await response!.arrayBuffer()),
        type,
    }
}

const options = { sanitizeOps: false, sanitizeResources: false }
let sent: Record<string, unknown>[] = []
const fresh = () => {
    sent = []
    robot.useTestTransport((message) => sent.push(message))
    robot.onHelperEvent({ type: "status", onboard: true, remote: false, unitree: true, lidar: false, camera: false })
}

Deno.test("api/state and api/commands follow the robot's mode", options, async () => {
    fresh()
    robot.onHelperEvent({ type: "loco", fsm: 801, balance: 1, motionMode: "ai" })
    robot.onHelperEvent({ type: "state", soc: 80, rpy: [0, 0.1, 0], hottestJoint: 3, hottestTemp: 50, q: [0, 1] })
    const state = (await call("GET", "api/state")).json
    assertEquals(state.mode, "walk")
    assertEquals(state.battery.percent, 80)
    assertEquals(state.hottestMotor.name, "L knee")
    const { json } = await call("GET", "api/commands")
    const byId = Object.fromEntries(json.commands.map((c: { id: string }) => [c.id, c]))
    assertEquals(byId.walk.blocked, "already in walk")
    assertEquals(byId.squat.label, "Squat") // upright: the toggle goes down
    assertEquals(byId.wave.blocked, null)
    robot.onHelperEvent({ type: "loco", fsm: 1, balance: 0 })
    assertEquals(
        (await call("GET", "api/commands")).json.commands.find((c: { id: string }) => c.id === "wave").blocked,
        "needs mode: walk, primitive_walk, stand — robot is in collapse",
    )
    assertEquals((await call("GET", "api/nope")).status, 404)
})

Deno.test("api/command: gated by mode, dangerous ones need confirm, dryRun sends nothing", options, async () => {
    fresh()
    robot.onHelperEvent({ type: "loco", fsm: 1, balance: 0 }) // collapsed
    assertEquals((await call("POST", "api/command", { command: "fly" })).status, 400)
    assertEquals((await call("POST", "api/command", {})).status, 400)
    assertEquals((await call("POST", "api/command", { command: "wave" })).status, 409) // needs balancing
    const unconfirmed = await call("POST", "api/command", { command: "walk" })
    assertEquals(unconfirmed.status, 409)
    assertMatch(unconfirmed.json.error, /confirm: true/)
    const dry = await call("POST", "api/command", { command: "walk", confirm: true, dryRun: true })
    assertEquals(dry.json.wouldSend, { type: "cmd", name: "stand" })
    assertEquals(sent, [])
    const real = await call("POST", "api/command", { command: "primitive-walk-fast", confirm: true })
    assertEquals(real.status, 200)
    assertEquals(sent, [{ type: "cmd", name: "balance", gait: "run" }])
})

Deno.test("api/move: limits, durations, dryRun", options, async () => {
    fresh()
    assertEquals((await call("POST", "api/move", { vx: 9 })).status, 400)
    assertEquals((await call("POST", "api/move", { vx: "fast" })).status, 400)
    assertEquals((await call("POST", "api/move", { vx: 0.3, durationMs: 60_000 })).status, 400)
    const dry = await call("POST", "api/move", { vx: 0.3, dryRun: true })
    assertEquals(dry.json.wouldSend, { type: "move", vx: 0.3, vy: 0, omega: 0 })
    assertEquals(sent, [])
    await call("POST", "api/move", { vx: 0.3, omega: 0.5, durationMs: 200 })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert(sent.length >= 3, `re-sent while held (${sent.length})`)
    assertEquals(sent.at(-1), { type: "move", vx: 0, vy: 0, omega: 0 })
})

Deno.test("api/estop and the device claims", options, async () => {
    fresh()
    assertEquals((await call("POST", "api/estop", { dryRun: true })).json.wouldSend, { type: "estop" })
    assertEquals(sent, [])
    assertEquals((await call("POST", "api/estop")).json.sent, { type: "estop" })
    assertEquals((await call("PUT", "api/lidar", { connected: true })).json.sent, { type: "config", lidar: true })
    assertEquals((await call("PUT", "api/lidar", { connected: "maybe" })).status, 400)
    assertEquals((await call("PUT", "api/camera", { connected: false, dryRun: true })).json.wouldSend, {
        type: "config",
        camera: false,
    })
    assertEquals((await call("PUT", "api/camera", {})).status, 400)
    assertEquals((await call("PUT", "api/camera/stream", { maxFps: 10 })).json.sent, { type: "config", camMaxFps: 10 })
    assertEquals((await call("PUT", "api/camera/stream", { quality: 400 })).status, 400)
    assertEquals((await call("POST", "api/camera/takeover", { dryRun: true })).json.dryRun, true)
})

Deno.test("with no helper, actions say why instead of failing silently", options, async () => {
    robot.useTestTransport(null)
    const response = await call("POST", "api/estop")
    assertEquals(response.status, 503)
    assertEquals((await call("POST", "api/estop", { dryRun: true })).json.linkReady, false)
    assertEquals((await call("POST", "api/camera/takeover")).status, 503)
})

Deno.test("camera stream + snapshot come from the helper's MJPEG port", options, async () => {
    fresh()
    assertEquals((await call("GET", "api/camera/snapshot")).status, 503) // not connected
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9])
    const server = Deno.serve({ port: 0, onListen: () => {} }, () => {
        const head = new TextEncoder().encode(
            `--frame\r\nContent-Type: image/jpeg\r\nX-Timestamp: 1\r\nContent-Length: ${jpeg.length}\r\n\r\n`,
        )
        return new Response(new Blob([head, jpeg, new TextEncoder().encode("\r\n")]), {
            headers: { "content-type": "multipart/x-mixed-replace; boundary=frame" },
        })
    })
    robot.onHelperEvent({ type: "status", camera: true, camWanted: true, camPort: server.addr.port })
    const snapshot = await call("GET", "api/camera/snapshot")
    assertEquals(snapshot.type, "image/jpeg")
    assertEquals([...snapshot.bytes!], [...jpeg])
    const stream = await call("GET", "api/camera/stream")
    assertMatch(stream.type, /multipart/)
    server.shutdown() // not awaited: it waits out the fetch pool's keep-alive connections
})

Deno.test("lidar cloud, settings, log, simulator", options, async () => {
    fresh()
    assertEquals((await call("GET", "api/lidar/cloud")).status, 404)
    robot.onHelperEvent({ type: "lidar", points: 1, nearest: 0.5, cloud: [1, 2, 3] })
    assertEquals((await call("GET", "api/lidar/cloud")).json.cloud, [1, 2, 3])

    assertEquals((await call("PUT", "api/settings", { linearSpeed: 0.9 })).json.linearSpeed, 0.9)
    assertEquals((await call("GET", "api/settings")).json.linearSpeed, 0.9)
    assertEquals((await call("PUT", "api/settings", { turnSpeed: 99 })).status, 400)
    assertEquals((await call("PUT", "api/settings", { reset: true })).json.linearSpeed, 0.6)

    robot.onHelperEvent({ type: "error", msg: "command 'wavehand' refused by the robot (code=7303)" })
    assertMatch((await call("GET", "api/log")).json.lines.at(-1).message, /7303/)
    assertEquals((await call("GET", "api/log", undefined)).status, 200)
    assertEquals((await call("GET", "api/log?limit=0")).status, 400)

    assertEquals((await call("PUT", "api/simulator", { enabled: true })).json.simulator, true)
    assertEquals((await call("POST", "api/command", { command: "walk", confirm: true })).status, 200)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assertEquals((await call("GET", "api/state")).json.mode, "walk")
    assertEquals((await call("PUT", "api/simulator", { enabled: "sometimes" })).status, 400)
    robot.useTestTransport(() => {}) // stops the simulator's timers
})

Deno.test("agent.json lists every route", options, async () => {
    const { json } = await call("GET", "agent.json")
    assertEquals(json.endpoints.length, routes.length)
})

Deno.test("api/platform: a Jetson only on aarch64 Linux with Tegra or a Jetson/Orin model", options, async () => {
    const { json } = await call("GET", "api/platform")
    assertEquals(typeof json.jetson, "boolean")
    const none = () => null
    assertEquals(detectPlatform({ os: "darwin", arch: "aarch64", read: none, env: "" }).jetson, false)
    const orin = (path: string) => path.endsWith("model") ? "NVIDIA Jetson Orin NX\0" : null
    assertEquals(detectPlatform({ os: "linux", arch: "aarch64", read: orin, env: "" }).jetson, true)
    assertEquals(detectPlatform({ os: "linux", arch: "x86_64", read: orin, env: "" }).jetson, false)
    const tegra = (path: string) => path === "/etc/nv_tegra_release" ? "# R35" : null
    assertEquals(detectPlatform({ os: "linux", arch: "aarch64", read: tegra, env: "" }).jetson, true)
    assertEquals(detectPlatform({ os: "linux", arch: "aarch64", read: none, env: "" }).jetson, false)
    assertEquals(detectPlatform({ os: "darwin", arch: "aarch64", read: none, env: "1" }).jetson, true)
})
