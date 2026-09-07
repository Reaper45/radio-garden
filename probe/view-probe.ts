import { createTestRenderer } from "@opentui/core/testing"
import type { RGBA } from "@opentui/core"
import { View } from "../src/client/view"
import { CELL_W, COLUMN_MS, LEVEL_COLORS } from "../src/client/graph"
import { BAR_ROWS } from "../src/client/bars"
import { BANDS, MAX_BAR, THIRDS, type DaemonState, type StationRef } from "../src/shared/protocol"

/** A third-octave frame at one flat height, for tests that do not care about shape. */
const flat = (level: number) => new Array(THIRDS).fill(level)
/** Quiet at 20 Hz, full scale at 20 kHz — a shape the bars must render leaning right. */
const ramp = Array.from({ length: THIRDS }, (_, b) => Math.round(30 + (70 * b) / (THIRDS - 1)))

const station = (id: string, title: string, preroll = false): StationRef => ({
  id, title, placeId: "p1", placeTitle: "Nairobi", country: "Kenya", preroll,
})

const { renderer, captureCharFrame, captureSpans, renderOnce } = await createTestRenderer({ width: 100, height: 34 })
const view = new View(renderer)

const base: DaemonState = {
  play: "stopped", station: null, siblings: [], nowPlaying: null, via: null,
  power: "battery", lidSafe: false, message: null,
}

