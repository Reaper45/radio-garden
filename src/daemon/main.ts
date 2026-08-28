import { mkdirSync, unlinkSync, existsSync } from "fs"
import type { Socket } from "bun"
import { getPlaceStations } from "../api/client"
import {
  FrameWriter,
  IDLE_TIMEOUT_MS,
  SOCKET_PATH,
  STATE_DIR,
  createLineDecoder,
  type ClientMessage,
  type DaemonMessage,
  type DaemonState,
  type PlayState,
  type StationRef,
} from "../shared/protocol"
import { Player } from "./player"
import { PowerManager } from "./power"

type Conn = { decode: (chunk: Uint8Array) => void; subscribed: boolean; writer: FrameWriter }

const clients = new Map<Socket<Conn>, Conn>()

const state: DaemonState = {
  play: "stopped",
  station: null,
  siblings: [],
  nowPlaying: null,
  via: null,
  power: "battery",
  lidSafe: false,
  message: null,
}

let lastBars: number[] = []
let idleSince = Date.now()
/** Stations already found dead this session, so auto-skip cannot loop forever. */
const deadThisSession = new Set<string>()

function broadcast(msg: DaemonMessage): void {
  for (const [sock, conn] of clients) {
    if (!conn.subscribed) continue
    try {
      // Bars are droppable so a wedged client loses frames instead of building
      // a backlog; state changes must not be lost (INTENT §5).
      if (msg.t === "bars") conn.writer.sendDroppable(msg)
      else conn.writer.send(msg)
    } catch {
      clients.delete(sock)
    }
  }
}

function pushState(): void {
  broadcast({ t: "state", state: { ...state } })
}

function markActive(): void {
  idleSince = Date.now()
}

const power = new PowerManager((p, lidSafe) => {
  state.power = p
  state.lidSafe = lidSafe
  pushState()
})

const player = new Player({
  onState(play: PlayState, message?: string) {
    state.play = play
    state.message = message ?? null
    if (play === "playing" || play === "buffering" || play === "resolving") markActive()
    power.setPlaying(play === "playing" || play === "buffering")
    state.lidSafe = power.lidSafe
    pushState()
  },
  onNowPlaying(title) {
    state.nowPlaying = title
    pushState()
  },
  onBars(bars) {
    lastBars = bars
    broadcast({ t: "bars", bars })
  },
  onDead(station, reason) {
    deadThisSession.add(station.id)
    state.message = `${station.title}: ${reason}`
    void skipFrom(station, `dead (${reason})`)
  },
})

/** Auto-skip past a dead station to the next live sibling in the same place (D7). */
async function skipFrom(station: StationRef, why: string): Promise<void> {
  const list = state.siblings
  const idx = list.findIndex((s) => s.id === station.id)
  const candidates = list.filter((s) => !deadThisSession.has(s.id))
  if (candidates.length === 0) {
    state.play = "error"
    state.message = `${station.title} ${why}; no live stations left in ${station.placeTitle}`
    pushState()
    await player.stop()
    return
  }
  const next = idx >= 0 ? (list.slice(idx + 1).find((s) => !deadThisSession.has(s.id)) ?? candidates[0]) : candidates[0]
  state.message = `skipped ${station.title} — ${why}`
  await start(next, list)
}

async function start(station: StationRef, siblings?: StationRef[]): Promise<void> {
  markActive()
  state.station = station
  state.nowPlaying = null
  state.via = null
  // reset before announcing the new station, or clients briefly show it as "playing"
  state.play = "resolving"
  if (siblings && siblings.length) {
    state.siblings = siblings
  } else if (state.siblings.every((s) => s.placeId !== station.placeId)) {
    try {
      state.siblings = await getPlaceStations(station.placeId)
    } catch {
      state.siblings = [station]
    }
  }
  pushState()
  await player.play(station)
}

async function next(): Promise<void> {
  const cur = state.station
  if (!cur) return
  const list = state.siblings
  if (list.length < 2) return
  const idx = list.findIndex((s) => s.id === cur.id)
  const after = list.slice(idx + 1).concat(list.slice(0, Math.max(0, idx)))
  const target = after.find((s) => !deadThisSession.has(s.id)) ?? after[0]
  if (target) await start(target, list)
}

async function handle(msg: ClientMessage, _sock: Socket<Conn>, conn: Conn): Promise<void> {
  markActive()
  switch (msg.t) {
    case "subscribe":
      conn.subscribed = true
      conn.writer.send({ t: "state", state: { ...state } } satisfies DaemonMessage)
      if (lastBars.length) conn.writer.send({ t: "bars", bars: lastBars } satisfies DaemonMessage)
      break
    case "status":
      conn.writer.send({ t: "state", state: { ...state } } satisfies DaemonMessage)
      break
    case "playStation":
      deadThisSession.delete(msg.station.id)
      await start(msg.station, msg.siblings)
      break
    case "stop":
      await player.stop()
      break
    case "next":
      await next()
      break
    case "shutdown":
      await shutdown(0)
      break
  }
}

async function shutdown(code: number): Promise<void> {
  try {
    await player.dispose()
  } catch {}
  power.dispose()
  try {
    if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH)
  } catch {}
  process.exit(code)
}

function isIdle(): boolean {
  return state.play === "stopped" && clients.size === 0 && Date.now() - idleSince > IDLE_TIMEOUT_MS
}

async function main(): Promise<void> {
  mkdirSync(STATE_DIR, { recursive: true })

  // A stale socket file means a crashed daemon: probe it, then take it over.
  if (existsSync(SOCKET_PATH)) {
    const alive = await Bun.connect({ unix: SOCKET_PATH, socket: { data() {} } })
      .then((s) => {
        s.end()
        return true
      })
      .catch(() => false)
    if (alive) {
      console.error("daemon already running")
      process.exit(0)
    }
    try {
      unlinkSync(SOCKET_PATH)
    } catch {}
  }

  await power.start()
  state.power = power.state
  state.lidSafe = power.lidSafe

  Bun.listen<Conn>({
    unix: SOCKET_PATH,
    socket: {
      open(sock) {
        const conn: Conn = {
          subscribed: false,
          writer: new FrameWriter(sock),
          decode: createLineDecoder<ClientMessage>((m) => void handle(m, sock, conn)),
        }
        sock.data = conn
        clients.set(sock, conn)
        markActive()
      },
      data(sock, chunk) {
        sock.data.decode(chunk)
      },
      drain(sock) {
        sock.data?.writer.flush()
      },
      close(sock) {
        clients.delete(sock)
        markActive()
      },
      error(sock) {
        clients.delete(sock)
      },
    },
  })

  // OPEN-6: exit after 5 idle minutes with nothing playing and nobody attached.
  setInterval(() => {
    if (isIdle()) void shutdown(0)
  }, 30_000)

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => void shutdown(0))
  }

  console.error(`radio-gardend listening on ${SOCKET_PATH}`)
}

await main()
