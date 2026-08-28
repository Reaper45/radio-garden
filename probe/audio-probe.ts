import { setupAudio } from "@opentui/core"

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
const CHANNEL = process.argv[2] ?? "FXyhz9Xk" // BBC World Service

const r = await fetch(`https://radio.garden/api/ara/content/listen/${CHANNEL}/channel.mp3`, {
  headers: { "User-Agent": UA }, redirect: "follow",
})
console.log("resolved ->", r.url, "| content-type:", r.headers.get("content-type"))
r.body?.cancel()

const audio = setupAudio({ autoStart: true })
console.log("engine started:", audio.isStarted(), "| sampleRate:", audio.sampleRate)

const stream = await audio.playStreamUrl(r.url, {
  request: { headers: { "User-Agent": UA, "Icy-MetaData": "1" } },
  contentTypePolicy: "validate",
})
stream.on("metadata", (m: any) => console.log("ICY METADATA:", JSON.stringify(m?.fields ?? m)))
stream.on("error", (e, ctx) => console.log("stream error:", e.message, ctx))

console.log("tap enabled:", audio.enableTap(65536))

const blocks = " ▁▂▃▄▅▆▇█"
let ticks = 0
const iv = setInterval(() => {
  const t = audio.readTapFrames(1024, 1)
  const st = stream.getStats()
  if (!t || t.framesRead === 0) { console.log(`[${ticks}] state=${st.state} buffered=${st.bufferedDurationMs|0}ms tap=EMPTY`); }
  else {
    const f = t.frames.subarray(0, t.framesRead)
    let peak = 0, sum = 0
    for (const v of f) { const a = Math.abs(v); if (a > peak) peak = a; sum += v*v }
    const rms = Math.sqrt(sum / f.length)
    const bar = blocks[Math.min(8, Math.round(rms * 40))]
    console.log(`[${ticks}] state=${st.state} frames=${t.framesRead} rms=${rms.toFixed(4)} peak=${peak.toFixed(3)} ${bar.repeat(Math.min(30, Math.round(rms*120)))}`)
  }
  if (++ticks >= 12) { clearInterval(iv); stream.dispose(); audio.dispose(); process.exit(0) }
}, 800)
