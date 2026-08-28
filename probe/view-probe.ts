import { createTestRenderer } from "@opentui/core/testing"
import { View } from "../src/client/view"
import type { DaemonState, StationRef } from "../src/shared/protocol"

const station = (id: string, title: string, preroll = false): StationRef => ({
  id, title, placeId: "p1", placeTitle: "Nairobi", country: "Kenya", preroll,
})

const { renderer, captureCharFrame, renderOnce } = await createTestRenderer({ width: 74, height: 20 })
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
check("stopped state", frame, ["radio.garden", "nothing playing", "🔋 will sleep", "Akamba FM 106.5", "· ad", "q quit"], ["▇"])

// 2. playing on AC with a spectrum and now-playing
const bars = Array.from({ length: 48 }, (_, i) => (i % 9))
view.setState({ ...base, play: "playing", station: station("a", "Akamba FM 106.5"),
  nowPlaying: "Some Track — Some Artist", power: "ac", lidSafe: true })
view.setBars(bars)
view.draw(); await renderOnce()
frame = captureCharFrame()
console.log(frame)
check("playing state", frame, ["Akamba FM 106.5", "Nairobi, Kenya", "♪ Some Track", "⚡︎ lid-safe", "█"], ["🔋"])

// 3. spectrum must span the pane width
const specLine = frame.split("\n").find((l) => /[▁▂▃▄▅▆▇█]{10,}/.test(l)) ?? ""
const glyphs = (specLine.match(/[▁▂▃▄▅▆▇█ ]/g) ?? []).length
check("spectrum spans width", specLine, ["█"])
console.log(`      spectrum line: ${glyphs} cells wide`)
if (glyphs < 60) { failures++; console.log("FAIL  spectrum too narrow") }

// 4. buffering + dead-station message
view.setState({ ...base, play: "buffering", station: station("b", "Blitz FM 254", true),
  message: "skipped Akamba FM 106.5 — dead (text/plain)" })
view.setBars([])
view.draw(); await renderOnce()
frame = captureCharFrame()
check("buffering + skip message", frame, ["buffering…", "skipped Akamba FM 106.5"])

console.log(failures === 0 ? "\nall view checks passed" : `\n${failures} view check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
