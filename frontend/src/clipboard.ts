// served over plain http, navigator.clipboard is often missing (secure-context only): the textarea path is the real one
export async function copyText(text: string) {
    try {
        if (navigator.clipboard && isSecureContext) {
            await navigator.clipboard.writeText(text)
            return true
        }
    } catch {
        // fall through
    }
    const area = document.createElement("textarea")
    area.value = text
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0"
    document.body.appendChild(area)
    area.select()
    let ok = false
    try {
        ok = document.execCommand("copy")
    } catch {
        ok = false
    }
    area.remove()
    return ok
}
