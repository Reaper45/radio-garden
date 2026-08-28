import { getPlaces, getPlaceStations, search, resolveStream, getGeoPlaceHint } from "../src/api/client"
const t0 = Date.now()
const places = await getPlaces()
console.log(`places: ${places.length} in ${Date.now() - t0}ms`)
const t1 = Date.now()
const places2 = await getPlaces()
console.log(`places (cached): ${places2.length} in ${Date.now() - t1}ms`)
console.log("geo:", await getGeoPlaceHint())
const hits = await search("kutx")
console.log("search 'kutx':", hits.slice(0, 3).map(h => `${h.kind}:${h.title}`).join(" | "))
const st = hits.find(h => h.station)!.station!
console.log("station:", st)
const sib = await getPlaceStations(st.placeId)
console.log(`siblings in ${st.placeTitle}: ${sib.length} ->`, sib.slice(0, 3).map(s => s.title).join(" | "))
for (const id of [st.id, "sn32jtQ6", "d_CG9gKs"]) {
  console.log(id, await resolveStream(id))
}
