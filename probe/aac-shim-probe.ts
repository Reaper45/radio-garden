import { setupAudio } from "@opentui/core"

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const CHANNEL = process.argv[2] ?? "sn32jtQ6" // WFDD3, audio/aac

const r = await fetch(`https://radio.garden/api/ara/content/listen/${CHANNEL}/channel.mp3`, {
  headers: { "User-Agent": UA }, redirect: "follow",
})
console.log("resolved ->", r.url, "| content-type:", r.headers.get("content-type"))
r.body?.cancel()

// D13 shim: transcode whatever it is into mp3 on stdout
const ff = Bun.spawn([
  "ffmpeg", "-hide_banner", "-loglevel", "error",
  "-user_agent", UA, "-i", r.url,
  "-f", "mp3", "-b:a", "128k", "pipe:1",
], { stdout: "pipe", stderr: "pipe" })

const audio = setupAudio({ autoStart: true })
const stream = await audio.playStream(ff.stdout as ReadableStream<Uint8Array>, { format: "mp3" })
stream.on("error", (e, ctx) => console.log("stream error:", e.message, ctx))
console.log("tap enabled:", audio.enableTap(65536))

const blocks = " ▁▂▃▄▅▆▇█"
let ticks = 0, heard = 0
const iv = setInterval(() => {
  const t = audio.readTapFrames(2048, 1)
  const st = stream.getStats()
  if (t && t.framesRead > 0) {
    const f = t.frames.subarray(0, t.framesRead)
    let sum = 0; for (const v of f) sum += v * v
    const rms = Math.sqrt(sum / f.length)
    if (rms > 0.005) heard++
    console.log(`[${ticks}] state=${st.state} frames=${t.framesRead} rms=${rms.toFixed(4)} ${blocks[Math.min(8,Math.round(rms*40))].repeat(Math.min(30,Math.round(rms*120)))}`)
  } else console.log(`[${ticks}] state=${st.state} buffered=${st.bufferedDurationMs|0}ms tap=EMPTY`)
  if (++ticks >= 12) {
    clearInterval(iv)
    console.log(heard >= 3 ? `\nSHIM WORKS — real audio in ${heard}/12 polls` : `\nSHIM FAILED — audible polls: ${heard}/12`)
    ff.kill(); stream.dispose(); audio.dispose(); process.exit(heard >= 3 ? 0 : 1)
  }
}, 800)
