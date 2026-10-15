// The overheat warning, the controlled squat, press logging and recording. Nothing here reaches a robot: commands go
// to the tests' recording transport (robot.useTestTransport), and every file goes to a temp folder.
import { assert, assertEquals, assertMatch } from "@std/assert"
import { handle } from "./http.ts"
import { isFinished, readMcap, recoverMcap } from "./mcap.ts"
import { COOLED_C, OVERHEAT_C, overheatRises, OverheatWatch } from "./overheat.ts"
import {
    LIDAR_SILENT_MS,
    lidarWatch,
    listRecordings,
    mjpegFrames,
    record,
    recording,
    recordLidar,
    startRecording,
    stopRecording,
} from "./recording.ts"
import { conditions, defaultRoutes, linkKey, parseIwLink, systemTicks } from "./health.ts"
import { DESCRIPTION, routes } from "./routes.ts"
import { SQUAT_FSM, SQUAT_MESSAGE, squatRefusal } from "./squat.ts"
import * as robot from "./robot.ts"

const options = { sanitizeOps: false, sanitizeResources: false }
const dir = Deno.makeTempDirSync({ prefix: "g1-dash-test-" })
Deno.env.set("G1_DASH_RECORDINGS_DIR", dir)

const call = async (method: string, path: string, body?: unknown) => {
    const response = await handle(
        new Request(`http://app/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }),
        routes,
        DESCRIPTION,
    )
    return { status: response!.status, json: await response!.json() }
}

let sent: Record<string, unknown>[] = []
const fresh = () => {
    stopRecording()
    sent = []
    robot.useTestTransport((message) => sent.push(message))
    robot.onHelperEvent({ type: "status", onboard: true, unitree: true })
}
const hot = (celsius: number) => robot.onHelperEvent({ type: "state", soc: 80, hottestJoint: 3, hottestTemp: celsius })
const STOP = { type: "move", vx: 0, vy: 0, omega: 0 }

Deno.test("overheat: rises at 75°C, not again while up, 5°C hotter after an ack, at 75 again once cooled to 70", () => {
    assertEquals([overheatRises(74, false, null), overheatRises(75, false, null)], [false, true])
    assertEquals(overheatRises(80, true, null), false) // already up
    assertEquals([overheatRises(79, false, 76), overheatRises(81, false, 76)], [false, true])
    const watch = new OverheatWatch()
    assertEquals(watch.check(74.4, "L knee", 0), null)
    assertEquals(watch.check(75.2, "L knee", 1)?.celsius, 75)
    assertEquals(watch.check(77, "L knee", 2), null) // up: no second warning
    assertEquals(watch.acknowledge()?.celsius, 75)
    assertEquals(watch.acked, 77) // the hottest it got while up
    assertEquals(watch.check(80, "L knee", 3), null)
    assertEquals(watch.check(82, "L knee", 4)?.celsius, 82)
    watch.acknowledge()
    watch.check(COOLED_C - 1, "L knee", 5) // cooled
    assertEquals(watch.acked, null)
    assertEquals(watch.check(OVERHEAT_C, "L knee", 6)?.celsius, OVERHEAT_C)
    assertEquals(watch.acknowledge() !== null && watch.acknowledge() === null, true)
})

Deno.test(
    "overheat on the robot: zero velocity, moves refused until acknowledged, no posture change",
    options,
    async () => {
        fresh()
        robot.onHelperEvent({ type: "loco", fsm: 801, balance: 1, motionMode: "ai" })
        assertEquals((await call("POST", "api/move", { vx: 0.3 })).status, 200)
        sent = []
        hot(76)
        assertEquals(sent, [STOP]) // only the stop: nothing that changes its posture
        const state = (await call("GET", "api/state")).json
        assertEquals(state.overheat.celsius, 76)
        assertEquals(state.overheat.joint, "L knee")
        const refused = await call("POST", "api/move", { vx: 0.3 })
        assertEquals(refused.status, 409)
        assertMatch(refused.json.error, /overheating/)
        assertEquals((await call("POST", "api/move", { vx: 0, vy: 0, omega: 0 })).status, 200) // a stop always goes
        hot(78)
        assertEquals(sent.filter((m) => m.type === "move").length, 2) // no second warning (and stop) while it's up
        assertEquals((await call("POST", "api/overheat/ack", { how: "dismissed" })).json.acknowledged, true)
        assertEquals((await call("POST", "api/overheat/ack")).json.acknowledged, false)
        assertEquals((await call("POST", "api/move", { vx: 0.3 })).status, 200)
        assertEquals(sent.some((m) => m.type === "cmd" || m.type === "estop"), false)
    },
)

Deno.test("squat: only from up on its legs with the ai motion service, so it never damps or stands it up", () => {
    const ok = { ready: true, mode: "walk" as const, motionMode: "ai", sequenceRunning: false }
    assertEquals(squatRefusal(ok), null)
    assertEquals(squatRefusal({ ...ok, mode: "stand" }), null)
    assertEquals(squatRefusal({ ...ok, mode: "stiffen" }), null)
    assertMatch(squatRefusal({ ...ok, ready: false })!, /helper/)
    assertMatch(squatRefusal({ ...ok, mode: "squat" })!, /stand it up/) // 706 toggles: from a squat it rises
    assertMatch(squatRefusal({ ...ok, mode: "collapse" })!, /up on its legs/)
    assertMatch(squatRefusal({ ...ok, mode: "limp" })!, /up on its legs/)
    assertMatch(squatRefusal({ ...ok, mode: null })!, /unknown/)
    assertMatch(squatRefusal({ ...ok, motionMode: "normal" })!, /damps/) // ensure_ai_mode would damp first
    assertMatch(squatRefusal({ ...ok, sequenceRunning: true })!, /sequence/)
    assertEquals(SQUAT_MESSAGE, { type: "cmd", name: "squat" })
    assertEquals(SQUAT_FSM, 706)
})

Deno.test(
    "api/squat: dryRun sends nothing; refused off its legs; else stop then the squat command",
    options,
    async () => {
        fresh()
        robot.onHelperEvent({ type: "loco", fsm: 1, balance: 0, motionMode: "ai" }) // collapsed
        const refused = await call("POST", "api/squat", { why: "overheat" })
        assertEquals(refused.status, 409)
        assertEquals(sent, [])
        robot.onHelperEvent({ type: "loco", fsm: 802, balance: 1, motionMode: "normal" })
        assertEquals((await call("POST", "api/squat")).status, 409) // not the ai service: switching it would damp
        robot.onHelperEvent({ type: "loco", fsm: 802, balance: 1, motionMode: "ai" })
        const dry = await call("POST", "api/squat", { dryRun: true })
        assertEquals(dry.json.wouldSend, [STOP, { type: "cmd", name: "squat" }])
        assertEquals(sent, [])
        assertEquals((await call("POST", "api/squat", { why: "overheat" })).status, 200)
        assertEquals(sent, [STOP, { type: "cmd", name: "squat" }])
    },
)

Deno.test("nothing records on its own: a hot robot, presses and telemetry leave no file", options, async () => {
    fresh()
    const before = listRecordings(dir).recordings.length
    robot.onHelperEvent({ type: "loco", fsm: 801, balance: 1, motionMode: "ai" })
    hot(90)
    await call("POST", "api/ui/press", { id: "control.squat", label: "Squat" })
    robot.onHelperEvent({ type: "lidar", points: 1, nearest: 1, cloud: [1, 2, 3] })
    assertEquals(recording(), false)
    assertEquals((await call("GET", "api/record")).json.active, false)
    assertEquals(listRecordings(dir).recordings.length, before)
})

Deno.test(
    "Record: one file with state, commands, presses and the overheat on /logs; Record again keeps it",
    options,
    async () => {
        fresh()
        const started = (await call("POST", "api/record/start")).json
        assertEquals(started.active, true)
        assertEquals((await call("POST", "api/record/start")).json.file, started.file) // pressing again doesn't restart
        robot.onHelperEvent({ type: "loco", fsm: 801, balance: 1, motionMode: "ai" })
        await call("POST", "api/move", { vx: 0.2 })
        await call("POST", "api/ui/press", { id: "control.record", label: "Record" })
        hot(77)
        await call("POST", "api/overheat/ack", { how: "dismissed" })
        recordLidar([1, 2, 3, 4, 5, 6])
        await call("POST", "api/joy", { axes: [0, -1], buttons: [1, 0] })
        await call("POST", "api/camera/video_note", { note: "stream offline" })
        assertEquals((await call("POST", "api/record/stop")).json.stopped, true)
        const path = `${dir}/${started.file}`
        assert(isFinished(path))
        const messages = readMcap(Deno.readFileSync(path))
        const topics = new Set(messages.map((m) => m.topic))
        for (const topic of ["/state", "/loco", "/cmd_vel", "/logs", "/lidar", "/joystick"]) {
            assert(topics.has(topic), `${topic} recorded`)
        }
        const logs = messages.filter((m) => m.topic === "/logs").map((m) => m.message as Record<string, unknown>)
        const press = logs.find((l) => l.type === "ui_press")
        assertEquals([press?.id, press?.label], ["control.record", "Record"])
        assertEquals(logs.find((l) => l.type === "overheat")?.celsius, 77)
        assertEquals(logs.find((l) => l.type === "overheat_ack")?.how, "dismissed")
        assertEquals(logs.find((l) => l.type === "video_note")?.note, "stream offline")
        const lidar = messages.find((m) => m.topic === "/lidar")!.message as { data: string; point_stride: number }
        assertEquals(lidar.point_stride, 12)
        assertEquals([...new Float32Array(Uint8Array.from(atob(lidar.data), (c) => c.charCodeAt(0)).buffer)], [
            1,
            2,
            3,
            4,
            5,
            6,
        ])
        assertEquals((await call("POST", "api/record/stop")).json.stopped, false)
        assertEquals((await call("GET", "api/press-nothing")).status, 404)
    },
)

Deno.test("a recording a crash left open is finished on the next start, keeping every whole record", options, () => {
    fresh()
    const status = startRecording(dir) as { file: string }
    for (let i = 0; i < 20; i++) {
        record("/state", { i })
    }
    const path = `${dir}/${status.file}`
    // the crash: what the writer flushed so far, cut mid-record
    const whole = (() => {
        stopRecording()
        return Deno.readFileSync(path)
    })()
    const crashed = `${dir}/crashed.mcap`
    const dataEnd = whole.findLastIndex((_b, i) => whole[i] === 0x0f && whole[i + 1] === 4) // the data end record
    Deno.writeFileSync(crashed, whole.subarray(0, dataEnd - 7)) // the last message loses its tail
    assertEquals(isFinished(crashed), false)
    assert(recoverMcap(crashed)! > 0)
    assert(isFinished(crashed))
    const kept = readMcap(Deno.readFileSync(crashed)).filter((m) => m.topic === "/state")
    assert(kept.length >= 18 && kept.length < 21, `kept ${kept.length}`)
    Deno.writeTextFileSync(`${dir}/not-an.mcap`, "hello")
    assertEquals(recoverMcap(`${dir}/not-an.mcap`), null)
})

Deno.test("the lidar watch: silent after 20 s while watched and recording, then resumed", options, () => {
    fresh()
    assertEquals(lidarWatch(true), null) // not recording
    startRecording(dir)
    const t0 = Date.now()
    recordLidar([0, 0, 0], t0)
    assertEquals(lidarWatch(true, t0 + LIDAR_SILENT_MS - 1), null)
    assertEquals(lidarWatch(false, t0 + LIDAR_SILENT_MS + 1), null) // not watched (lidar released, robot down)
    assertEquals(lidarWatch(true, t0 + LIDAR_SILENT_MS + 1), "silent")
    assertEquals(lidarWatch(true, t0 + LIDAR_SILENT_MS + 2), null)
    recordLidar([0, 0, 0], t0 + LIDAR_SILENT_MS + 3)
    assertEquals(lidarWatch(true, t0 + LIDAR_SILENT_MS + 4), "resumed")
    stopRecording()
})

Deno.test("health: Wi-Fi, routes, CPU, and what counts as wrong", () => {
    const iw = "Connected to aa:bb (on wlan0)\n\tSSID: dimensional\n\tfreq: 5180\n\tsignal: -61 dBm\n" +
        "\ttx bitrate: 433.3 MBit/s\n\trx bitrate: 390.0 MBit/s\n"
    assertEquals(parseIwLink(iw), {
        ssid: "dimensional",
        signal: "-61 dBm",
        txBitrate: "433.3 MBit/s",
        rxBitrate: "390.0 MBit/s",
        freq: "5180",
    })
    assertEquals(parseIwLink("Not connected."), { connected: false })
    const table = "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\n" +
        "wlan0\t00000000\t010CA8C0\t0003\t0\t0\t600\t00000000\n" +
        "eth0\t007BA8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\n"
    assertEquals(defaultRoutes(table), "wlan0 via 192.168.12.1 metric 600")
    assertEquals(systemTicks("cpu  10 0 10 70 10 0 0 0 0 0\n"), [20, 100])
    const fine = {
        wifi: { ssid: "x", signal: "-50 dBm", addr: "1.2.3.4" },
        robot: { link: "ready", silentMs: 100 },
        cpu: 20,
    }
    assertEquals([...conditions(fine).keys()], [])
    const bad = { wifi: { connected: false }, robot: { link: "down", silentMs: null }, cpu: 99 }
    assertEquals([...conditions(bad).keys()].sort(), ["cpu", "link", "wifi"])
    assertEquals([...conditions({ wifi: { signal: "-85 dBm" }, robot: { link: "ready", silentMs: 5000 } }).keys()], [
        "signal",
        "silent",
    ])
    assertEquals([...conditions({ cpu: 10 }).keys()], []) // no Wi-Fi interface at all: not a problem
    assert(linkKey(fine) !== linkKey({ ...fine, wifi: { ...fine.wifi, addr: "1.2.3.5" } }))
    assertEquals(linkKey(fine), linkKey({ ...fine, wifi: { ...fine.wifi, signal: "-70 dBm" } }))
})

Deno.test("the camera's MJPEG parts come apart by Content-Length, with their X-Timestamp", async () => {
    const part = (bytes: number[], stamp: number) => [
        new TextEncoder().encode(
            `--frame\r\nContent-Type: image/jpeg\r\nX-Timestamp: ${stamp}\r\nContent-Length: ${bytes.length}\r\n\r\n`,
        ),
        new Uint8Array(bytes),
        new TextEncoder().encode("\r\n"),
    ]
    const all = new Uint8Array(await new Blob([...part([1, 2, 3], 1000), ...part([4, 5], 2000)]).arrayBuffer())
    // split mid-part, as a socket would
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            controller.enqueue(all.subarray(0, 50))
            controller.enqueue(all.subarray(50))
            controller.close()
        },
    })
    const frames = []
    for await (const frame of mjpegFrames(body)) {
        frames.push([[...frame.jpeg], frame.atMs])
    }
    assertEquals(frames, [[[1, 2, 3], 1000], [[4, 5], 2000]])
})

Deno.test("simulated overheat is refused off the simulator", options, async () => {
    fresh()
    assertEquals((await call("POST", "api/overheat/simulate", { celsius: 80 })).status, 409)
})
