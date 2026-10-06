// G1 Ctrl drives the robot from its onboard Jetson. On any other machine (api/platform) the page is this short guide
// instead of the dashboard, unless the simulator is on or the helper is up on the robot's LAN (a remote session).
import { useEffect, useState } from "react"
import { call } from "./api.ts"
import { copyText } from "./clipboard.ts"
import { BrandMark } from "./icons.tsx"
import type { RobotState } from "./types.ts"

const GUIDE_URL = "https://github.com/dimensionalOS/dimos/blob/main/docs/platforms/humanoid/g1/index.md"
const INSTALL_DESKTOP =
    "curl -fsSL https://raw.githubusercontent.com/jeff-hykin/dimos-desktop-mirror/main/install.sh | bash"

type Platform = { jetson: boolean }

/** The dashboard on the G1 (or with the simulator on); the guide anywhere else. */
export function Gate({ children }: { children: React.ReactNode }) {
    const [jetson, setJetson] = useState<boolean | null>(null)
    const [linked, setLinked] = useState(false) // the simulator, or a helper on the robot's LAN
    useEffect(() => {
        call<Platform>("GET", "api/platform").then((p) => setJetson(p.jetson), () => setJetson(true))
    }, [])
    useEffect(() => {
        if (jetson !== false) {
            return
        }
        const poll = () =>
            call<RobotState>("GET", "api/state").then(
                ({ link }) => setLinked(link.kind === "simulator" || (link.kind === "helper" && link.onboard === true)),
                () => {},
            )
        poll()
        const timer = setInterval(poll, 3000)
        return () => clearInterval(timer)
    }, [jetson])
    if (jetson === null) {
        return null // the first-paint page color until we know
    }
    if (jetson || linked) {
        return <>{children}</>
    }
    return <OffRobot onSimulate={() => setLinked(true)} />
}

function OffRobot({ onSimulate }: { onSimulate: () => void }) {
    const [copied, setCopied] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const copy = async () => {
        if (await copyText(INSTALL_DESKTOP)) {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
        } else {
            setError("Couldn't copy: select the command instead.")
        }
    }
    const simulate = () =>
        call("PUT", "api/simulator", { enabled: true }).then(onSimulate, (e) => setError(String(e?.message ?? e)))
    return (
        <div className="off-robot">
            <div className="off-bar">
                <div className="brand">
                    <BrandMark />
                    <span className="dim-title name">G1 Ctrl</span>
                </div>
                <div className="spacer" />
            </div>
            <div className="off-body">
                <div className="dim-empty off-card" role="status" data-testid="off-robot">
                    <div className="dim-empty-title">G1 Ctrl runs on the G1</div>
                    <div className="dim-empty-body">
                        It drives the robot from the G1's onboard computer, so install it there:
                    </div>
                    <ol className="off-steps">
                        <li>Join the G1's network (Ethernet or Wi-Fi).</li>
                        <li>
                            SSH in: <code>ssh unitree@192.168.123.164</code>
                        </li>
                        <li>
                            Install dimOS Desktop there:
                            <div className="off-cmd">
                                <code>{INSTALL_DESKTOP}</code>
                                <button type="button" className="dim-btn sm ghost" onClick={copy}>
                                    {copied ? "Copied" : "Copy"}
                                </button>
                            </div>
                        </li>
                        <li>Open the link it prints, then install G1 Ctrl.</li>
                    </ol>
                    {error && <div className="dim-empty-body off-error">{error}</div>}
                    <div className="dim-empty-actions">
                        <a className="dim-btn primary" href={GUIDE_URL} target="_blank" rel="noreferrer">
                            Read the full guide
                        </a>
                        <button type="button" className="dim-btn ghost" onClick={simulate}>
                            Try the simulator
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}
