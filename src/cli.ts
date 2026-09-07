#!/usr/bin/env bun
import { existsSync, unlinkSync } from "fs"
import { SOCKET_PATH, encode } from "./shared/protocol"

const cmd = process.argv[2]

if (cmd === "kill" || cmd === "stop-daemon") {
  if (!existsSync(SOCKET_PATH)) {
    console.log("no daemon running")
    process.exit(0)
  }
  try {
    const sock = await Bun.connect({ unix: SOCKET_PATH, socket: { data() {} } })
    sock.write(encode({ t: "shutdown" }))
    await Bun.sleep(300)
    sock.end()
    console.log("daemon stopped")
  } catch {
    try {
      unlinkSync(SOCKET_PATH)
    } catch {}
    console.log("removed stale socket")
  }
  process.exit(0)
}

if (cmd === "daemon") {
  await import("./daemon/main")
} else if (cmd === "--help" || cmd === "-h") {
  console.log(`radio-garden — terminal radio from radio.garden

  ████   ███  ████  ███  ███      ███   ███  ████  ████  █████ █   █     ███  █     ███ 
  █   █ █   █ █   █  █  █   █    █     █   █ █   █ █   █ █     ██  █    █     █      █  
  ████  █████ █   █  █  █   █    █  ██ █████ ████  █   █ ████  █ █ █    █     █      █  
  █  █  █   █ █   █  █  █   █    █   █ █   █ █  █  █   █ █     █  ██    █     █      █  
  █   █ █   █ ████  ███  ███      ███  █   █ █   █ ████  █████ █   █     ███  █████ ███ 

  radio-garden          launch the player
  radio-garden daemon   run the daemon in the foreground
  radio-garden kill     stop the background daemon

keys: ↑↓ move   ⏎ play   space stop   n next   s visualiser   / search   q quit
(playback continues after q — use 'radio-garden kill' to stop it)`);
} else {
  const { run } = await import("./client/tui")
  await run()
}