let failures = 0
function check(label: string, frame: string, musts: string[], mustNots: string[] = []) {
  const missing = musts.filter((m) => !frame.includes(m))
  const present = mustNots.filter((m) => frame.includes(m))
  const ok = !missing.length && !present.length
  if (!ok) failures++
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`)
  if (missing.length) console.log(`      missing: ${JSON.stringify(missing)}`)
  if (present.length) console.log(`      should not contain: ${JSON.stringify(present)}`)
}

// 1. stopped, battery
view.setState(base)
view.showStations([station("a", "Akamba FM 106.5"), station("b", "Blitz FM 254", true)], "Nairobi, Kenya")
view.draw(); await renderOnce()
let frame = captureCharFrame()
console.log(frame)
check("stopped state", frame, ["radio.garden", "nothing playing", "🔋 will sleep", "Akamba FM 106.5", "· ad", "q quit", "0 blocks in the last"])
// the empty grid is still drawn — an idle station looks like a quiet year, not a blank pane
check("empty grid present", frame, ["now", "Less", "More", "10k", "61"])

// 2. playing on AC with a scrolled-in grid and now-playing
view.setState({ ...base, play: "playing", station: station("a", "Akamba FM 106.5"),
  nowPlaying: "Some Track — Some Artist", power: "ac", lidSafe: true })
// 90 columns of synthetic frames, so history overruns the window and scrolls
const t0 = Date.now()
for (let c = 0; c < 90; c++) {
  const levels = Array.from({ length: BANDS }, (_, b) => (b + c) % 5)
  view.pushSpectrum(levels, flat(0), t0 + c * COLUMN_MS)
}
view.draw(); await renderOnce()
frame = captureCharFrame()
console.log(frame)
check("playing state", frame, ["Akamba FM 106.5", "Nairobi, Kenya", "♪ Some Track", "⚡︎ lid-safe", "██"], ["🔋"])

// 3. the grid must be seven rows of full-width cells
const gridLines = frame.split("\n").filter((l) => /(██ ){8,}/.test(l))
check("seven band rows", String(gridLines.length), [String(BANDS)])
if (gridLines.length !== BANDS) { failures++; console.log(`FAIL  ${gridLines.length} grid rows, want ${BANDS}`) }
const cellsWide = ((gridLines[0] ?? "").match(/██ /g) ?? []).length
console.log(`      grid: ${BANDS} rows x ${cellsWide} columns`)
if (cellsWide < 24) { failures++; console.log("FAIL  grid too narrow") }
// history has scrolled, so the window is full and the count reflects it
check("contribution count", frame, ["blocks in the last"], ["0 blocks in the last"])

// 3b. all five GitHub steps must actually reach the screen — captureCharFrame
// cannot see colour, and five identical-looking rows of ██ would pass without this
const hex = (c: RGBA) =>
  "#" + [...c.buffer].slice(0, 3).map((v) => v.toString(16).padStart(2, "0")).join("")
const painted = new Set<string>()
for (const line of captureSpans().lines) {
  for (const span of line.spans) if (span.text.includes("█")) painted.add(hex(span.fg))
}
const want = LEVEL_COLORS.map((c) => c.toLowerCase()).sort().join(" ")
check("five contribution levels", [...painted].sort().join(" "), [want])

// 3c. the strip slides a character at a time within a column, and the row width
// must not breathe as it does — a layout that changes width mid-slide jitters
const widths = new Set<number>()
const offsets = new Set<string>()
const slideFrom = t0 + 90 * COLUMN_MS
for (let step = 0; step < CELL_W * 2; step++) {
  view.pushSpectrum(new Array(BANDS).fill(3), flat(0), slideFrom + Math.round((step * COLUMN_MS) / CELL_W))
  view.draw(); await renderOnce()
  const row = captureCharFrame().split("\n").find((l) => l.includes("10k"))!
  const cellsOnly = row.slice(row.indexOf("10k") + 4, row.lastIndexOf("│"))
  widths.add(cellsOnly.length)
  offsets.add(cellsOnly.slice(0, CELL_W))
}
check("row width constant while sliding", String(widths.size), ["1"])
if (widths.size !== 1) { failures++; console.log(`FAIL  widths seen: ${[...widths].join(", ")}`) }
// every sub-column position must actually appear, or the slide is really a hop
check("slides through every sub-column position", String(offsets.size), [String(CELL_W)])
if (offsets.size !== CELL_W) { failures++; console.log(`FAIL  only ${offsets.size} of ${CELL_W} positions: ${JSON.stringify([...offsets])}`) }

// 4. buffering + dead-station message
view.setState({ ...base, play: "buffering", station: station("b", "Blitz FM 254", true),
  message: "skipped Akamba FM 106.5 — dead (text/plain)" })
view.draw(); await renderOnce()
frame = captureCharFrame()
check("buffering + skip message", frame, ["buffering…", "skipped Akamba FM 106.5"])

// 5. the 1/3-octave bars (D19)
view.setState({ ...base, play: "playing", station: station("a", "Akamba FM 106.5"), power: "ac", lidSafe: true })
const graphLines = captureCharFrame().split("\n").length
check("toggle reports bars", view.toggleVisual(), ["bars"])

// 5a. a frame that rises with frequency. It goes first because the bars carry no
// peak history yet, so every glyph on screen is a bar and the shape is unambiguous.
const barsAt = t0 + 200 * COLUMN_MS
view.pushSpectrum(new Array(BANDS).fill(0), ramp, barsAt)
view.draw(); await renderOnce()
frame = captureCharFrame()
console.log(frame)
// the GitHub furniture must be gone, and the analyser's own caption and octave ruler present
check("bar mode furniture", frame,
  ["1/3 octave", "31 bands", "20 Hz", "1.25k", "20k", "s graph"],
  ["Less", "More", "blocks in the last", "now"])
// the panel must not resize when the mode changes, or the station list below it jumps
check("panel height unchanged by the toggle", String(frame.split("\n").length), [String(graphLines)])
// bars grow upward: a rising frame reaches the top row only on the right, while the
// bottom row runs the full width
const sloped = frame.split("\n").filter((l) => /[█▄]/.test(l))
const firstBlock = (l: string) => l.search(/[█▄▀]/)
check("bars grow from the bottom", String(firstBlock(sloped[sloped.length - 1]) < firstBlock(sloped[0])), ["true"])

// 5b. full scale, so all seven rows are occupied and every band paints a block. At
// anything less the top rows are legitimately blank and prove nothing — and
// captureCharFrame cannot see colour, so 31 identical grey bars would pass on shape alone.
view.pushSpectrum(new Array(BANDS).fill(0), flat(MAX_BAR), barsAt + 100)
view.draw(); await renderOnce()
frame = captureCharFrame()
console.log(frame)
const barLines = frame.split("\n").filter((l) => /[█▄]/.test(l))
check("seven bar rows", String(barLines.length), [String(BAR_ROWS)])
const barHues = new Set<string>()
for (const line of captureSpans().lines) {
  for (const span of line.spans) if (/[█▄▀]/.test(span.text)) barHues.add(hex(span.fg))
}
console.log(`      ${barHues.size} distinct bar colours`)
if (barHues.size !== THIRDS) { failures++; console.log(`FAIL  ${barHues.size} bar colours, want ${THIRDS}`) }

// 5c. a band that drops must leave its peak marker behind, above the bar
view.pushSpectrum(new Array(BANDS).fill(0), flat(10), barsAt + 200)
view.draw(); await renderOnce()
const marks = captureSpans().lines.flatMap((l) => l.spans).filter((s) => s.text.includes("▀"))
check("peak markers survive a drop", String(marks.length > 0), ["true"])

// 5d. and `s` must put the contribution graph back exactly as it was
check("toggle returns to the graph", view.toggleVisual(), ["graph"])
view.draw(); await renderOnce()
frame = captureCharFrame()
check("graph restored", frame, ["Less", "More", "10k", "now", "s bars"], ["1/3 octave"])

// 6. the panel must fit the terminal at every height.
//
// It used to be a hard 14 rows. Below 18 the header, panel, list and footer no
// longer fit together and the surplus ran off the bottom of the screen — which a
// terminal answers by scrolling, so the top of the app went into scrollback and a
// scrollbar appeared. Rows are given up now instead, and this is the guard.
for (const visual of ["graph", "bars"] as const) {
  const overflows: string[] = []
  for (let height = 4; height <= 40; height++) {
    const t = await createTestRenderer({ width: 100, height })
    const v = new View(t.renderer)
    v.setVisual(visual)
    v.setState({ ...base, play: "playing", station: station("a", "Akamba FM 106.5") })
    v.showStations(Array.from({ length: 60 }, (_, i) => station(`s${i}`, `Station ${i}`)), "Nairobi, Kenya")
    v.pushSpectrum(new Array(BANDS).fill(3), flat(70), Date.now())
    v.draw()
    await t.renderOnce()
    const depth = deepest(t.renderer.root)
    if (depth > height) overflows.push(`${height}→${depth}`)
  }
  check(`${visual} fits every height 4-40`, overflows.join(" ") || "none", ["none"])
}

/** The lowest screen row any visible renderable reaches. */
function deepest(node: any): number {
  let d = node.y + node.height
  for (const child of node.getChildren?.() ?? []) {
    if (child.visible !== false) d = Math.max(d, deepest(child))
  }
  return d
}

console.log(failures === 0 ? "\nall view checks passed" : `\n${failures} view check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
