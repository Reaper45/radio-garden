import {
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  StyledText,
  TextRenderable,
  bg as chunkBg,
  fg as chunk,
  type CliRenderer,
  type SelectOption,
  type TextChunk,
} from "@opentui/core"
import { BANDS, MAX_LEVEL, THIRDS, type DaemonState, type StationRef } from "../shared/protocol"
import { CELL, CELL_W, ContributionGraph, GUTTER, LEVEL_COLORS, columnsFor } from "./graph"
import { BAR_COLORS, BAR_ROWS, BarSpectrum, barLayout, rulerMarks, type BarLayout } from "./bars"

const ACCENT = "#7dd3fc"
const DIM = "#64748b"
const WARN = "#fbbf24"
const FG = "#e2e8f0"
export const BG = "#0b1020"

/** Everything in the now-playing box that is not the visualiser: border (2) + station + place + meta, then the axis and legend lines. */
const NOW_CHROME = 2 + 3
const NOW_RULERS = 2
/** Its full height: the chrome, both rulers, and one row per band. */
const NOW_HEIGHT = NOW_CHROME + NOW_RULERS + BANDS
/** The station list cannot usefully be shorter than its own border. */
const LIST_MIN = 2

export type Mode = "browse" | "search"
/** Which visualiser the now-playing panel is drawing. `s` toggles it (D19). */
export type Visual = "graph" | "bars"

/**
 * Pure view. Holds no socket and makes no decisions — the wiring in tui.ts
 * feeds it state and it paints. Separated so it can be rendered and asserted
 * against headlessly (see probe/view-probe.ts).
 */
export class View {
  readonly select: SelectRenderable
  readonly input: InputRenderable

  private readonly stationText: TextRenderable
  private readonly placeText: TextRenderable
  private readonly metaText: TextRenderable
  private readonly axisText: TextRenderable
  private readonly gridRows: TextRenderable[]
  private readonly legendText: TextRenderable
  private readonly powerText: TextRenderable
  private readonly footer: TextRenderable
  private readonly listBox: BoxRenderable
  private readonly nowBox: BoxRenderable

  private readonly graph = new ContributionGraph()
  private readonly bars = new BarSpectrum()
  private visual: Visual = "graph"
  private state: DaemonState | null = null
  private listing: StationRef[] = []
  private listTitle = "loading…"
  private mode: Mode = "browse"
  private status = ""

  constructor(private readonly renderer: CliRenderer) {
    const root = new BoxRenderable(renderer, {
      id: "root",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      backgroundColor: BG,
    })
    renderer.root.add(root)

    const header = new BoxRenderable(renderer, {
      id: "header",
      flexDirection: "row",
      justifyContent: "space-between",
      paddingX: 1,
      height: 1,
    })
    header.add(new TextRenderable(renderer, { id: "title", content: "radio.garden", fg: ACCENT }))
    this.powerText = new TextRenderable(renderer, { id: "power", content: "", fg: DIM })
    header.add(this.powerText)
    root.add(header)

    const nowBox = (this.nowBox = new BoxRenderable(renderer, {
      id: "now",
      flexDirection: "column",
      border: true,
      borderColor: DIM,
      paddingX: 1,
      height: NOW_HEIGHT,
    }))
    this.stationText = new TextRenderable(renderer, { id: "station", content: "nothing playing", fg: FG })
    this.placeText = new TextRenderable(renderer, { id: "place", content: "", fg: DIM })
    this.metaText = new TextRenderable(renderer, { id: "meta", content: "", fg: WARN })
    this.axisText = new TextRenderable(renderer, { id: "axis", content: "", fg: DIM })
    this.gridRows = Array.from(
      { length: BANDS },
      (_, row) => new TextRenderable(renderer, { id: `grid${row}`, content: "" }),
    )
    this.legendText = new TextRenderable(renderer, { id: "legend", content: "", fg: DIM })
    nowBox.add(this.stationText)
    nowBox.add(this.placeText)
    nowBox.add(this.metaText)
    nowBox.add(this.axisText)
    for (const row of this.gridRows) nowBox.add(row)
    nowBox.add(this.legendText)
    root.add(nowBox)

    this.listBox = new BoxRenderable(renderer, {
      id: "listbox",
      flexDirection: "column",
      flexGrow: 1,
      border: true,
      borderColor: DIM,
      paddingX: 1,
    })
    this.input = new InputRenderable(renderer, {
      id: "search",
      placeholder: "search stations or places…",
      visible: false,
    })
    this.select = new SelectRenderable(renderer, {
      id: "list",
      flexGrow: 1,
      options: [],
      showDescription: true,
      wrapSelection: true,
      selectedBackgroundColor: ACCENT,
      selectedTextColor: BG,
      descriptionColor: DIM,
    })
    this.listBox.add(this.input)
    this.listBox.add(this.select)
    root.add(this.listBox)

    this.footer = new TextRenderable(renderer, { id: "footer", content: "", fg: DIM, height: 1, paddingX: 1 })
    root.add(this.footer)
  }

