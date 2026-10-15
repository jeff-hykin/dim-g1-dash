// What the backend's GET endpoints return (backend/robot.ts snapshot, backend/g1.ts describeCommand).

export type Settings = { linearSpeed: number; turnSpeed: number; robotIp: string }

export type RobotState = {
    link: {
        kind: "helper" | "simulator" | "test" | null
        ready: boolean
        note: string | null
        onboard: boolean | null
        remote: boolean
        iface: string | null
    }
    devices: {
        unitree: boolean | null
        lidar: boolean | null
        camera: boolean | null
        lidarClaimed: boolean
        cameraClaimed: boolean
        cameraPort: number
        cameraQuality: number | null
        cameraMaxFps: number | null
    }
    mode: string | null
    modeBlurb: string | null
    drivable: boolean
    loco:
        | { fsm: number; balance: number | null; motionMode: string | null; sequenceRunning: boolean; ageMs: number }
        | null
    sequence: { name: string; step: string; state: string } | null
    battery: { percent: number; remaining: string | null } | null
    attitude: { roll: number; pitch: number; yaw: number } | null
    hottestMotor: { celsius: number; index: number; name: string | null } | null
    fsmMachine: number | null
    jointPositions: number[] | null
    telemetryAgeMs: number | null
    lidar: { points: number; nearest: number | null; ageMs: number } | null
    /** the overheat warning while it's up (backend/overheat.ts): moves are refused until it's acknowledged */
    overheat: Overheat | null
    record: RecordState
    settings: Settings
}

export type Overheat = { celsius: number; joint: string | null; at: number; limit: number }

export type RecordState = {
    active: boolean
    file?: string
    path?: string
    startedAt?: number
    seconds?: number
    bytes?: number
    messages?: number
    lidarSilentS?: number | null
}

export type CommandInfo = {
    id: string
    label: string
    mode?: string
    danger?: "red" | "amber"
    seq?: boolean
    advanced?: boolean
    tone?: "good" | "bad"
    confirmTitle?: string
    warn?: string
    blocked: string | null
    title: string
    active: boolean
}

/** What arrives on api/events/ws (backend/robot.ts, backend/routes.ts) */
export type AppEvent =
    | { type: "state"; state: RobotState }
    | { type: "mode"; mode: string | null }
    | { type: "notice"; level: "info" | "error"; message: string }
    | { type: "settings"; settings: Settings }
    | { type: "lidar"; points: number; nearest: number | null; cloud: number[] }
    | { type: "seq"; sequence: { name: string; step: string; state: string } }
    | { type: "overheat"; overheat: Overheat | null }
    | { type: "record"; record: RecordState }
    | { type: "ui_press"; id: string; label: string }
    | { type: "video_note"; note: string }
