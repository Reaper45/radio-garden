import { SOCKET_PATH, createLineDecoder, encode, type DaemonMessage } from "../src/shared/protocol"
import { search, getPlaceStations } from "../src/api/client"

const hits = await search(process.argv[2] ?? "kutx")
const station = hits.find(h => h.station)!.station!
const siblings = await getPlaceStations(station.placeId)
console.log(`playing ${station.title} (${station.placeTitle}), ${siblings.length} siblings`)

const blocks = " ▁▂▃▄▅▆▇█"
let barFrames = 0, nonZeroFrames = 0
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
  } else if (m.t === "bars") {
    barFrames++
    if (m.bars.some(b => b > 0)) nonZeroFrames++
    if (barFrames % 15 === 0) console.log("  " + m.bars.map(b => blocks[b]).join(""))
  }
})
sock.write(encode({ t: "subscribe" }))
sock.write(encode({ t: "playStation", station, siblings }))

setTimeout(() => {
  console.log(`\nbar frames: ${barFrames}, with signal: ${nonZeroFrames}`)
  console.log("--- next station ---")
  sock.write(encode({ t: "next" }))
}, 9000)

setTimeout(() => {
  console.log(`\ntotal bar frames: ${barFrames}, with signal: ${nonZeroFrames}`)
  sock.write(encode({ t: "stop" }))
  setTimeout(() => { sock.end(); process.exit(nonZeroFrames > 30 ? 0 : 1) }, 700)
}, 17000)
