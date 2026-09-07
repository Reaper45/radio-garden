/**
 * Tap PCM -> 1/3-octave bar heights (D19).
 *
 * The second visualiser. It shares the FFT and the asymmetric smoothing of the
 * contribution grid's analyser and then diverges in three places, each forced
 * by the band plan rather than chosen:
 *
 * 1. **A longer window.** See THIRD_WINDOW.
 * 2. **Band power, not the loudest bin.** A third-octave band is 23% of its
 *    centre frequency wide, so the top band spans 790 bins and the bottom one a
 *    single bin. Scoring by peak bin would hand the treble an 800:1 advantage on
 *    anything noise-like. Summing power over the band is what a real analyser
 *    integrates, and it has the property the grid's TILT was hand-tuned to fake:
 *    pink noise — which broadcast music approximates — reads flat, because band
 *    power is bandwidth times PSD and pink PSD falls exactly as bandwidth rises.
 *    So there is no tilt constant here. The summation is the tilt.
 * 3. **A dB scale.** Five green steps did not justify one; fourteen half-block
 *    steps do, and bars are the shape people read logarithmically anyway.
 */

import { MAX_BAR, THIRDS, THIRD_EDGES } from "../shared/protocol"
import { SAMPLE_RATE, fft } from "./spectrum"

/**
 * 8192 samples — 170 ms, 5.86 Hz per bin.
 *
 * The band plan sets this, not taste. The 20 Hz band spans 17.8-22.4 Hz, all of
 * 4.6 Hz wide; at the grid's 23.4 Hz per bin the bottom seven bands would all
 * read the same one or two bins and move in lockstep — a rainbow welded
 * together at the left, which is a lie about the audio. At 8192 every band from
 * 20 Hz up gets bins of its own and none are shared. Going on to 16384 buys no
 * further separation and smears a snare across a third of a second.
 */
export const THIRD_WINDOW = 8192
const ATTACK = 0.6
const RELEASE = 0.15
const AGC_WINDOW_MS = 3_000
const AGC_FLOOR = 1e-6
/**
 * Displayed dynamic range below the rolling peak. 48 dB over fourteen
 * half-block steps is ~3.4 dB a step: wide enough that a fade still moves the
 * bars, tight enough that room tone does not fill the display.
 */
const RANGE_DB = 48
/**
 * Absolute gate. Amplitudes here are normalised so a full-scale sine reads 1.0,
 * which makes this exactly -90 dBFS: dither and denormals stay dark instead of
 * being normalised up into a full rainbow.
 */
const SILENCE = 3e-5
/** Hann coherent gain: a full-scale sine puts WINDOW/4 into its bin. */
const FULL_SCALE = THIRD_WINDOW / 4

export class ThirdOctave {
  /** The last THIRD_WINDOW samples. The tap hands over ~1600 per tick, so a frame is 5 ticks of history. */
  private readonly ring = new Float32Array(THIRD_WINDOW)
  private head = 0
  private readonly hann: Float32Array
  private readonly re = new Float32Array(THIRD_WINDOW)
  private readonly im = new Float32Array(THIRD_WINDOW)
  private readonly smoothed = new Float64Array(THIRDS)
  private readonly lo = new Int32Array(THIRDS)
  private readonly hi = new Int32Array(THIRDS)
  private peak = AGC_FLOOR

  constructor() {
    this.hann = new Float32Array(THIRD_WINDOW)
    for (let i = 0; i < THIRD_WINDOW; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (THIRD_WINDOW - 1))
    }
    // Rounded and made exclusive, the same convention as the grid's edges: bands
    // that share a bin would move together, and adjacent thirds are only 12%
    // apart, so an off-by-one bin here is visible as two bars locked in step.
    const binHz = SAMPLE_RATE / THIRD_WINDOW
    const nyquistBin = THIRD_WINDOW / 2
    for (let b = 0; b < THIRDS; b++) {
      const lo = Math.max(1, Math.round(THIRD_EDGES[b] / binHz))
      this.lo[b] = lo
      this.hi[b] = Math.min(nyquistBin - 1, Math.max(lo, Math.round(THIRD_EDGES[b + 1] / binHz) - 1))
    }
  }

  /** Decay toward silence when the tap has nothing, so bars fall rather than freeze. */
  idle(dtMs: number): number[] {
    const k = Math.min(1, (RELEASE * dtMs) / 33)
    for (let b = 0; b < THIRDS; b++) this.smoothed[b] *= 1 - k
    this.peak = Math.max(this.peak * Math.exp(-dtMs / AGC_WINDOW_MS), AGC_FLOOR)
    return this.scale()
  }

  /** @param frames mono samples; any length, appended to the rolling window. */
  push(frames: Float32Array): number[] {
    this.append(frames)
    this.window()

    fft(this.re, this.im)

    let frameMax = 0
    for (let b = 0; b < THIRDS; b++) {
      let power = 0
      for (let k = this.lo[b]; k <= this.hi[b]; k++) {
        power += this.re[k] * this.re[k] + this.im[k] * this.im[k]
      }
      const amp = Math.sqrt(power) / FULL_SCALE
      if (amp > frameMax) frameMax = amp
      const prev = this.smoothed[b]
      this.smoothed[b] = amp > prev ? prev + (amp - prev) * ATTACK : prev + (amp - prev) * RELEASE
    }

    // one rolling-max AGC shared by all 31 bands, as the grid does: a quiet
    // station still fills the display, and a loud band still reads as louder
    this.peak = Math.max(frameMax, this.peak * Math.exp(-33 / AGC_WINDOW_MS), AGC_FLOOR)
    return this.scale()
  }

  private append(frames: Float32Array): void {
    // Only the newest THIRD_WINDOW samples can survive the copy, so a tap read
    // larger than the window is trimmed rather than wrapped over itself.
    const start = Math.max(0, frames.length - THIRD_WINDOW)
    for (let i = start; i < frames.length; i++) {
      this.ring[this.head] = frames[i]
      this.head = (this.head + 1) % THIRD_WINDOW
    }
  }

  /** Copy the ring out oldest-first, windowed, into the FFT buffers. */
  private window(): void {
    this.im.fill(0)
    for (let i = 0; i < THIRD_WINDOW; i++) {
      this.re[i] = this.ring[(this.head + i) % THIRD_WINDOW] * this.hann[i]
    }
  }

  private scale(): number[] {
    const out: number[] = new Array(THIRDS)
    const live = this.peak > SILENCE
    for (let b = 0; b < THIRDS; b++) {
      if (!live || this.smoothed[b] <= 0) {
        out[b] = 0
        continue
      }
      const db = 20 * Math.log10(this.smoothed[b] / this.peak)
      const frac = 1 + db / RANGE_DB
      out[b] = Math.round(MAX_BAR * Math.max(0, Math.min(1, frac)))
    }
    return out
  }
}
