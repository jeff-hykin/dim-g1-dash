import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import { App } from "./App.tsx"
import { Gate } from "./OffRobot.tsx"
import { unlockAudio } from "./Operator.tsx"
import { installPressLog } from "./presses.ts"
import "./app.css"

installPressLog() // every button press → api/ui/press → g1-ctrl.log (+ the recording's /logs)
unlockAudio() // the overheat alarm can sound once someone has pressed anything

// AppProvider: Desktop's skin (live), toasts and dialogs; no URL state and no zenoh (the app talks to its own backend)
createRoot(document.getElementById("root")!).render(
    <AppProvider url={false} toastPosition="bottom">
        <Gate>
            <App />
        </Gate>
    </AppProvider>,
)
