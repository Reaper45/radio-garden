import { BAND_LABELS, BANDS, MAX_LEVEL } from "../shared/protocol"

/**
 * A terminal cell is about twice as tall as it is wide, so two block glyphs
 * plus a one-column gutter read as a GitHub square with a gap after it.
 */
export const CELL = "██"
export const CELL_W = CELL.length + 1
/** Frequency labels down the left edge — the Mon/Wed/Fri slot. */
export const GUTTER = 4
/**
 * One column per 100 ms — but the grid does not jump a whole column at a time.
 * A column is CELL_W characters wide, so the strip slides one character every
 * COLUMN_MS / CELL_W ≈ 33 ms, which is the render tick: the squares appear to
 * drift left continuously rather than hopping three cells five times a second.
 */
export const COLUMN_MS = 100
/** A year of contributions is 53 columns; the grid never grows past that. */
export const MAX_COLUMNS = 53
/** GitHub's five steps, with an empty cell tuned to this app's background rather than #0d1117. */
export const LEVEL_COLORS = ["#161c30", "#0e4429", "#006d32", "#26a641", "#39d353"]
/** Every Nth column carries a time label, the way every fourth-or-so week carries a month. */
const LABEL_EVERY = 10

export function columnsFor(innerWidth: number): number {
  return Math.max(8, Math.min(MAX_COLUMNS, Math.floor((innerWidth - GUTTER) / CELL_W)))
}

/**
 * The scrolling history behind the grid.
 *
 * Frames arrive at 30 Hz and a column is 100 ms wide, so about three frames fold
 * into one cell. They fold by max, not mean: a snare hit that lands inside a
 * column should light it, and averaging is exactly what would erase it.
 *
 * The column currently filling is handed out too, as an extra cell past the
 * right edge. The view slides the whole strip left by `offsetChars()` and clips
 * it back to width, so that cell scrolls into view a character at a time instead
 * of appearing all at once.
 */
export class ContributionGraph {
  private cols: number[][] = []
  private pending: number[] = new Array(BANDS).fill(0)
  private openedAt = 0
  /** Timestamp of the last frame, so the scroll offset reads the same clock as the history. */
  private lastAt = 0
  private width = 24

  /** Columns adapt to terminal width, so the history window is retrimmed on resize. */
  setColumns(n: number): void {
    this.width = Math.max(1, Math.floor(n))
    this.trim()
  }

  get columns(): number {
    return this.width
  }

  /** Seconds of history the visible window covers. */
  get spanSeconds(): number {
    return Math.round((this.width * COLUMN_MS) / 1000)
  }

  /** Cells above level 0 in the visible window — the "N contributions" figure. */
  get lit(): number {
    let n = 0
    for (const col of this.cols) for (const level of col) if (level > 0) n++
    return n
  }

  clear(): void {
    this.cols = []
    this.pending.fill(0)
    this.openedAt = 0
    this.lastAt = 0
  }

  /**
   * How far the strip has slid within the column now filling, in characters.
   *
   * Rounded, not floored: frames land at 33 ms and a third of a column is
   * 33.33 ms, so flooring puts every tick just short of its step and the slide
   * comes out 0, 0, 2 — a stall then a double jump. Capped one short of a full
   * column, because the last character of the slide is what committing the
   * column does.
   */
  offsetChars(): number {
    if (!this.openedAt) return 0
    const through = (this.lastAt - this.openedAt) / COLUMN_MS
    return Math.max(0, Math.min(CELL_W - 1, Math.round(through * CELL_W)))
  }

  push(bands: number[], now = Date.now()): void {
    if (!this.openedAt) this.openedAt = now
    this.lastAt = now
    for (let b = 0; b < BANDS; b++) {
      const level = Math.max(0, Math.min(MAX_LEVEL, Math.round(bands[b] ?? 0)))
      if (level > this.pending[b]) this.pending[b] = level
    }
    // A pause longer than the whole window has nothing left to scroll in; restart
    // rather than committing hundreds of empty columns one at a time.
    if (now - this.openedAt > COLUMN_MS * this.width) {
      this.cols = []
      this.openedAt = now
      return
    }
    while (now - this.openedAt >= COLUMN_MS) {
      this.cols.push(this.pending)
      this.pending = new Array(BANDS).fill(0)
      this.openedAt += COLUMN_MS
    }
    this.trim()
  }

  private trim(): void {
    if (this.cols.length > this.width) this.cols = this.cols.slice(this.cols.length - this.width)
  }

  /**
   * `strip()[row][col]`, row 0 the highest band. Width + 1 cells: the visible
   * history, then the column still filling, which the view slides in from the
   * right. A short history left-pads with empty cells, so the graph fills in
   * from the right rather than jumping about as it grows.
   */
  strip(): number[][] {
    const pad = Math.max(0, this.width - this.cols.length)
    const visible = this.cols.slice(Math.max(0, this.cols.length - this.width))
    return Array.from({ length: BANDS }, (_, row) => {
      const band = BANDS - 1 - row
      const cells = new Array(this.width + 1).fill(0)
      for (let i = 0; i < visible.length; i++) cells[pad + i] = visible[i][band]
      cells[this.width] = this.pending[band]
      return cells
    })
  }

  /** Right-edge label for a row: three of the seven get one, as GitHub labels three days. */
  rowLabel(row: number): string {
    if (row !== 0 && row !== 3 && row !== BANDS - 1) return " ".repeat(GUTTER)
    return BAND_LABELS[BANDS - 1 - row].padStart(GUTTER - 1) + " "
  }

  /** The month-label strip: how long ago each marked column was, "now" at the right. */
  timeAxis(): string {
    const cells = new Array(GUTTER + this.width * CELL_W).fill(" ")
    const write = (at: number, text: string) => {
      for (let i = 0; i < text.length && at + i < cells.length; i++) cells[at + i] = text[i]
    }
    for (let col = this.width - 1; col >= 0; col -= LABEL_EVERY) {
      const ago = Math.round(((this.width - 1 - col) * COLUMN_MS) / 1000)
      const text = col === this.width - 1 ? "now" : `-${ago}s`
      // "now" ends at the right edge; the rest start at their column, like month labels
      const at = col === this.width - 1
        ? cells.length - text.length
        : GUTTER + col * CELL_W
      write(at, text)
    }
    return cells.join("").trimEnd()
  }
}
