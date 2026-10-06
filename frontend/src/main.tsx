import { createRoot } from "react-dom/client"
import { App } from "./App.tsx"
import { Gate } from "./OffRobot.tsx"
import { initTheme } from "./dim-app/theme.js"
import "./dim-app/theme.css"
import "./app.css"

initTheme()
createRoot(document.getElementById("root")!).render(
    <Gate>
        <App />
    </Gate>,
)