  get stations(): StationRef[] {
    return this.listing
  }

  setState(state: DaemonState): void {
    // An idle station gets an empty grid, the way a quiet year does — not a
    // frozen snapshot of whatever was playing when it stopped.
    if (state.play !== "playing" && this.state?.play === "playing") {
      this.graph.clear()
      this.bars.clear()
    }
    this.state = state
  }

  /**
   * One spectrum frame, feeding both visualisers.
   *
   * Both are kept current whichever is on screen, so `s` cuts straight to a live
   * display instead of a blank one that has to fill or settle.
   */
  pushSpectrum(bands: number[], thirds: number[], now?: number): void {
    this.graph.push(bands, now)
    this.bars.push(thirds, now)
  }

  get visualiser(): Visual {
    return this.visual
  }

  setVisual(visual: Visual): void {
    this.visual = visual
  }

  toggleVisual(): Visual {
    this.visual = this.visual === "graph" ? "bars" : "graph"
    return this.visual
  }

  setStatus(status: string): void {
    this.status = status
  }

  setMode(mode: Mode): void {
    this.mode = mode
    this.input.visible = mode === "search"
    if (mode === "search") this.input.focus()
    else {
      this.input.blur()
      this.select.focus()
    }
  }

  showStations(stations: StationRef[], title: string): void {
    this.listing = stations
    this.listTitle = title
    this.select.options = stations.map<SelectOption>((s) => ({
      name: s.title,
      description: [s.placeTitle, s.country].filter(Boolean).join(", ") + (s.preroll ? "  · ad" : ""),
      value: s.id,
    }))
  }

  /** A full cell: two blocks then the gutter that keeps them reading as squares. */
  private static readonly CELL_TEXT = CELL + " "

  /** `text` is a slice of a cell — the strip's end cells are cut mid-square as it slides. */
  private paint(level: number, text = View.CELL_TEXT): TextChunk {
    return chunk(LEVEL_COLORS[Math.max(0, Math.min(MAX_LEVEL, level))])(text)
  }

  /** GitHub's bottom-right key, with the contribution count off to the left. */
  private legend(summary: string): StyledText {
    const width = GUTTER + this.graph.columns * CELL_W
    const key = "Less ".length + (MAX_LEVEL + 1) * CELL_W + "More".length
    const room = width - key - 1
    const text = summary.length <= room ? summary : ""
    const chunks: TextChunk[] = [chunk(DIM)(text + " ".repeat(Math.max(1, room - text.length + 1)) + "Less ")]
    for (let level = 0; level <= MAX_LEVEL; level++) chunks.push(this.paint(level))
    chunks.push(chunk(DIM)("More"))
    return new StyledText(chunks)
  }

  draw(): void {
    const s = this.state
    const playing = s?.play === "playing"

    this.stationText.content = s?.station ? s.station.title : "nothing playing"
    this.placeText.content = s?.station
      ? `${s.station.placeTitle}, ${s.station.country}`
      : "pick a station below"

    const bits: string[] = []
    if (s?.play === "resolving") bits.push("resolving…")
    if (s?.play === "buffering") bits.push("buffering…")
    if (s?.nowPlaying) bits.push(`♪ ${s.nowPlaying}`)
    if (s?.station?.preroll && !s.nowPlaying && playing) bits.push("(ad may play first)")
    if (s?.message) bits.push(s.message)
    this.metaText.content = bits.join("   ")

    // The panel is sized before it is painted: a terminal too short for the full
    // seven rows must lose rows, not push the footer past the bottom of the screen.
    const { rows, rulers, show } = this.fitPanel()
    this.nowBox.visible = show
    this.nowBox.height = NOW_CHROME + (rulers ? NOW_RULERS : 0) + rows
    this.axisText.visible = rulers
    this.legendText.visible = rulers
    // Rows are dropped from the top, so the grid keeps its bass rows and its row
    // labels stay attached to the bands they name.
    const firstRow = BANDS - rows
    for (let row = 0; row < BANDS; row++) this.gridRows[row].visible = row >= firstRow
    if (show && rows > 0) {
      if (this.visual === "bars") this.drawBars(rows, firstRow)
      else this.drawGraph(rows, firstRow)
    }

    if (s) {
      this.powerText.content = s.lidSafe ? "⚡︎ lid-safe" : s.power === "ac" ? "⚡︎ AC" : "🔋 will sleep"
      this.powerText.fg = s.lidSafe ? ACCENT : WARN
    }

    this.listBox.title = ` ${this.listTitle} `
    this.footer.content =
      this.mode === "search"
        ? "⏎ search   esc cancel"
        : `↑↓ move   ⏎ play   space stop   n next   s ${this.visual === "graph" ? "bars" : "graph"}   / search   q quit${this.status ? `   ${this.status}` : ""}`

    this.renderer.requestRender()
  }

