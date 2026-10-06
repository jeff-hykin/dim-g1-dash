// Is this the G1's Jetson? G1 Ctrl drives the robot from onboard, so on anything else the panel shows a setup guide.
// A Jetson is aarch64 Linux with /etc/nv_tegra_release, or a device-tree model naming a Jetson / Orin.
// G1_ONBOARD=1 / 0 overrides the check (a custom carrier board, or testing the guide).

export type Platform = { jetson: boolean; os: string; arch: string; model: string | null; overridden: boolean }

function readText(path: string): string | null {
    try {
        return Deno.readTextFileSync(path).replaceAll("\0", "").trim()
    } catch {
        return null
    }
}

export function detectPlatform(
    {
        os = Deno.build.os as string,
        arch = Deno.build.arch as string,
        read = readText,
        env = Deno.env.get("G1_ONBOARD"),
    } = {},
): Platform {
    const model = os === "linux" ? read("/proc/device-tree/model") : null
    if (env === "1" || env === "0") {
        return { jetson: env === "1", os, arch, model, overridden: true }
    }
    const tegra = os === "linux" && read("/etc/nv_tegra_release") !== null
    const jetsonModel = /NVIDIA Jetson|Orin/i.test(model ?? "")
    return {
        jetson: os === "linux" && arch === "aarch64" && (tegra || jetsonModel),
        os,
        arch,
        model,
        overridden: false,
    }
}

let cached: Platform | null = null

/** detectPlatform(), once per process. */
export function platform(): Platform {
    return cached ??= detectPlatform()
}
