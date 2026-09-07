import { BANDS, MAX_BAR, THIRDS, THIRD_LABELS } from "../shared/protocol"

/**
 * The 1/3-octave bar analyser (D19) — the other half of the `s` toggle.
 *
 * Where the contribution graph is a spectrogram that scrolls, this is an
 * instantaneous readout: 31 ISO bands across the panel, each a fixed hue, height
 * carrying the signal. Nothing here keeps history, which is the point — the two
 * modes answer different questions about the same audio.
 */

/**
 * Bars occupy the same rows the grid does. The now-playing box is a fixed
 * NOW_HEIGHT, so a mode that wanted its own row count would resize the panel
 * under the station list every time you pressed `s`.
 */
export const BAR_ROWS = BANDS
/** Half-block glyphs put two steps in every row. */
export const BAR_STEPS = BAR_ROWS * 2

export const FULL = "█"
export const HALF = "▄"
const CAP_UPPER = "▀"
const CAP_LOWER = "▄"
const BASE = "▁"

/** Red at 20 Hz through to violet at 20 kHz — stopping short of wrapping back to red. */
const HUE_SPAN = 285

function hslHex(hue: number, sat: number, light: number): string {
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  const rgb =
    hue < 60 ? [c, x, 0]
    : hue < 120 ? [x, c, 0]
    : hue < 180 ? [0, c, x]
    : hue < 240 ? [0, x, c]
    : hue < 300 ? [x, 0, c]
    : [c, 0, x]
  return "#" + rgb.map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("")
}

const hueFor = (band: number) => (HUE_SPAN * band) / (THIRDS - 1)

/**
 * Even out perceived brightness across the sweep.
 *
 * At one lightness for every hue, yellow glares and blue disappears, and on a
 * row of 31 bars that reads as a loudness curve baked into the frequency axis —
 * exactly the misreading the display exists to prevent. Lifting the hues the eye
 * finds dark (red, blue) and dropping the ones it finds bright (yellow, green)
 * costs nothing and keeps every bar equally legible.
 */
const lightFor = (hue: number) => 0.55 + 0.08 * Math.cos(((hue + 60) * Math.PI) / 180)

/** The bar itself. */
export const BAR_COLORS: string[] = Array.from({ length: THIRDS }, (_, b) =>
  hslHex(hueFor(b), 0.85, lightFor(hueFor(b))),
)
/** The falling peak marker: the same hue, washed out, so it reads as a trace of the bar. */
export const BAR_PEAK_COLORS: string[] = Array.from({ length: THIRDS }, (_, b) =>
  hslHex(hueFor(b), 0.55, Math.min(0.88, lightFor(hueFor(b)) + 0.28)),
)
/** The baseline tick under a silent band — present enough to show the band exists, dim enough not to read as signal. */
export const BAR_FLOOR_COLORS: string[] = Array.from({ length: THIRDS }, (_, b) =>
  hslHex(hueFor(b), 0.5, 0.2),
)

export interface BarLayout {
  /** Characters of block per bar. */
  bar: number
  /** Blank characters between bars. */
  gap: number
  /** Characters from one bar's left edge to the next. */
  pitch: number
  /** Total width the 31 bars occupy. */
  span: number
  /** Left pad that centres them in the panel. */
  pad: number
}

/** Widest first; a 100-column terminal gets 2-wide bars with gutters, an 80-column one loses the gutters. */
const SIZES = [
  { bar: 2, gap: 1 },
  { bar: 2, gap: 0 },
  { bar: 1, gap: 1 },
  { bar: 1, gap: 0 },
]

export function barLayout(innerWidth: number): BarLayout {
  for (const size of SIZES) {
    const span = THIRDS * (size.bar + size.gap) - size.gap
    if (span <= innerWidth) {
      return { ...size, pitch: size.bar + size.gap, span, pad: Math.floor((innerWidth - span) / 2) }
    }
  }
  // Narrower than 31 columns there is nothing to lay out; draw the thinnest and let it clip.
  const size = SIZES[SIZES.length - 1]
  return { ...size, pitch: 1, span: THIRDS, pad: 0 }
}

const WIDEST_LABEL = Math.max(...THIRD_LABELS.map((l) => l.length))

export interface RulerMark {
  band: number
  /** Column the label starts at, already nudged clear of its neighbour. */
  at: number
  text: string
}

