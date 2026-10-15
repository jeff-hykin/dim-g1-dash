// What dimOS Desktop tells this server at start: the DIMOS_APP env var, one JSON object (dimos-desktop docs/apps.md).
// Desktop passes no flags or other variables.

export type DimosApp = { socket?: string; dataDir?: string; recordingsDir?: string }

let parsed: DimosApp | null = null

export function dimosApp(): DimosApp {
    if (parsed) {
        return parsed
    }
    try {
        parsed = JSON.parse(Deno.env.get("DIMOS_APP") || "{}") as DimosApp
    } catch {
        console.error("DIMOS_APP isn't valid JSON; ignoring it")
        parsed = {}
    }
    return parsed
}

/** Where the app keeps its log: G1_DASH_DATA_DIR, else Desktop's dataDir, else ~/.local/share/dim-g1-dash. */
export function dataDir(): string {
    return Deno.env.get("G1_DASH_DATA_DIR") ?? dimosApp().dataDir ??
        `${Deno.env.get("HOME") ?? "."}/.local/share/dim-g1-dash`
}

/** Where recordings go: G1_DASH_RECORDINGS_DIR, else Desktop's recordings folder's g1/, else <data dir>/recordings. */
export function recordingsDir(): string {
    const root = dimosApp().recordingsDir
    return Deno.env.get("G1_DASH_RECORDINGS_DIR") ?? (root ? `${root}/g1` : `${dataDir()}/recordings`)
}
