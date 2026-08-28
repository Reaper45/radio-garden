import {
  BoxRenderable,
  InputRenderable,
  SelectRenderable,
  TextRenderable,
  type CliRenderer,
  type SelectOption,
} from "@opentui/core"
import type { DaemonState, StationRef } from "../shared/protocol"

const BLOCKS = " ▁▂▃▄▅▆▇█"
const ACCENT = "#7dd3fc"
const DIM = "#64748b"
const WARN = "#fbbf24"
const FG = "#e2e8f0"
export const BG = "#0b1020"

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
  private readonly specText: TextRenderable
  private readonly powerText: TextRenderable
  private readonly footer: TextRenderable
  private readonly listBox: BoxRenderable

  private state: DaemonState | null = null
  private bars: number[] = []
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
      height: 8,
    })
    this.stationText = new TextRenderable(renderer, { id: "station", content: "nothing playing", fg: FG })
    this.placeText = new TextRenderable(renderer, { id: "place", content: "", fg: DIM })
    this.metaText = new TextRenderable(renderer, { id: "meta", content: "", fg: WARN })
    this.specText = new TextRenderable(renderer, { id: "spec", content: "", fg: ACCENT })
    nowBox.add(this.stationText)
    nowBox.add(this.placeText)
    nowBox.add(this.metaText)
    nowBox.add(this.specText)
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
    this.state = state
  }

  setBars(bars: number[]): void {
    this.bars = bars
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

  private barWidth(): number {
    return Math.max(8, Math.min(160, this.renderer.width - 6))
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

    const w = this.barWidth()
    if (playing && this.bars.length) {
      let out = ""
      for (let i = 0; i < w; i++) {
        const b = this.bars[Math.floor((i * this.bars.length) / w)] ?? 0
        out += BLOCKS[Math.max(0, Math.min(8, b))]
      }
      this.specText.content = out
    } else {
      this.specText.content = "─".repeat(w)
    }

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
