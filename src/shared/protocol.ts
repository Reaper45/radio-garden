import { homedir } from "os"
import { join } from "path"

export const STATE_DIR = join(homedir(), ".local", "state", "radio-garden")
export const SOCKET_PATH = join(STATE_DIR, "sock")
export const CACHE_DIR = join(homedir(), ".cache", "radio-garden")
export const PLACES_CACHE = join(CACHE_DIR, "places.json")
export const PLACES_TTL_MS = 7 * 24 * 60 * 60 * 1000 // OPEN-4

/** Browser UA. Cloudflare 403s anything that looks automated (INTENT §4 gotcha 1). */
export const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"

export const IDLE_TIMEOUT_MS = 5 * 60 * 1000 // OPEN-6
export const CONNECT_WATCHDOG_MS = 10_000 // OPEN-3
export const FLOWING_WATCHDOG_MS = 5_000 // OPEN-3

/**
 * Spectrum frame geometry — shared because the daemon fills the frames and the
 * client labels the rows.
 *
 * The visualiser is a GitHub contribution graph: seven log-spaced frequency
 * rows (a week's worth), each cell one of five intensity levels, scrolling
 * right as time passes. Seven rows is the whole reason the band count is fixed
 * rather than adaptive — the grid's shape is the point.
 */
export const BANDS = 7
/** 0 is an empty cell, 4 the brightest green — GitHub's five-step scale. */
export const MAX_LEVEL = 4
const BAND_MIN_HZ = 40
const BAND_MAX_HZ = 16_000

/** Band boundaries, low to high. `BAND_EDGES[b]`..`BAND_EDGES[b + 1]` is band b. */
export const BAND_EDGES: number[] = Array.from({ length: BANDS + 1 }, (_, i) =>
  BAND_MIN_HZ * Math.pow(BAND_MAX_HZ / BAND_MIN_HZ, i / BANDS),
)

/** Row labels, low to high: the geometric centre of each band, short enough for a 3-cell gutter. */
export const BAND_LABELS: string[] = Array.from({ length: BANDS }, (_, b) => {
  const centre = Math.sqrt(BAND_EDGES[b] * BAND_EDGES[b + 1])
  return centre >= 1000 ? `${Math.round(centre / 1000)}k` : `${Math.round(centre)}`
})

export interface StationRef {
  id: string
  title: string
  placeId: string
  placeTitle: string
  country: string
  preroll: boolean
}

export type PowerState = "ac" | "battery"
export type PlayState = "stopped" | "resolving" | "buffering" | "playing" | "error"

export interface DaemonState {
  play: PlayState
  station: StationRef | null
  /** Sibling stations in the current place — the list `n` walks (D7). */
  siblings: StationRef[]
  nowPlaying: string | null
  /** null when the station plays natively; "aac" when routed via the ffmpeg shim (D13). */
  via: "native" | "aac-shim" | null
  power: PowerState
  lidSafe: boolean
  message: string | null
}

export type ClientMessage =
  | { t: "subscribe" }
  | { t: "play"; channelId: string }
  | { t: "playStation"; station: StationRef; siblings?: StationRef[] }
  | { t: "stop" }
  | { t: "next" }
  | { t: "status" }
  | { t: "shutdown" }

export type DaemonMessage =
  | { t: "state"; state: DaemonState }
  | { t: "spectrum"; bands: number[] }
  | { t: "error"; message: string }

export function encode(msg: unknown): string {
  return JSON.stringify(msg) + "\n"
}

/** Splits a byte stream into newline-delimited JSON messages. */
export function createLineDecoder<T>(onMessage: (msg: T) => void) {
  let buf = ""
  return (chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
    let i: number
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      try {
        onMessage(JSON.parse(line) as T)
      } catch {
        // ignore malformed frames rather than killing the connection
      }
    }
  }
}

interface WritableSocket {
  write(data: Uint8Array): number
}

/**
 * Bun's `socket.write()` may accept only part of a large buffer and return a
 * short count. Writing a ~8 KB message and ignoring the result truncates it,
 * the receiver's JSON.parse fails, and the frame vanishes silently.
 *
 * So all writes go through here: the unwritten remainder is held and flushed on
 * `drain`. Control messages queue reliably; spectrum frames are droppable, because a
 * congested peer should lose visualiser frames rather than build a backlog
 * (INTENT §5).
 */
export class FrameWriter {
  private pending: Uint8Array | null = null
  private droppedFrames = 0

  constructor(
    private readonly sock: WritableSocket,
    private readonly maxPending = 1 << 20,
  ) {}

  get dropped(): number {
    return this.droppedFrames
  }

  /** Reliable: queued and retried until written. */
  send(msg: unknown): void {
    this.enqueue(new TextEncoder().encode(encode(msg)))
  }

  /** Lossy: skipped entirely if anything is still pending. */
  sendDroppable(msg: unknown): void {
    if (this.pending) {
      this.droppedFrames++
      return
    }
    this.enqueue(new TextEncoder().encode(encode(msg)))
  }

  private enqueue(bytes: Uint8Array): void {
    if (this.pending) {
      if (this.pending.length + bytes.length > this.maxPending) {
        this.droppedFrames++
        return
      }
      const merged = new Uint8Array(this.pending.length + bytes.length)
      merged.set(this.pending)
      merged.set(bytes, this.pending.length)
      this.pending = merged
    } else {
      this.pending = bytes
    }
    this.flush()
  }

  /** Call from the socket's `drain` handler. */
  flush(): void {
    while (this.pending) {
      let n: number
      try {
        n = this.sock.write(this.pending)
      } catch {
        this.pending = null
        return
      }
      if (n <= 0) return // socket full; wait for drain
      if (n >= this.pending.length) {
        this.pending = null
        return
      }
      this.pending = this.pending.subarray(n)
    }
  }
}
