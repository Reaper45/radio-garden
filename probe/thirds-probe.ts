import { ThirdOctave, THIRD_WINDOW } from "../src/daemon/thirds"
import { SAMPLE_RATE } from "../src/daemon/spectrum"
import { MAX_BAR, THIRDS, THIRD_CENTRES, THIRD_LABELS } from "../src/shared/protocol"

/** The tap hands the daemon ~1600 samples a tick; feed the analyser the same way. */
const CHUNK = 1600
/** Enough chunks to fill the 8192-sample window several times and settle the AGC. */
const SETTLE = 40

/** Continuous-phase generator, so successive chunks join without a click. */
function stream(sample: (t: number) => number): () => Float32Array {
  let n = 0
  return () => {
    const f = new Float32Array(CHUNK)
    for (let i = 0; i < CHUNK; i++, n++) f[i] = sample(n / SAMPLE_RATE)
    return f
  }
}

function settle(next: () => Float32Array, frames = SETTLE): number[] {
  const s = new ThirdOctave()
  let bars: number[] = []
  for (let i = 0; i < frames; i++) bars = s.push(next())
  return bars
}

const RAMP = " ▁▂▃▄▅▆▇█"
const profile = (bars: number[]) =>
  bars.map((v) => RAMP[Math.min(RAMP.length - 1, Math.round((v / MAX_BAR) * (RAMP.length - 1)))]).join("")

let pass = 0
let total = 0
function check(ok: boolean, label: string) {
  total++
  if (ok) pass++
  console.log(`${ok ? "OK      " : "MISMATCH"}  ${label}`)
}

console.log(`window ${THIRD_WINDOW} samples, ${(SAMPLE_RATE / THIRD_WINDOW).toFixed(2)} Hz per bin`)
console.log(`bands: ${THIRD_LABELS.join(" ")}\n`)

// ---------------------------------------------------------------------------
// 1. Every ISO centre must own its band.
//
// This is the assertion the 8192-sample window exists for. At the grid's 2048 the
// bottom seven bands share bins and a 25 Hz tone and a 40 Hz tone light the same
// bars — the rainbow would be welded together at the left. Each tone lighting its
// own band is the proof that it is not.
//
// The tolerance is not slack, it is the Hann mainlobe. It is ~2 bins wide, and a
// third-octave band is 0.0395 * centre bins wide, so a band is wider than the
// mainlobe only above ~51 Hz. From 63 Hz up (band 5) a tone must therefore stay
// inside its band and the two either side; below it the tone is genuinely
// narrower than the analyser can resolve and spreads further, so only the peak
// is asserted there.
// ---------------------------------------------------------------------------
for (let want = 0; want < THIRDS; want++) {
  const hz = THIRD_CENTRES[want]
  const bars = settle(stream((t) => 0.5 * Math.sin(2 * Math.PI * hz * t)))
  const loudest = bars.indexOf(Math.max(...bars))
  const reach = want >= 5 ? 2 : 5
  const farQuiet = bars.every((v, b) => Math.abs(b - want) < reach || v < bars[want] - 25)
  check(
    loudest === want && farQuiet,
    `${THIRD_LABELS[want].padStart(5)} Hz -> band ${String(loudest).padStart(2)} (want ${String(want).padStart(2)}, ${String(bars[want]).padStart(3)})  ${profile(bars)}`,
  )
}

// ---------------------------------------------------------------------------
// 2. Pink noise must read flat.
//
// This is the property that let the tilt constant go. Band power is bandwidth
// times PSD; pink PSD falls at exactly the rate third-octave bandwidth rises, so
// a correct analyser draws pink noise as a flat line. Get the band summation
// wrong — score by loudest bin instead, say — and this test tilts hard.
// ---------------------------------------------------------------------------
/** Pink noise is a function of nothing but its own state, so it ignores the clock `stream` hands it. */
function pink(): () => number {
  // Paul Kellet's economy filter: white through three poles, ~ -3 dB/octave.
  let b0 = 0
  let b1 = 0
  let b2 = 0
  return () => {
    const w = Math.random() * 2 - 1
    b0 = 0.99765 * b0 + w * 0.0990460
    b1 = 0.96300 * b1 + w * 0.2965164
    b2 = 0.57000 * b2 + w * 1.0526913
    return (b0 + b1 + b2 + w * 0.1848) * 0.22
  }
}
{
  const next = pink()
  const bars = settle(stream(() => next()))
  // Bands 3..27 is 40 Hz to 10 kHz — inside both the filter's accurate range and
  // the range where a band holds more than a couple of bins.
  const mid = bars.slice(3, 28)
  const spread = Math.max(...mid) - Math.min(...mid)
  console.log(`\npink noise  ${profile(bars)}`)
  check(spread <= 20, `pink reads flat across 40 Hz-10 kHz (spread ${spread} of ${MAX_BAR}, ~${(spread * 0.48).toFixed(1)} dB)`)
}