  /**
   * How much of the now-playing panel this terminal can afford.
   *
   * The box used to be a hard NOW_HEIGHT. Below 18 rows that does not fit
   * alongside the header, the station list and the footer, and the overflow runs
   * off the bottom of the screen — which a terminal answers by scrolling, so the
   * top of the app disappears into scrollback and a scrollbar appears. Rows are
   * given up instead, then the rulers, then the panel itself.
   */
  private fitPanel(): { rows: number; rulers: boolean; show: boolean } {
    const spare = this.renderer.height - 1 /* header */ - 1 /* footer */ - LIST_MIN
    if (spare >= NOW_CHROME + NOW_RULERS + 1) {
      return { rows: Math.min(BANDS, spare - NOW_CHROME - NOW_RULERS), rulers: true, show: true }
    }
    // Tighter than that, the bars are worth more than the scales beside them.
    if (spare >= NOW_CHROME) {
      return { rows: Math.min(BANDS, spare - NOW_CHROME), rulers: false, show: true }
    }
    return { rows: 0, rulers: false, show: false }
  }

  /** The contribution graph: a spectrogram of the last minute, sliding left. */
  private drawGraph(rows: number, firstRow: number): void {
    this.graph.setColumns(columnsFor(this.renderer.width - 6))
    const strip = this.graph.strip()
    // Slide the strip left by a sub-column offset and clip it back to width. The
    // leading square is cut short and the trailing one is only partly drawn, so
    // the grid drifts a character at a time instead of hopping a whole cell.
    const offset = this.graph.offsetChars()
    const last = strip[0].length - 1
    for (let row = firstRow; row < BANDS; row++) {
      const chunks: TextChunk[] = [chunk(DIM)(this.graph.rowLabel(row))]
      for (let col = 0; col <= last; col++) {
        const text =
          col === 0 ? View.CELL_TEXT.slice(offset)
          : col === last ? View.CELL_TEXT.slice(0, offset)
          : View.CELL_TEXT
        if (text) chunks.push(this.paint(strip[row][col], text))
      }
      this.gridRows[row].content = new StyledText(chunks)
    }
    // The time scale does not slide: the data flows underneath a fixed ruler.
    this.axisText.content = this.graph.timeAxis()

    const lit = this.graph.lit
    const summary = `${lit.toLocaleString()} ${lit === 1 ? "block" : "blocks"} in the last ${this.graph.spanSeconds} seconds`
    this.legendText.content = this.legend(summary)
  }

  /**
   * The 1/3-octave analyser (D19): 31 ISO bands as bars, red at 20 Hz to violet
   * at 20 kHz, in the same seven rows the grid uses. Two half-block glyphs per
   * row give fourteen steps of height, and a falling marker holds each band's
   * recent peak.
   */
  private drawBars(rows: number, firstRow: number): void {
    const layout = barLayout(this.renderer.width - 6)
    const lead = " ".repeat(layout.pad)
    const gutter = " ".repeat(layout.gap)
    for (let row = firstRow; row < BAR_ROWS; row++) {
      // Bars grow upward, so the bottom row is the one drawn last.
      const fromBottom = BAR_ROWS - 1 - row
      const chunks: TextChunk[] = []
      if (lead) chunks.push(chunk(DIM)(lead))
      for (let band = 0; band < THIRDS; band++) {
        // a narrow terminal drops the gutter entirely rather than shrinking the bars
        if (band && gutter) chunks.push(chunk(DIM)(gutter))
        const cell = this.bars.cell(band, fromBottom, rows)
        const text = cell.glyph.repeat(layout.bar)
        // `over` marks the one cell where the peak marker and the bar's own half
        // block collide: the marker takes the top half, the bar shows underneath.
        chunks.push(cell.over ? chunkBg(cell.over)(chunk(cell.fg)(text)) : chunk(cell.fg)(text))
      }
      this.gridRows[row].content = new StyledText(chunks)
    }
    this.axisText.content = this.caption(this.renderer.width - 6)
    this.legendText.content = this.ruler(layout)
  }

  /**
   * The line above the bars. It drops detail rather than wrapping: the box is a
   * fixed NOW_HEIGHT, so a caption that runs to two lines pushes a row of bars
   * out of the panel.
   */
  private caption(width: number): string {
    const lit = this.bars.lit
    const options = [
      `1/3 octave · ${THIRDS} bands · 20 Hz – 20 kHz · ${lit} above the floor`,
      `1/3 octave · ${THIRDS} bands · 20 Hz – 20 kHz`,
      `1/3 octave · ${THIRDS} bands`,
      "1/3 octave",
    ]
    return options.find((o) => o.length <= width) ?? ""
  }

  /** Octave marks under the bars, each painted in its own band's hue so the ruler doubles as the colour key. */
  private ruler(layout: BarLayout): StyledText {
    const chunks: TextChunk[] = []
    let at = 0
    for (const mark of rulerMarks(layout)) {
      if (mark.at > at) chunks.push(chunk(DIM)(" ".repeat(mark.at - at)))
      chunks.push(chunk(BAR_COLORS[mark.band])(mark.text))
      at = mark.at + mark.text.length
    }
    return new StyledText(chunks)
  }
}
