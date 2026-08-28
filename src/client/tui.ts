import { createCliRenderer, SelectRenderableEvents, InputRenderableEvents } from "@opentui/core"
import { connect, send, type DaemonLink } from "./connection"
import { getGeoPlaceHint, getPlaceStations, getPlaces, search, type SearchHit } from "../api/client"
import type { DaemonMessage, StationRef } from "../shared/protocol"
import { debug } from "../shared/log"
import { View, BG, type Mode } from "./view"

export async function run(): Promise<void> {
  const renderer = await createCliRenderer({ targetFps: 30, exitOnCtrlC: true, backgroundColor: BG })
  const view = new View(renderer)
  let mode: Mode = "browse"
  let bootstrapped = false

  const link: DaemonLink = await connect({
    onMessage(msg: DaemonMessage) {
      if (msg.t === "state") {
        debug("state", { play: msg.state.play, station: msg.state.station?.title })
        view.setState(msg.state)
        if (msg.state.siblings.length && view.stations.length === 0) {
          bootstrapped = true
          view.showStations(msg.state.siblings, msg.state.station?.placeTitle ?? "stations")
        }
      } else if (msg.t === "bars") {
        view.setBars(msg.bars)
      } else if (msg.t === "error") {
        view.setStatus(msg.message)
      }
      view.draw()
    },
    onClose() {
      view.setStatus("daemon disconnected")
      view.draw()
    },
  })
  send(link, { t: "subscribe" })

  view.select.on(SelectRenderableEvents.ITEM_SELECTED, (index: number) => {
    const station = view.stations[index]
    debug("ITEM_SELECTED", { index, station: station?.title })
    if (station) send(link, { t: "playStation", station, siblings: view.stations })
  })

  view.input.on(InputRenderableEvents.ENTER, (value: string) => void runSearch(value))

  async function runSearch(q: string): Promise<void> {
    setMode("browse")
    if (!q.trim()) return
    view.setStatus("searching…")
    view.draw()
    try {
      const hits: SearchHit[] = await search(q)
      const stations = hits.filter((h) => h.station).map((h) => h.station!)
      const place = hits.find((h) => h.kind === "place" && h.placeId)
      if (stations.length) {
        view.showStations(stations, `results for “${q}”`)
        view.setStatus("")
      } else if (place?.placeId) {
        view.showStations(await getPlaceStations(place.placeId), place.title)
        view.setStatus("")
      } else {
        view.setStatus(`nothing found for “${q}”`)
      }
    } catch (err) {
      view.setStatus(`search failed: ${err instanceof Error ? err.message : err}`)
    }
    view.draw()
  }

  function setMode(next: Mode): void {
    mode = next
    view.setMode(next)
    if (next === "search") view.input.value = ""
    view.draw()
  }

  renderer.keyInput.on("keypress", (key) => {
    if (mode === "search") {
      if (key.name === "escape") {
        setMode("browse")
        key.preventDefault()
      }
      return
    }
    switch (key.name) {
      case "q":
        // Playback and the daemon deliberately survive the client (INTENT D10).
        link.end()
        renderer.destroy()
        process.exit(0)
      case "space":
        send(link, { t: "stop" })
        break
      case "n":
        send(link, { t: "next" })
        break
      case "/":
        setMode("search")
        key.preventDefault()
        break
    }
  })

  view.select.focus()
  view.draw()
  void bootstrap()

  async function bootstrap(): Promise<void> {
    try {
      const [geo, places] = await Promise.all([getGeoPlaceHint(), getPlaces()])
      if (bootstrapped || view.stations.length || !geo || !places.length) return
      // nearest place to the client's geolocation is a sane default (INTENT §4)
      let best = places[0]
      let bestD = Infinity
      for (const p of places) {
        if (!p.geo) continue
        const d = (p.geo[1] - geo.lat) ** 2 + (p.geo[0] - geo.lon) ** 2
        if (d < bestD) {
          bestD = d
          best = p
        }
      }
      view.showStations(await getPlaceStations(best.id), `${best.title}, ${best.country}`)
      view.draw()
    } catch (err) {
      view.setStatus(`could not load stations: ${err instanceof Error ? err.message : err}`)
      view.draw()
    }
  }

  renderer.start()
}
