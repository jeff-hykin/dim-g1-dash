// Every button press goes to the backend's log (g1-ctrl.log, and the recording's /logs): api/ui/press with the
// button's data-ui id and its visible text.
import { call } from "./api.ts"

const PRESSABLE =
    "[data-ui], button, [role=button], [role=tab], [role=option], a[href], input[type=checkbox], input[type=radio], select"
/** data-ui-skip: a dialog body that only keeps clicks off its backdrop: not a press */
const SKIP = "[data-ui-skip]"

/** One press: `id` is the button's data-ui (e.g. control.record), `label` its visible text when that says more. */
export function logPress(id: string, label = "") {
    call("POST", "api/ui/press", { id, label }).catch(() => {})
}

function labelOf(el: HTMLElement): string {
    const text = el.textContent?.trim() || el.getAttribute("aria-label") || el.title || ""
    return text.replace(/\s+/g, " ").trim().slice(0, 80)
}

/** Logs every click (mouse, touch, Enter/Space) on anything pressable; one without a data-ui is logged as unlabeled. */
export function installPressLog() {
    document.addEventListener("click", (event) => {
        const el = (event.target as Element | null)?.closest?.(`${PRESSABLE}, ${SKIP}`) as HTMLElement | null
        if (!el || el.matches(SKIP) || (el as HTMLButtonElement).disabled) {
            return
        }
        const checked = el instanceof HTMLInputElement ? (el.checked ? " on" : " off") : ""
        logPress(el.dataset.ui ?? "unlabeled", labelOf(el) + checked)
    }, { capture: true })
}
