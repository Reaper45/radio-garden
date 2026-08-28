import { Spectrum, WINDOW, SAMPLE_RATE } from "../src/daemon/spectrum"

function tone(hz: number, amp = 0.5): Float32Array {
  const f = new Float32Array(WINDOW)
  for (let i = 0; i < WINDOW; i++) f[i] = amp * Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE)
  return f
}
const MIN = 40, MAX = 16000, N = 32
const edge = (i: number) => MIN * Math.pow(MAX / MIN, i / N)
function expectedBucket(hz: number) {
  for (let i = 0; i < N; i++) if (hz >= edge(i) && hz < edge(i + 1)) return i
  return -1
}
const blocks = " ▁▂▃▄▅▆▇█"
let pass = 0, total = 0
for (const hz of [100, 440, 1000, 4000, 10000]) {
  const s = new Spectrum(N)
  let bars: number[] = []
  for (let i = 0; i < 40; i++) bars = s.push(tone(hz))  // settle attack + AGC
  const peak = bars.indexOf(Math.max(...bars))
  const want = expectedBucket(hz)
  const ok = Math.abs(peak - want) <= 1
  total++; if (ok) pass++
  console.log(`${String(hz).padStart(5)}Hz  peak=bucket${String(peak).padStart(2)} expected=${String(want).padStart(2)} ${ok ? "OK" : "MISMATCH"}`)
  console.log(`        ${bars.map(b => blocks[b]).join("")}`)
}
// silence must decay to nothing
const s = new Spectrum(N)
for (let i = 0; i < 40; i++) s.push(tone(1000))
let idle: number[] = []
for (let i = 0; i < 120; i++) idle = s.idle(33)
const silent = idle.every(b => b === 0)
total++; if (silent) pass++
console.log(`\nidle decay -> all zero: ${silent ? "OK" : "FAIL " + idle.join(",")}`)
// full-scale noise should not clip beyond 8
const s2 = new Spectrum(N)
let noise: number[] = []
for (let i = 0; i < 40; i++) {
  const f = new Float32Array(WINDOW); for (let j = 0; j < WINDOW; j++) f[j] = Math.random() * 2 - 1
  noise = s2.push(f)
}
const inRange = noise.every(b => b >= 0 && b <= 8)
total++; if (inRange) pass++
console.log(`noise in range 0..8: ${inRange ? "OK" : "FAIL"}  max=${Math.max(...noise)}`)
console.log(`\n${pass}/${total} checks passed`)
process.exit(pass === total ? 0 : 1)
