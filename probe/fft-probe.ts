import { Spectrum, WINDOW, SAMPLE_RATE } from "../src/daemon/spectrum"
import { BAND_EDGES, BAND_LABELS, BANDS, MAX_LEVEL } from "../src/shared/protocol"

function tone(hz: number, amp = 0.5): Float32Array {
  const f = new Float32Array(WINDOW)
  for (let i = 0; i < WINDOW; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  return f
}
function expectedBand(hz: number): number {
  for (let b = 0; b < BANDS; b++) if (hz >= BAND_EDGES[b] && hz < BAND_EDGES[b + 1]) return b
  return -1
}
/** One column of the grid, highest band at the left, the way the TUI stacks it. */
const cells = "·░▒▓█"
const column = (levels: number[]) => [...levels].reverse().map((l) => cells[l]).join("")

console.log(`bands: ${BAND_LABELS.map((l, b) => `${b}:${l}Hz`).join("  ")}\n`)

let pass = 0, total = 0
function check(ok: boolean, label: string) {
  total++
  if (ok) pass++
  console.log(`${ok ? "OK      " : "MISMATCH"}  ${label}`)
}

// a tone must light its own band and only its own band
for (const hz of [100, 440, 1000, 4000, 10000]) {
  const s = new Spectrum()
  let levels: number[] = []
  for (let i = 0; i < 60; i++) levels = s.push(tone(hz)) // settle attack + running average
  const want = expectedBand(hz)
  const loudest = levels.indexOf(Math.max(...levels))
  // The immediate neighbour is allowed to glow: at 23.4 Hz per bin the Hann
  // mainlobe is wider than the low bands are, so a bass tone genuinely lands in
  // two of them. Anything two bands out is leakage and must stay dark.
  const farDark = levels.every((l, b) => Math.abs(b - want) < 2 || l <= 1)
  check(loudest === want && levels[want] === MAX_LEVEL && farDark,
    `${String(hz).padStart(5)}Hz -> band ${loudest} (expected ${want}, level ${levels[want]})  ${column(levels)}`)
}

// silence must decay to an empty grid
const s = new Spectrum()
for (let i = 0; i < 60; i++) s.push(tone(1000))
let idle: number[] = []
for (let i = 0; i < 120; i++) idle = s.idle(33)
check(idle.every((l) => l === 0), `idle decay -> empty column  ${column(idle)}`)

// digital near-silence must not be normalised up into a full grid
const s2 = new Spectrum()
let dither: number[] = []
for (let i = 0; i < 90; i++) {
  const f = new Float32Array(WINDOW)
  for (let j = 0; j < WINDOW; j++) f[j] = (Math.random() * 2 - 1) * 1e-6
  dither = s2.push(f)
}
check(dither.every((l) => l === 0), `-120 dBFS dither -> empty column  ${column(dither)}`)

// full-scale noise must stay inside the five levels and light every row
const s3 = new Spectrum()
let noise: number[] = []
for (let i = 0; i < 60; i++) {
  const f = new Float32Array(WINDOW)
  for (let j = 0; j < WINDOW; j++) f[j] = Math.random() * 2 - 1
  noise = s3.push(f)
}
check(noise.every((l) => l >= 0 && l <= MAX_LEVEL) && noise.every((l) => l > 0),
  `white noise -> all rows lit, 0..${MAX_LEVEL}  ${column(noise)}`)

// The grid is only worth drawing if audio actually scatters across the five
// levels. A stationary tone would stripe — real programme material must not.
const s4 = new Spectrum()
const scale = [220, 247, 262, 294, 330, 392, 440]
const grid: number[][] = []
let t = 0
let pending = new Array(BANDS).fill(0)
for (let frame = 0; frame < 300; frame++) {
  const f = new Float32Array(WINDOW)
  for (let i = 0; i < WINDOW; i++, t++) {
    const sec = t / SAMPLE_RATE
    const beat = (sec * 100) / 60
    const inBeat = beat % 1
    const n = Math.floor(beat) % scale.length
    const onKick = Math.floor(beat) % 2 === 0
    const kick = onKick ? Math.exp(-inBeat * 16) * Math.sin(2 * Math.PI * 55 * sec) : 0
    const snare = onKick ? 0 : 0.5 * Math.exp(-inBeat * 14) * (Math.random() * 2 - 1)
    const bass = 0.5 * Math.exp(-inBeat * 2.5) * Math.sin(Math.PI * scale[n] * sec)
    const chord = 0.2 * Math.exp(-inBeat * 1.5) *
      (Math.sin(2 * Math.PI * scale[n] * sec) + Math.sin(4 * Math.PI * scale[(n + 2) % scale.length] * sec))
    const lead = 0.18 * Math.sin(2 * Math.PI * (900 + 500 * Math.sin(sec * 1.7)) * sec) * (0.5 + 0.5 * Math.sin(sec * 3))
    const hat = inBeat > 0.5 ? 0.1 * Math.exp(-(inBeat - 0.5) * 45) * (Math.random() * 2 - 1) : 0
    // a quieter bar every fourth, so the AGC has something to chase
    f[i] = (Math.floor(beat / 4) % 4 === 3 ? 0.35 : 0.8) * (kick + snare + bass + chord + lead + hat)
  }
  const levels = s4.push(f)
  for (let b = 0; b < BANDS; b++) pending[b] = Math.max(pending[b], levels[b])
  if (frame % 6 === 5) {
    grid.push(pending)
    pending = new Array(BANDS).fill(0)
  }
}
console.log("\n10 s of synthetic programme material:")
for (let row = 0; row < BANDS; row++) {
  const band = BANDS - 1 - row
  console.log(`  ${BAND_LABELS[band].padStart(4)} ${grid.map((c) => cells[c[band]]).join("")}`)
}
const flat = grid.flat()
const histogram = Array.from({ length: MAX_LEVEL + 1 }, (_, l) => flat.filter((v) => v === l).length)
// no level may be rare enough to look like an accident, and no row may be flat
const spread = histogram.every((n) => n > flat.length / 40)
const rowsVary = Array.from({ length: BANDS }, (_, b) => new Set(grid.map((c) => c[b])).size >= 3)
check(spread && rowsVary.every(Boolean),
  `all five levels in play (${histogram.map((n, l) => `${l}:${n}`).join(" ")}), every row varies`)

console.log(`\n${pass}/${total} checks passed`)
process.exit(pass === total ? 0 : 1)
