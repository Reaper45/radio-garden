/**
 * Tap PCM -> ASCII bar magnitudes. Parameters are from INTENT §3 "FFT parameters".
 *
 * The engine runs at 48 kHz, so the window is 2048 rather than 1024: at 48 kHz a
 * 1024 window resolves only 46.9 Hz per bin, which smears the bass register into
 * two or three bins.
 */

export const WINDOW = 2048
export const SAMPLE_RATE = 48_000
const MIN_HZ = 40
const MAX_HZ = 16_000
const ATTACK = 0.6
const RELEASE = 0.15
const AGC_WINDOW_MS = 3_000
const AGC_FLOOR = 1e-4

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
  private smoothed: Float32Array
  private agcPeak = AGC_FLOOR
  private edges: number[] = []
  private barCount = 0

  constructor(barCount = 48) {
    this.hann = new Float32Array(WINDOW)
    for (let i = 0; i < WINDOW; i++) {
      this.hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))
    }
    this.smoothed = new Float32Array(0)
    this.setBarCount(barCount)
  }

  /** Bars adapt to terminal width, so the bucket edges are rebuilt on resize. */
  setBarCount(n: number): void {
    const count = Math.max(8, Math.min(128, Math.floor(n)))
    if (count === this.barCount) return
    this.barCount = count
    this.smoothed = new Float32Array(count)
    this.edges = []
    for (let i = 0; i <= count; i++) {
      this.edges.push(MIN_HZ * Math.pow(MAX_HZ / MIN_HZ, i / count))
    }
  }

  get bars(): number {
    return this.barCount
  }

  /** Decay toward silence when the tap has nothing for us, so bars fall rather than freeze. */
  idle(dtMs: number): number[] {
    const k = Math.min(1, (RELEASE * dtMs) / 33)
    for (let i = 0; i < this.smoothed.length; i++) this.smoothed[i] *= 1 - k
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

    for (let b = 0; b < this.barCount; b++) {
      const lo = Math.max(1, Math.floor(this.edges[b] / binHz))
      const hi = Math.min(nyquistBin - 1, Math.max(lo, Math.ceil(this.edges[b + 1] / binHz)))
      let peak = 0
      for (let k = lo; k <= hi; k++) {
        const mag = Math.hypot(this.re[k], this.im[k])
        if (mag > peak) peak = mag
      }
      // perceptual: amplitude^0.5 opens up the quiet detail without a full dB scale
      const v = Math.sqrt(peak)
      if (v > frameMax) frameMax = v
      const prev = this.smoothed[b]
      this.smoothed[b] = v > prev ? prev + (v - prev) * ATTACK : prev + (v - prev) * RELEASE
    }

    // rolling-max AGC so quiet stations still fill the display
    const decay = Math.exp(-33 / AGC_WINDOW_MS)
    this.agcPeak = Math.max(frameMax, this.agcPeak * decay, AGC_FLOOR)

    return this.quantise()
  }

  /** 0-8, matching the eight block glyphs plus blank. */
  private quantise(): number[] {
    const out: number[] = new Array(this.barCount)
    for (let i = 0; i < this.barCount; i++) {
      const norm = this.smoothed[i] / this.agcPeak
      out[i] = Math.max(0, Math.min(8, Math.round(norm * 8)))
    }
    return out
  }
}
