import {
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  StyledText,
  TextRenderable,
  fg as chunk,
  type CliRenderer,
  type SelectOption,
  type TextChunk,
} from "@opentui/core"
import { BANDS, MAX_LEVEL, type DaemonState, type StationRef } from "../shared/protocol"
import { CELL, CELL_W, ContributionGraph, GUTTER, LEVEL_COLORS, columnsFor } from "./graph"

const ACCENT = "#7dd3fc"
const DIM = "#64748b"
const WARN = "#fbbf24"
const FG = "#e2e8f0"
export const BG = "#0b1020"

/** border (2) + station + place + meta + time axis + one row per band + legend. */
const NOW_HEIGHT = 2 + 3 + 1 + BANDS + 1

export type Mode = "browse" | "search"

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

  private readonly graph = new ContributionGraph()
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

    const nowBox = new BoxRenderable(renderer, {
      id: "now",
      flexDirection: "column",
      border: true,
      borderColor: DIM,
      paddingX: 1,
      height: NOW_HEIGHT,
    })
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
    if (state.play !== "playing" && this.state?.play === "playing") this.graph.clear()
    this.state = state
  }

  /** One spectrum frame. The graph folds frames into 200 ms columns itself. */
  pushSpectrum(bands: number[], now?: number): void {
    this.graph.push(bands, now)
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

  /** Cell for one level: two blocks then the gutter that keeps them reading as squares. */
  private cell(level: number): TextChunk {
    return chunk(LEVEL_COLORS[Math.max(0, Math.min(MAX_LEVEL, level))])(CELL + " ")
  }

  /** GitHub's bottom-right key, with the contribution count off to the left. */
  private legend(summary: string): StyledText {
    const width = GUTTER + this.graph.columns * CELL_W
    const key = "Less ".length + (MAX_LEVEL + 1) * CELL_W + "More".length
    const room = width - key - 1
    const text = summary.length <= room ? summary : ""
    const chunks: TextChunk[] = [chunk(DIM)(text + " ".repeat(Math.max(1, room - text.length + 1)) + "Less ")]
    for (let level = 0; level <= MAX_LEVEL; level++) chunks.push(this.cell(level))
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

    this.graph.setColumns(columnsFor(this.renderer.width - 6))
    const grid = this.graph.grid()
    for (let row = 0; row < BANDS; row++) {
      const chunks: TextChunk[] = [chunk(DIM)(this.graph.rowLabel(row))]
      for (const level of grid[row]) chunks.push(this.cell(level))
      this.gridRows[row].content = new StyledText(chunks)
    }
    this.axisText.content = this.graph.timeAxis()

    const lit = this.graph.lit
    const summary = `${lit.toLocaleString()} ${lit === 1 ? "block" : "blocks"} in the last ${this.graph.spanSeconds} seconds`
    this.legendText.content = this.legend(summary)

    if (s) {
      this.powerText.content = s.lidSafe ? "⚡︎ lid-safe" : s.power === "ac" ? "⚡︎ AC" : "🔋 will sleep"
      this.powerText.fg = s.lidSafe ? ACCENT : WARN
    }

    this.listBox.title = ` ${this.listTitle} `
    this.footer.content =
      this.mode === "search"
        ? "⏎ search   esc cancel"
        : `↑↓ move   ⏎ play   space stop   n next   / search   q quit${this.status ? `   ${this.status}` : ""}`

    this.renderer.requestRender()
  }
}