/**
 * The frequency ruler under the bars.
 *
 * Labelling every third band is an octave ruler, because three thirds are an
 * octave: 20, 40, 80, 160, 315, 630, 1.25k, 2.5k, 5k, 10k, 20k. Only the
 * thinnest layout cannot fit those, and it falls back to two octaves a mark.
 */
export function rulerMarks(layout: BarLayout): RulerMark[] {
  const stride = stridefor(layout)
  const marks: RulerMark[] = []
  let end = 0
  for (let band = 0; band < THIRDS; band += stride) {
    const text = THIRD_LABELS[band]
    const centre = layout.pad + band * layout.pitch + Math.floor((layout.bar - 1) / 2)
    // centred under its bar, but never overlapping the label before it
    const at = Math.max(end === 0 ? 0 : end + 1, centre - Math.floor(text.length / 2))
    marks.push({ band, at, text })
    end = at + text.length
  }
  return marks
}

function stridefor(layout: BarLayout): number {
  return 3 * layout.pitch >= WIDEST_LABEL + 1 ? 3 : 6
}

/** Hold before a peak marker starts to fall, and how fast it falls once it does. */
const PEAK_HOLD_MS = 700
const PEAK_FALL_STEPS_PER_S = 9

/**
 * Bar heights and their falling peak markers.
 *
 * The daemon has already smoothed and normalised, so there is no filtering here
 * — only the peak-hold, which has to live client-side because it is measured in
 * half-block steps and the wire format deliberately knows nothing about rows.
 */
export class BarSpectrum {
  private readonly steps = new Float64Array(THIRDS)
  private readonly peaks = new Float64Array(THIRDS)
  private readonly heldUntil = new Float64Array(THIRDS)
  private lastAt = 0

  clear(): void {
    this.steps.fill(0)
    this.peaks.fill(0)
    this.heldUntil.fill(0)
    this.lastAt = 0
  }

  push(thirds: number[], now = Date.now()): void {
    const dt = this.lastAt ? Math.max(0, now - this.lastAt) : 0
    this.lastAt = now
    for (let b = 0; b < THIRDS; b++) {
      const level = Math.max(0, Math.min(MAX_BAR, thirds[b] ?? 0))
      const height = (level / MAX_BAR) * BAR_STEPS
      this.steps[b] = height
      if (height >= this.peaks[b]) {
        this.peaks[b] = height
        this.heldUntil[b] = now + PEAK_HOLD_MS
      } else if (now >= this.heldUntil[b]) {
        this.peaks[b] = Math.max(height, this.peaks[b] - (PEAK_FALL_STEPS_PER_S * dt) / 1000)
      }
    }
  }

  /** Filled half-steps for band b, 0..BAR_STEPS. */
  height(band: number): number {
    return Math.round(this.steps[band])
  }

  /** The peak marker's half-step, or 0 when the bar is already at its own peak. */
  peak(band: number): number {
    const peak = Math.round(this.peaks[band])
    return peak > this.height(band) ? peak : 0
  }

  /** Bands showing signal — the analyser's answer to the grid's block count. */
  get lit(): number {
    let n = 0
    for (let b = 0; b < THIRDS; b++) if (this.height(b) > 0) n++
    return n
  }

  /**
   * One cell of one bar, as a glyph and the colour to paint it.
   *
   * `over` is a background colour for the one case where the peak marker lands
   * in the same cell as the bar's own half block: the marker takes the upper
   * half of the cell and the bar shows through the lower half.
   */
  cell(band: number, fromBottom: number): { glyph: string; fg: string; over?: string } {
    const filled = Math.max(0, Math.min(2, this.height(band) - fromBottom * 2))
    if (filled === 2) return { glyph: FULL, fg: BAR_COLORS[band] }

    const peak = this.peak(band)
    if (peak > 0 && Math.floor((peak - 1) / 2) === fromBottom) {
      const upper = (peak - 1) % 2 === 1
      if (filled === 0) return { glyph: upper ? CAP_UPPER : CAP_LOWER, fg: BAR_PEAK_COLORS[band] }
      if (upper) return { glyph: CAP_UPPER, fg: BAR_PEAK_COLORS[band], over: BAR_COLORS[band] }
    }
    if (filled === 1) return { glyph: HALF, fg: BAR_COLORS[band] }
    // A silent band still shows where it sits: a dim tick on the floor, not a hole in the rainbow.
    if (fromBottom === 0) return { glyph: BASE, fg: BAR_FLOOR_COLORS[band] }
    return { glyph: " ", fg: BAR_COLORS[band] }
  }
}
