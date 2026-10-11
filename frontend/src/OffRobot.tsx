// G1 Ctrl drives the robot from its onboard Jetson. On any other machine (api/platform) the page is this short guide
// instead of the dashboard, unless the simulator is on or the helper is up on the robot's LAN (a remote session).
import { useEffect, useState } from "react"
import { call } from "./api.ts"
import { Alert, AppShell, Button, CodeBlock, EmptyState, Stepper, TopBar } from "dimos-react"
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
    const [error, setError] = useState<string | null>(null)
    const simulate = () =>
        call("PUT", "api/simulator", { enabled: true }).then(onSimulate, (e) => setError(String(e?.message ?? e)))
    return (
        <AppShell
            topBar={window.parent === window ? <TopBar title="G1 Ctrl" icon="robot" /> : undefined}
            className="off-robot"
        >
            <EmptyState
                layer
                icon="robot"
                role="status"
                data-testid="off-robot"
                title="G1 Ctrl runs on the G1"
                message="It drives the robot from the G1's onboard computer, so install it there:"
                actions={
                    <>
                        <Button
                            variant="primary"
                            icon="external"
                            onClick={() => open(GUIDE_URL, "_blank", "noreferrer")}
                        >
                            Read the full guide
                        </Button>
                        <Button variant="ghost" onClick={simulate}>Try the simulator</Button>
                    </>
                }
            >
                <Stepper
                    vertical
                    current={-1}
                    steps={[
                        { label: "Join the G1's network (Ethernet or Wi-Fi)." },
                        {
                            label: "SSH in",
                            description: <CodeBlock language="sh" code="ssh unitree@192.168.123.164" />,
                        },
                        {
                            label: "Install dimOS Desktop there",
                            description: <CodeBlock language="sh" code={INSTALL_DESKTOP} />,
                        },
                        { label: "Open the link it prints, then install G1 Ctrl." },
                    ]}
                />
                {error && <Alert tone="danger">{error}</Alert>}
            </EmptyState>
        </AppShell>
    )
}
