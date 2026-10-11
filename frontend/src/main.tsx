import { createRoot } from "react-dom/client"
import { AppProvider } from "dimos-react"
import { App } from "./App.tsx"
import { Gate } from "./OffRobot.tsx"
import "./app.css"

// AppProvider: Desktop's skin (live), toasts and dialogs; no URL state and no zenoh (the app talks to its own backend)
createRoot(document.getElementById("root")!).render(
    <AppProvider url={false} toastPosition="bottom">
        <Gate>
            <App />
        </Gate>
    </AppProvider>,
)