// ---------------------------------------------------------------------------
// 3. White noise must rise toward the treble — 3 dB per octave, because flat PSD
//    times rising bandwidth is rising band power. The mirror of the test above:
//    together they show the display is integrating bands, not normalising them.
// ---------------------------------------------------------------------------
{
  const bars = settle(stream(() => Math.random() * 2 - 1))
  const low = bars.slice(3, 10).reduce((a, b) => a + b, 0) / 7
  const high = bars.slice(20, 27).reduce((a, b) => a + b, 0) / 7
  console.log(`white noise ${profile(bars)}`)
  check(high > low + 20, `white noise rises toward treble (low ${low.toFixed(0)} -> high ${high.toFixed(0)})`)
}

// ---------------------------------------------------------------------------
// 4. Silence and near-silence must empty the display, not be normalised up into
//    a full rainbow — the same trap the grid's absolute floor guards.
// ---------------------------------------------------------------------------
{
  const s = new ThirdOctave()
  const next = stream((t) => 0.5 * Math.sin(2 * Math.PI * 1000 * t))
  for (let i = 0; i < SETTLE; i++) s.push(next())
  let bars: number[] = []
  for (let i = 0; i < 200; i++) bars = s.idle(33)
  check(bars.every((v) => v === 0), `idle decay -> empty  ${profile(bars)}`)
}
{
  const bars = settle(stream(() => (Math.random() * 2 - 1) * 1e-6))
  check(bars.every((v) => v === 0), `-120 dBFS dither -> empty  ${profile(bars)}`)
}

// ---------------------------------------------------------------------------
// 5. Programme material must move. A synthetic band — kick, snare, bass line,
//    chord, lead, hats — has to light the display across its whole width and
//    keep every bar in the audible range moving, or the bars are decoration.
// ---------------------------------------------------------------------------
{
  const scale = [220, 247, 262, 294, 330, 392, 440]
  const next = stream((sec) => {
    const beat = (sec * 100) / 60
    const inBeat = beat % 1
    const n = Math.floor(beat) % scale.length
    const onKick = Math.floor(beat) % 2 === 0
    const kick = onKick ? Math.exp(-inBeat * 16) * Math.sin(2 * Math.PI * 55 * sec) : 0
    const snare = onKick ? 0 : 0.5 * Math.exp(-inBeat * 14) * (Math.random() * 2 - 1)
    const bass = 0.5 * Math.exp(-inBeat * 2.5) * Math.sin(Math.PI * scale[n] * sec)
    const chord =
      0.2 * Math.exp(-inBeat * 1.5) *
      (Math.sin(2 * Math.PI * scale[n] * sec) + Math.sin(4 * Math.PI * scale[(n + 2) % scale.length] * sec))
    const lead = 0.18 * Math.sin(2 * Math.PI * (900 + 500 * Math.sin(sec * 1.7)) * sec) * (0.5 + 0.5 * Math.sin(sec * 3))
    const hat = inBeat > 0.5 ? 0.1 * Math.exp(-(inBeat - 0.5) * 45) * (Math.random() * 2 - 1) : 0
    return (Math.floor(beat / 4) % 4 === 3 ? 0.35 : 0.8) * (kick + snare + bass + chord + lead + hat)
  })
  const s = new ThirdOctave()
  const seen = Array.from({ length: THIRDS }, () => new Set<number>())
  let bars: number[] = []
  console.log("\n10 s of synthetic programme material, a frame every 300 ms:")
  for (let i = 0; i < 300; i++) {
    bars = s.push(next())
    for (let b = 0; b < THIRDS; b++) seen[b].add(Math.round(bars[b] / 10))
    if (i % 9 === 8) console.log(`  ${profile(bars)}`)
  }
  // 40 Hz to 16 kHz is what a 128 kbps stream carries; the 20-31.5 Hz bands and
  // the 20 kHz band are outside it by design and are not required to move.
  const moving = seen.slice(3, 30).every((s) => s.size >= 3)
  const stillMoving = seen.slice(3, 30).findIndex((s) => s.size < 3)
  check(moving, `every band 40 Hz-16 kHz varies${moving ? "" : ` — band ${stillMoving + 3} (${THIRD_LABELS[stillMoving + 3]} Hz) is flat`}`)
}

console.log(`\n${pass}/${total} checks passed`)
process.exit(pass === total ? 0 : 1)
