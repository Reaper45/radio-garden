/**
 * Tap PCM -> contribution-graph levels.
 *
 * The visualiser is a scrolling spectrogram drawn as a GitHub contribution
 * graph, so a frame is BANDS levels (0..MAX_LEVEL), not bar heights: one cell
 * per frequency row. The client stacks frames into columns over time
 * (client/graph.ts). Band geometry lives in shared/protocol.ts because both
 * ends need it.
 *
 * FFT parameters are from INTENT §3 "FFT parameters". The engine runs at
 * 48 kHz, so the window is 2048 rather than 1024: at 48 kHz a 1024 window
 * resolves only 46.9 Hz per bin, which smears the bass register into two or
 * three bins.
 */

import { BAND_EDGES, BANDS, MAX_LEVEL } from "../shared/protocol"

export const WINDOW = 2048
export const SAMPLE_RATE = 48_000
const ATTACK = 0.6
const RELEASE = 0.15
const AGC_WINDOW_MS = 3_000
const AGC_FLOOR = 1e-4
/**
 * Spectral tilt, as an exponent on band centre frequency.
 *
 * Music falls off roughly 4.5 dB per octave, so against a single global peak
 * the bass rows sit at level 4 and the treble rows stay empty — a grid with two
 * dead rows at the top is not worth drawing. This lifts the high bands by about
 * 4.7x across the range: enough that every row carries something, short of the
 * full flattening that would make everything look like white noise. Bands are
 * still scored against one shared peak, so a cell means the same thing in every
 * row and a loud band still reads as louder than a quiet one.
 */
const TILT = 0.3
/**
 * Absolute gate. Magnitudes here are sqrt(FFT bin), and this window puts a
 * full-scale sine near 16, so 0.05 sits around -100 dBFS: dither and denormals
 * stay dark instead of being normalised up into a full grid.
 */
const SILENCE = 0.05
/** norm >= LEVEL_AT[i] lights level i + 1. */
const LEVEL_AT = [0.08, 0.3, 0.55, 0.8]

/** In-place iterative radix-2 FFT. `re`/`im` must be length 2^k. */
function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k]
        const ai = im[i + k]
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ar + br
        im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br
        im[i + k + len / 2] = ai - bi
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
}

export class Spectrum {
  private readonly hann: Float32Array
  private readonly re = new Float32Array(WINDOW)
  private readonly im = new Float32Array(WINDOW)
  private readonly smoothed = new Float32Array(BANDS)
  private readonly weight = new Float32Array(BANDS)
  private peak = AGC_FLOOR

  constructor() {
    this.hann = new Float32Array(WINDOW)
    for (let i = 0; i < WINDOW; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))
    }
    const centre = (b: number) => Math.sqrt(BAND_EDGES[b] * BAND_EDGES[b + 1])
    for (let b = 0; b < BANDS; b++) this.weight[b] = Math.pow(centre(b) / centre(0), TILT)
  }

  /** Decay toward silence when the tap has nothing for us, so cells fade rather than freeze. */
  idle(dtMs: number): number[] {
    const k = Math.min(1, (RELEASE * dtMs) / 33)
    for (let b = 0; b < BANDS; b++) this.smoothed[b] *= 1 - k
    this.peak = Math.max(this.peak * Math.exp(-dtMs / AGC_WINDOW_MS), AGC_FLOOR)
    return this.quantise()
  }

  /** @param frames mono samples, exactly WINDOW long (shorter is zero-padded). */
  push(frames: Float32Array): number[] {
    this.re.fill(0)
    this.im.fill(0)
    const n = Math.min(frames.length, WINDOW)
    for (let i = 0; i < n; i++) this.re[i] = frames[i] * this.hann[i]

    fft(this.re, this.im)

    const binHz = SAMPLE_RATE / WINDOW
    const nyquistBin = WINDOW / 2
    let frameMax = 0

    for (let b = 0; b < BANDS; b++) {
      // Rounded, exclusive edges: floor/ceil would overlap neighbouring bands by
      // a bin each, which at this resolution puts a bass tone in two rows at once.
      const lo = Math.max(1, Math.round(BAND_EDGES[b] / binHz))
      const hi = Math.min(nyquistBin - 1, Math.max(lo, Math.round(BAND_EDGES[b + 1] / binHz) - 1))
      let bandPeak = 0
      for (let k = lo; k <= hi; k++) {
        const mag = Math.hypot(this.re[k], this.im[k])
        if (mag > bandPeak) bandPeak = mag
      }
      // perceptual: amplitude^0.5 opens up the quiet detail without a full dB scale
      const v = Math.sqrt(bandPeak) * this.weight[b]
      if (v > frameMax) frameMax = v
      const prev = this.smoothed[b]
      this.smoothed[b] = v > prev ? prev + (v - prev) * ATTACK : prev + (v - prev) * RELEASE
    }

    // rolling-max AGC so quiet stations still fill the grid
    this.peak = Math.max(frameMax, this.peak * Math.exp(-33 / AGC_WINDOW_MS), AGC_FLOOR)
    return this.quantise()
  }

  private quantise(): number[] {
    const out: number[] = new Array(BANDS)
    const live = this.peak > SILENCE
    for (let b = 0; b < BANDS; b++) {
      const norm = live ? this.smoothed[b] / this.peak : 0
      let level = 0
      while (level < MAX_LEVEL && norm >= LEVEL_AT[level]) level++
      out[b] = level
    }
    return out
  }
}
