// The camera: api/camera/stream (the helper's MJPEG, proxied by the backend) parsed here instead of handed to an
// <img>, because an <img> can't say its frame rate or lag. Only the newest undecoded frame is kept, so a slow decode
// falls behind by dropping rather than queueing, and each part's X-Timestamp makes lag measurable.

export type CameraStats = { fps: number; lagMs: number | null }

function indexOf(haystack: Uint8Array, needle: Uint8Array) {
    outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (haystack[i + j] !== needle[j]) {
                continue outer
            }
        }
        return i
    }
    return -1
}

/** Streams into `canvas` until the returned stop(); `onFail` once if the stream errors or ends. */
export function streamCamera(
    canvas: HTMLCanvasElement,
    handlers: { onFirstFrame(): void; onStats(stats: CameraStats): void; onFail(message: string): void },
): () => void {
    const abort = new AbortController()
    let pending: { bytes: Uint8Array; stamp: number } | null = null
    let decoding = false
    let started = false
    const frameTimes: number[] = []
    let lagMs: number | null = null
    let clockOffset: number | null = null

    const draw = async () => {
        if (decoding) {
            return
        }
        decoding = true
        while (pending && !abort.signal.aborted) {
            const { bytes, stamp } = pending
            pending = null // anything newer replaces this, never queues
            try {
                const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: "image/jpeg" }))
                if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
                    canvas.width = bitmap.width
                    canvas.height = bitmap.height
                }
                canvas.getContext("2d")!.drawImage(bitmap, 0, 0)
                bitmap.close()
                if (!started) {
                    started = true
                    handlers.onFirstFrame()
                }
                const now = Date.now()
                frameTimes.push(now)
                while (frameTimes.length && now - frameTimes[0] > 1000) {
                    frameTimes.shift()
                }
                if (stamp) {
                    // the clocks aren't synchronised: the smallest difference ever seen estimates the offset, so what is
                    // left is queueing delay
                    const raw = now - stamp
                    if (clockOffset === null || raw < clockOffset) {
                        clockOffset = raw
                    }
                    lagMs = lagMs === null ? raw - clockOffset : lagMs * 0.8 + (raw - clockOffset) * 0.2
                }
                handlers.onStats({ fps: frameTimes.length, lagMs })
            } catch {
                // a corrupt part isn't worth killing the stream over
            }
        }
        decoding = false
    }
    ;(async () => {
        const response = await fetch(`api/camera/stream?t=${Date.now()}`, { signal: abort.signal, cache: "no-store" })
        if (!response.ok || !response.body) {
            const data = await response.json().catch(() => null)
            throw new Error(data?.error ?? `stream HTTP ${response.status}`)
        }
        const reader = response.body.getReader()
        const headerEnd = new TextEncoder().encode("\r\n\r\n")
        let buffer = new Uint8Array(0)
        for (;;) {
            const { done, value } = await reader.read()
            if (done) {
                throw new Error("camera stream ended")
            }
            const merged = new Uint8Array(buffer.length + value.length)
            merged.set(buffer)
            merged.set(value, buffer.length)
            buffer = merged
            for (;;) {
                const headerAt = indexOf(buffer, headerEnd)
                if (headerAt < 0) {
                    break
                }
                const header = new TextDecoder().decode(buffer.subarray(0, headerAt))
                const length = /content-length:\s*(\d+)/i.exec(header)
                const bodyAt = headerAt + headerEnd.length
                if (!length) {
                    buffer = buffer.subarray(bodyAt)
                    continue
                }
                if (buffer.length < bodyAt + Number(length[1])) {
                    break // wait for the rest
                }
                pending = {
                    bytes: buffer.slice(bodyAt, bodyAt + Number(length[1])),
                    stamp: Number(/x-timestamp:\s*(\d+)/i.exec(header)?.[1] ?? 0),
                }
                buffer = buffer.subarray(bodyAt + Number(length[1]))
                draw()
            }
        }
    })().catch((error) => {
        if (!abort.signal.aborted) {
            handlers.onFail(error instanceof Error ? error.message : String(error))
        }
    })
    return () => abort.abort()
}
