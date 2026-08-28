import { mkdir, readFile, writeFile, stat } from "fs/promises"
import { CACHE_DIR, PLACES_CACHE, PLACES_TTL_MS, USER_AGENT, type StationRef } from "../shared/protocol"

const BASE = "https://radio.garden/api"

/** Nothing may hang forever. Dead stations do exactly that (INTENT §4 gotcha 5). */
export const API_TIMEOUT_MS = 10_000
export const RESOLVE_TIMEOUT_MS = 8_000

export interface Place {
  id: string
  title: string
  country: string
  geo: [number, number]
  size: number
}

/** Every request needs a browser UA or Cloudflare returns a 403 challenge page. */
async function get(path: string): Promise<any> {
  const res = await fetch(BASE + path, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`)
  const text = await res.text()
  if (text.startsWith("<")) throw new Error(`GET ${path} -> HTML (blocked by Cloudflare?)`)
  return JSON.parse(text)
}

/**
 * The published spec documents `items[]` as ChannelRef {title, href}. The live API
 * actually returns {page: {...}}. See INTENT §4 gotcha 2.
 */
function stationFromPage(p: any): StationRef | null {
  const url: string | undefined = p?.url
  if (!url || p?.type !== "channel") return null
  const id = url.replace(/\/$/, "").split("/").pop()
  if (!id) return null
  return {
    id,
    title: p.title ?? id,
    placeId: p.place?.id ?? "",
    placeTitle: p.place?.title ?? "",
    country: p.country?.title ?? "",
    preroll: Boolean(p.preroll),
  }
}

export async function getPlaces(): Promise<Place[]> {
  const cached = await readCache()
  if (cached) {
    if (cached.stale) void refreshPlaces().catch(() => {})
    return cached.places
  }
  return refreshPlaces()
}

async function readCache(): Promise<{ places: Place[]; stale: boolean } | null> {
  try {
    const s = await stat(PLACES_CACHE)
    const places = JSON.parse(await readFile(PLACES_CACHE, "utf8")) as Place[]
    if (!Array.isArray(places) || places.length === 0) return null
    return { places, stale: Date.now() - s.mtimeMs > PLACES_TTL_MS }
  } catch {
    return null
  }
}

/** 1.85 MB. Cached to disk with a 7-day TTL, served stale then refreshed (OPEN-4). */
async function refreshPlaces(): Promise<Place[]> {
  const d = await get("/ara/content/places")
  const places: Place[] = (d?.data?.list ?? []).map((p: any) => ({
    id: p.id,
    title: p.title,
    country: p.country,
    geo: p.geo,
    size: p.size ?? 0,
  }))
  await mkdir(CACHE_DIR, { recursive: true })
  await writeFile(PLACES_CACHE, JSON.stringify(places))
  return places
}

export async function getPlaceStations(placeId: string): Promise<StationRef[]> {
  const d = await get(`/ara/content/page/${placeId}/channels`)
  const out: StationRef[] = []
  for (const block of d?.data?.content ?? []) {
    for (const item of block?.items ?? []) {
      const s = stationFromPage(item?.page)
      if (s) out.push(s)
    }
  }
  return out
}

export interface SearchHit {
  kind: "channel" | "place" | "country"
  title: string
  subtitle: string
  station?: StationRef
  placeId?: string
}

/** Live hits nest under `_source.page`, not the flat `_source` the spec shows. */
export async function search(q: string): Promise<SearchHit[]> {
  const d = await get(`/search?q=${encodeURIComponent(q)}`)
  const out: SearchHit[] = []
  for (const hit of d?.hits?.hits ?? []) {
    const p = hit?._source?.page
    if (!p?.url) continue
    const id = p.url.replace(/\/$/, "").split("/").pop()
    if (p.type === "channel") {
      const s = stationFromPage(p)
      if (s) out.push({ kind: "channel", title: s.title, subtitle: p.subtitle ?? "", station: s })
    } else if (p.type === "place") {
      out.push({ kind: "place", title: p.title ?? "", subtitle: p.subtitle ?? "", placeId: id })
    }
  }
  return out
}

export async function getGeoPlaceHint(): Promise<{ city: string; lat: number; lon: number } | null> {
  try {
    const d = await get("/geo")
    if (typeof d?.latitude !== "number") return null
    return { city: d.city ?? "", lat: d.latitude, lon: d.longitude }
  } catch {
    return null
  }
}

export type Codec = "mp3" | "aac" | "dead"

export interface Resolved {
  url: string
  contentType: string
  codec: Codec
}

/**
 * Follows the 302 (and any further upstream hops) and classifies the result.
 * This is both the dead-station gate and the D13 codec router — one request
 * serves both, so neither costs anything extra (OPEN-3).
 */
export async function resolveStream(channelId: string, signal?: AbortSignal): Promise<Resolved> {
  let res: Response
  try {
    res = await fetch(`${BASE}/ara/content/listen/${channelId}/channel.mp3`, {
      headers: { "User-Agent": USER_AGENT, Range: "bytes=0-1" },
      redirect: "follow",
      signal: signal ?? AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
    })
  } catch {
    return { url: "", contentType: "", codec: "dead" }
  }
  const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  try {
    await res.body?.cancel()
  } catch {}
  let codec: Codec = "dead"
  if (contentType === "audio/mpeg" || contentType === "audio/mp3") codec = "mp3"
  else if (contentType.includes("aac")) codec = "aac"
  return { url: res.url, contentType, codec }
}
