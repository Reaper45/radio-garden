import { existsSync } from "fs"
import type { Socket } from "bun"
import {
  FrameWriter,
  SOCKET_PATH,
  createLineDecoder,
  type ClientMessage,
  type DaemonMessage,
} from "../shared/protocol"

export interface ConnectionHandlers {
  onMessage: (msg: DaemonMessage) => void
  onClose: () => void
}

/**
 * Connects to the daemon, spawning it if absent. A stale socket file (crashed
 * daemon) fails to connect, so we retry after the spawn rather than trusting
 * the file's existence — and never trust a pidfile, since PIDs are reused.
 */
export interface DaemonLink {
  send(msg: ClientMessage): void
  end(): void
}

export async function connect(handlers: ConnectionHandlers): Promise<DaemonLink> {
  const decode = createLineDecoder<DaemonMessage>(handlers.onMessage)
  let writer: FrameWriter | null = null
  const attempt = () =>
    Bun.connect<undefined>({
      unix: SOCKET_PATH,
      socket: {
        data(_s, chunk) {
          decode(chunk)
        },
        drain() {
          writer?.flush()
        },
        close: handlers.onClose,
        error: handlers.onClose,
      },
    })

  const wrap = (sock: Socket<undefined>): DaemonLink => {
    writer = new FrameWriter(sock)
    return {
      send: (msg) => writer!.send(msg),
      end: () => {
        try {
          sock.end()
        } catch {}
      },
    }
  }

  if (existsSync(SOCKET_PATH)) {
    try {
      return wrap(await attempt())
    } catch {
      // stale socket — fall through and respawn
    }
  }

  spawnDaemon()
  let lastErr: unknown
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(100)
    try {
      return wrap(await attempt())
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`could not reach daemon: ${lastErr}`)
}

function spawnDaemon(): void {
  const entry = new URL("../daemon/main.ts", import.meta.url).pathname
  // Detached so playback outlives this client (INTENT D10).
  Bun.spawn([process.execPath, entry], {
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  }).unref()
}

export function send(link: DaemonLink, msg: ClientMessage): void {
  link.send(msg)
}
