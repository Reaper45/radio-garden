import { SOCKET_PATH, createLineDecoder, encode, type DaemonMessage } from "../src/shared/protocol"
import { MAX_BAR } from "../src/shared/protocol"
import { search, getPlaceStations } from "../src/api/client"

const hits = await search(process.argv[2] ?? "kutx")
const station = hits.find(h => h.station)!.station!
const siblings = await getPlaceStations(station.placeId)
console.log(`playing ${station.title} (${station.placeTitle}), ${siblings.length} siblings`)

const cells = "·░▒▓█"
const ramp = " ▁▂▃▄▅▆▇█"
let frames = 0, nonZeroFrames = 0, thirdFrames = 0
const sock = await Bun.connect({
  unix: SOCKET_PATH,
  socket: {
    data(_s, chunk) { decode(chunk) },
    error(_s, e) { console.log("socket error", e.message) },
  },
})
const decode = createLineDecoder<DaemonMessage>((m) => {
  if (m.t === "state") {
    console.log(`STATE play=${m.state.play} station=${m.state.station?.title ?? "-"} power=${m.state.power} lidSafe=${m.state.lidSafe} now=${m.state.nowPlaying ?? "-"} msg=${m.state.message ?? "-"}`)
  } else if (m.t === "spectrum") {
    frames++
    if (m.bands.some(b => b > 0)) nonZeroFrames++
    // both visualisers ride in one frame (D19): grid column then bar profile
    if (m.thirds.some(v => v > 0)) thirdFrames++
    if (frames % 15 === 0) {
      const column = [...m.bands].reverse().map(b => cells[b]).join("")
      const bars = m.thirds.map(v => ramp[Math.min(8, Math.round((v / MAX_BAR) * 8))]).join("")
      console.log(`  ${column}  ${bars}`)
    }
  }
})
sock.write(encode({ t: "subscribe" }))
sock.write(encode({ t: "playStation", station, siblings }))

setTimeout(() => {
  console.log(`\nspectrum frames: ${frames}, grid with signal: ${nonZeroFrames}, bars with signal: ${thirdFrames}`)
  console.log("--- next station ---")
  sock.write(encode({ t: "next" }))
}, 9000)

setTimeout(() => {
  console.log(`\ntotal spectrum frames: ${frames}, grid with signal: ${nonZeroFrames}, bars with signal: ${thirdFrames}`)
  sock.write(encode({ t: "stop" }))
  // both analysers must have produced signal — one silent half means a frame that
  // arrived half-empty, which the client would draw as a dead visualiser
  setTimeout(() => { sock.end(); process.exit(nonZeroFrames > 30 && thirdFrames > 30 ? 0 : 1) }, 700)
}, 17000)
