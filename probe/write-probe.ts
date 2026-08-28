import { SOCKET_PATH, encode, createLineDecoder, type DaemonMessage } from "../src/shared/protocol"
import { getPlaceStations, search } from "../src/api/client"
const hits = await search("nairobi")
const placeId = hits.find(h => h.kind === "place")?.placeId ?? hits.find(h => h.station)!.station!.placeId
const siblings = await getPlaceStations(placeId)
const msg = encode({ t: "playStation", station: siblings[0], siblings })
console.log(`message size: ${Buffer.byteLength(msg)} bytes, ${siblings.length} siblings`)
const sock = await Bun.connect({
  unix: SOCKET_PATH,
  socket: { data(_s, c) { decode(c) } },
})
const decode = createLineDecoder<DaemonMessage>(m => { if (m.t === "state") console.log("<- state", m.state.play, m.state.station?.title ?? "-") })
const n1 = sock.write(encode({ t: "subscribe" }))
console.log(`subscribe: wrote ${n1} of ${Buffer.byteLength(encode({ t: "subscribe" }))}`)
const n2 = sock.write(msg)
console.log(`playStation: wrote ${n2} of ${Buffer.byteLength(msg)}  <-- TRUNCATED IF SHORT`)
setTimeout(() => { sock.end(); process.exit(0) }, 4000)
