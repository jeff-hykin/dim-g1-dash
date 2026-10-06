// dimOS shared line icons (24-unit grid, stroke = currentColor) — the ones this app uses.
const PATHS: Record<string, string> = {
    camera: "M4 7h3l2-2h6l2 2h3v12H4V7Zm8 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z",
    expand: "M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7",
    shrink: "M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7",
    "chevron-down": "m6 9 6 6 6-6",
    "arrow-up": "M12 19V5m-6 6 6-6 6 6",
    "arrow-down": "M12 5v14m-6-6 6 6 6-6",
    "arrow-left": "M19 12H5m6-6-6 6 6 6",
    "arrow-right": "M5 12h14m-6-6 6 6-6 6",
    "rotate-left": "M4 12a8 8 0 1 0 2.3-5.7M4 4v5h5",
    "rotate-right": "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
    menu: "M4 6h16M4 12h16M4 18h16",
    warn: "M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
}

export function Icon({ name, size = 18 }: { name: keyof typeof PATHS | string; size?: number }) {
    return (
        <svg className="dim-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
            <path d={PATHS[name] ?? ""} />
        </svg>
    )
}

/** The G1 head-and-shoulders mark beside the app's name. */
export function BrandMark() {
    return (
        <svg
            className="mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path d="M12 3.6 V5.1" />
            <circle cx="12" cy="2.9" r="0.55" fill="currentColor" stroke="none" />
            <rect x="6.8" y="5.1" width="10.4" height="8.2" rx="2.9" />
            <path d="M9.9 8.5 v1.4" />
            <path d="M14.1 8.5 v1.4" />
            <path d="M4.6 21 c0.6-3.4 3.6-5.2 7.4-5.2 s6.8 1.8 7.4 5.2" />
        </svg>
    )
}
