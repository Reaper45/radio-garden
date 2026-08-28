import { setupAudio, type Audio, type AudioStream } from "@opentui/core"
import type { Subprocess } from "bun"
import { resolveStream, type Codec } from "../api/client"
import {
  BANDS,
  CONNECT_WATCHDOG_MS,
  FLOWING_WATCHDOG_MS,
  USER_AGENT,
  type PlayState,
  type StationRef,
} from "../shared/protocol"
import { Spectrum, WINDOW } from "./spectrum"

export interface PlayerEvents {
  onState: (state: PlayState, message?: string) => void
  onNowPlaying: (title: string | null) => void
  onSpectrum: (bands: number[]) => void
  onDead: (station: StationRef, reason: string) => void
}

const TAP_CAPACITY = 65_536

/**
 * Playback + visualiser.
 *
 * Codec routing (INTENT D13): OpenTUI's engine accepts mp3/flac only, but 39% of
 * Radio Garden stations serve AAC. Those go through an ffmpeg transcode shim.
 * Both paths converge on the same output tap, so the spectrum never knows which
 * one fed it.
 */
export class Player {
  private audio: Audio | null = null
  private stream: AudioStream | null = null
  private shim: Subprocess | null = null
  private spectrum = new Spectrum()
  private ticker: NodeJS.Timeout | null = null
  private watchdog: NodeJS.Timeout | null = null
  private lastAudioAt = 0
  private everFlowed = false
  private generation = 0
  private current: StationRef | null = null

  constructor(private readonly ev: PlayerEvents) {}

  get station(): StationRef | null {
    return this.current
  }

  private engine(): Audio {
    if (!this.audio) {
      // Runs headless: no renderer is attached in the daemon.
      this.audio = setupAudio({ autoStart: true })
      this.audio.enableTap(TAP_CAPACITY)
    }
    return this.audio
  }

  async play(station: StationRef): Promise<void> {
    const gen = ++this.generation
    await this.teardown()
    this.current = station
    this.ev.onState("resolving")

    const resolved = await resolveStream(station.id)
    if (gen !== this.generation) return

    if (resolved.codec === "dead") {
      this.ev.onDead(station, resolved.contentType || "no response")
      return
    }

    this.ev.onState("buffering")
    const audio = this.engine()

    try {
      this.stream =
        resolved.codec === "mp3"
          ? await this.playNative(audio, resolved.url)
          : await this.playViaShim(audio, resolved.url)
    } catch (err) {
      if (gen !== this.generation) return
      this.ev.onDead(station, err instanceof Error ? err.message : String(err))
      return
    }
    if (gen !== this.generation) {
      await this.teardown()
      return
    }

    this.stream.on("metadata", (m: any) => {
      if (gen !== this.generation) return
      const title = m?.fields?.StreamTitle
      this.ev.onNowPlaying(typeof title === "string" && title.trim() ? title.trim() : null)
    })
    this.stream.on("error", (err) => {
      if (gen !== this.generation) return
      this.ev.onDead(station, err.message)
    })

    this.lastAudioAt = Date.now()
    this.everFlowed = false
    this.startTicker()
    this.startWatchdog(station, gen)
    this.ev.onState("playing")
  }

  private async playNative(audio: Audio, url: string): Promise<AudioStream> {
    return audio.playStreamUrl(url, {
      request: { headers: { "User-Agent": USER_AGENT, "Icy-MetaData": "1" } },
      contentTypePolicy: "validate",
    })
  }

  /**
   * AAC shim: ffmpeg transcodes to mp3 and we hand the body to the same engine.
   * Costs the in-band ICY metadata, which ffmpeg strips (INTENT §9).
   */
  private async playViaShim(audio: Audio, url: string): Promise<AudioStream> {
    const proc = Bun.spawn(
      [
        "ffmpeg", "-hide_banner", "-loglevel", "error",
        "-user_agent", USER_AGENT,
        "-i", url,
        "-f", "mp3", "-b:a", "128k", "pipe:1",
      ],
      { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
    )
    this.shim = proc
    this.ev.onNowPlaying(null)
    try {
      return await audio.playStream(proc.stdout as ReadableStream<Uint8Array>, { format: "mp3" })
    } catch (err) {
      proc.kill()
      this.shim = null
      throw new Error(
        err instanceof Error && /ENOENT/.test(err.message)
          ? "ffmpeg not found — AAC stations need it (brew install ffmpeg)"
          : `AAC shim failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /**
   * Reads the output tap at 30 Hz. The tap is a native ring buffer the mixer
   * fills regardless of whether anyone reads it, so a slow consumer costs stale
   * spectrum frames, never audio (INTENT §5).
   */
  private startTicker(): void {
    this.stopTicker()
    let last = Date.now()
    this.ticker = setInterval(() => {
      const now = Date.now()
      const dt = now - last
      last = now
      const audio = this.audio
      if (!audio) return
      const tap = audio.readTapFrames(WINDOW, 1)
      if (tap && tap.framesRead > 0) {
        const frames = tap.frames.subarray(0, tap.framesRead)
        let energy = 0
        for (let i = 0; i < frames.length; i++) energy += frames[i] * frames[i]
        if (energy > 1e-9) {
          this.lastAudioAt = now
          this.everFlowed = true
        }
        this.ev.onSpectrum(this.spectrum.push(frames))
      } else {
        this.ev.onSpectrum(this.spectrum.idle(dt))
      }
    }, 33)
  }

  /**
   * Second watchdog mechanism (INTENT OPEN-3). The resolve-time content-type gate
   * catches stations that were already dead; this catches ones that connect and
   * then stall, which emit nothing to inspect.
   */
  private startWatchdog(station: StationRef, gen: number): void {
    this.stopWatchdog()
    this.watchdog = setInterval(() => {
      if (gen !== this.generation) return
      const limit = this.everFlowed ? FLOWING_WATCHDOG_MS : CONNECT_WATCHDOG_MS
      if (Date.now() - this.lastAudioAt > limit) {
        this.ev.onDead(station, this.everFlowed ? "stream stalled" : "no audio after connect")
      }
    }, 1_000)
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
  }

  private stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
  }

  async stop(): Promise<void> {
    this.generation++
    await this.teardown()
    this.current = null
    this.ev.onState("stopped")
    this.ev.onSpectrum(new Array(BANDS).fill(0))
  }

  private async teardown(): Promise<void> {
    this.stopTicker()
    this.stopWatchdog()
    if (this.stream) {
      try {
        this.stream.dispose()
      } catch {}
      this.stream = null
    }
    if (this.shim) {
      try {
        this.shim.kill()
      } catch {}
      this.shim = null
    }
  }

  async dispose(): Promise<void> {
    await this.teardown()
    if (this.audio) {
      try {
        this.audio.dispose()
      } catch {}
      this.audio = null
    }
  }
}
