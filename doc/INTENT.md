# Intent — `radio-garden` CLI

**Status:** design closed — audio pipeline verified end to end, implementation started
**Date:** 2026-08-28
**Platform target:** macOS (Apple Silicon), Apple Terminal and friends

> **Revision note (2026-08-28).** This document was substantially revised after
> discovering that `@opentui/core` ships a native audio engine with an output tap
> and ICY metadata support. Decisions D2, D3, D5 and D9 and §5 changed as a result.
> The superseded ffmpeg-centric design is recorded in §9.

---

## 1. What this is

A terminal radio player. You pick a station from [Radio Garden](https://radio.garden/),
it streams, and the terminal shows a real-time spectrogram of the audio, drawn as
a GitHub contribution graph, while it plays. It keeps the machine awake so playback survives a closed lid.

It is a fun project. The design below optimises for *feeling good to use*, not for
robustness at scale.

## 2. Shape of the thing

TypeScript on Bun. TUI and audio both from [OpenTUI](https://github.com/anomalyco/opentui)
(`@opentui/core`), whose native engine handles playback, buffering, reconnect and
ICY metadata. `ffmpeg` appears only as an optional transcoding shim for AAC.

```
                  Radio Garden API
                         │ resolve 302 -> upstream URL
                         ▼
              ┌──── content-type? ────┐
              │                       │
        audio/mpeg (59%)      audio/aac* (39%)
              │                       │
              ▼                       ▼
     audio.playStreamUrl()    ffmpeg aac->mp3 shim
              │                       │
              └──────────┬────────────┘
                         ▼
              OpenTUI audio engine ──> speakers
                         │
                    enableTap()
                         ▼
              readTapFrames() -> FFT -> band levels
```

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Real FFT spectrum**, not decoration | The squares should mean something. |
| D2 | **ffmpeg is an *optional* dependency** | Needed only for the 39% of stations that serve AAC. MP3 works with zero external deps. Degrade with a clear message if absent. |
| D3 | **OpenTUI's native audio engine drives playback** | `playStreamUrl()` gives decode, buffering, reconnect and ICY metadata for free. Supersedes the ffmpeg dual-output design (§9). |
| D4 | **Single-letter keybindings** | `⌘` cannot reach a TUI in Apple Terminal (§6). |
| D5 | **The tap is the PCM source, so A/V sync is free** | `readTapFrames()` reads *post-mix output* — the audio actually being played. The lead-ahead problem of the ffmpeg design does not arise. |
| D6 | **Render reads the tap; it never gates playback** | The tap is a native ring buffer. Not polling it cannot stall audio (§5). |
| D7 | **`n` walks stations in the current place** | The place is the unit of browsing, not a global shuffle. |
| D8 | **Daemon owns lifecycle; clients attach and detach** | A persistent process is the feature, not a leak. |
| D10 | **Background daemon + thin TUI client** | Playback outlives the terminal. Close the window, close the lid, music continues. |
| D11 | **The daemon computes the FFT; clients receive band levels** | PCM over the socket would cost ~44 KB/s per client; seven levels cost ~40 bytes/frame. |
| D12 | **No mute** | Dropped. `space` stops. |
| D13 | **Hybrid codec routing** | MP3 native, AAC via ffmpeg shim. The tap makes both paths identical downstream — the visualizer never knows which fed it. |
| D14 | **Show ICY now-playing metadata** | The stream provides what the API does not (§4). Free on the MP3 path. |
| D15 | **All socket writes go through `FrameWriter`** | Bun's `socket.write()` returns short counts on large messages. Found in implementation — see §5. |
| D16 | **The visualiser is a scrolling contribution grid, not bars** | Bars show one instant; the grid shows the last ten seconds, so you can see a track's structure go past. Seven log rows × five levels is GitHub's shape, and it is a spectrogram either way. Supersedes the adaptive bar count of D9. |
| D17 | **The daemon sends instants; the client owns the scroll history** | Column width is a function of terminal width, which only the client knows, and a second client attaching should not inherit the first one's scrollback. The daemon stays stateless past the current frame. |
| D18 | **The grid scrolls by character, not by column** | A column is three characters wide; advancing one per commit hops visibly. Sliding the strip and clipping the end squares mid-glyph runs the motion at the render tick instead. Costs half the history window — the right trade, because stepping is the thing you notice. |
| D19 | **A second visualiser on `s`: 31 third-octave bars** | Amends D16 rather than reversing it. D16 was right that bars show one instant and the grid shows the last minute — that is why `s` switches between them instead of one replacing the other. The grid is still what the app opens on. |

### Keybindings (D4)

| Key | Action |
|---|---|
| `space` | Stop — tear down the stream, return to stopped state |
| `n` | Next station in the current place |
| `s` | Switch visualiser — contribution grid ⇄ 1/3-octave bars (D19) |
| `q` | Quit the client (daemon and playback survive) |
| `/` | Search |

### FFT parameters (D9, revised)

The engine runs at **48 kHz**, not the 22.05 kHz of the superseded design.

- **Input:** `readTapFrames(2048, 1)` — mono downmix of the output tap.
- **Window:** 2048 samples, Hann. 23.4 Hz per bin, ~43 ms of audio. 2048 rather
  than 1024 because at 48 kHz a 1024 window gives only 46.9 Hz resolution, which
  smears the bass register into two or three bins.
- **Rate:** poll at 30 Hz, matching the render loop. The tap is a ring buffer, so
  the poll rate and the audio rate need not relate.
- **Bands:** seven, log-spaced 40 Hz to 16 kHz — one grid row each (D16). Fixed,
  not adaptive: seven rows is what makes the thing read as a contribution graph.
  Edges are rounded to whole bins and made exclusive; `floor`/`ceil` would overlap
  neighbours by a bin, which at this resolution puts one bass tone in two rows.
- **Dynamics:** asymmetric smoothing — attack α ≈ 0.6 (near-instant), release
  α ≈ 0.15 per frame. Fast decay reads twitchy, slow reads like sludge.
- **Normalisation:** one rolling-max AGC over ~3 s, shared by all bands, so quiet
  stations still fill the grid and a loud band still reads as louder than a quiet
  one.
- **Spectral tilt:** band magnitudes are weighted by `(centre Hz)^0.3`, about 4.7×
  across the range. Music falls off roughly 4.5 dB/octave, so against a shared peak
  the two treble rows would sit empty for the life of the session. Partial
  compensation, not full: flattening it entirely makes every station look like
  white noise.
- **Levels:** five, GitHub's scale, at norm ≥ 0.08 / 0.3 / 0.55 / 0.8. Below an
  absolute floor (~-100 dBFS on the pre-tilt magnitudes) the grid is empty, so
  dither and denormals cannot be normalised up into a full green wall.

**Why not normalise each band against its own recent average?** It was tried. It
gives beautiful scatter, but a band with nothing in it but window leakage gets
amplified to level 4, so a 100 Hz test tone lights all seven rows — the display
stops being a measurement. Per-band scoring was dropped for the shared peak plus
tilt above; `probe/fft-probe.ts` holds both halves of that trade as assertions:
tones must stay in their own band, *and* ten seconds of synthetic programme
material must scatter across all five levels with no flat row.

### Grid parameters (D16, D17)

- **Cell:** two block glyphs plus a one-column gutter. A terminal cell is about
  twice as tall as it is wide, so two of them read as one GitHub square.
- **Column:** 100 ms. Frames arrive at 30 Hz, so about three fold into each
  column — by max, not mean, because a snare that lands inside a column should
  light it and averaging is exactly what erases it.
- **Scroll:** sub-column. Committing columns *is* the animation only if you are
  willing to watch the grid hop three characters ten times a second, which reads
  as stepping. Instead the view is handed the column still filling as an extra
  cell past the right edge, slides the whole strip left by
  `elapsed / COLUMN_MS × CELL_W` characters and clips it back to width. The end
  squares are cut mid-glyph, so the grid drifts at the render tick — 30 steps a
  second, one per frame, for the same 10 columns of data.
  The offset rounds rather than floors: frames land on 33 ms boundaries and a
  third of a column is 33.33 ms, so flooring puts every tick just short of its
  step and the slide comes out 0, 0, 2.
- **Width:** adaptive, 8 to 53 columns (a year of contributions is 53 weeks), so
  the window covers 0.8 to 5.3 s depending on the terminal. Shorter than it was
  at 200 ms columns: history length trades directly against smoothness, and
  smoothness won.
- **Palette:** GitHub's four greens, with the empty cell darkened to this app's
  background rather than `#0d1117`.
- **Idle:** stopping a station empties the grid rather than freezing it. A stopped
  player should look like a quiet year, not a paused one.

### The 1/3-octave analyser (D19)

A second visualiser, on `s`. The grid answers "what has this station been doing
for the last minute"; this answers "what is it doing right now, in detail". They
are different questions, so neither replaces the other and both are computed for
every frame — toggling is a repaint, not a restart, and a client that has just
pressed `s` never watches an empty display fill.

- **Bands:** 31, on the ISO 266 preferred centres, 20 Hz to 20 kHz. Not a chosen
  number: third-octave spacing across the audible range *is* 31 bands, 10 1/3
  octaves times three. A different count would be a different bandwidth, and
  then it is not a third-octave analyser. Edges sit a sixth of an octave either
  side of each centre; the top one, 22.4 kHz, clears Nyquist at 48 kHz.
- **Window:** 8192 samples, 170 ms, 5.86 Hz per bin — four times the grid's. The
  band plan forces it. A third-octave band is 23% of its centre frequency wide,
  so the 20 Hz band spans 4.6 Hz; at the grid's 23.4 Hz per bin the bottom seven
  bands would all read the same one or two bins and move in lockstep, a rainbow
  welded together at the left. At 8192 every band from 20 Hz up gets bins of its
  own, and `probe/thirds-probe.ts` asserts it by requiring each of the 31 ISO
  centres to light its own band and no other's. 16384 would separate nothing
  further and would smear a snare across a third of a second.
- **Scoring:** summed power across the band, not the loudest bin in it. The top
  band spans 790 bins and the bottom one a single bin, so peak-bin scoring hands
  the treble an 800:1 advantage on anything noise-like. Summation is what a
  hardware analyser integrates, and it has a property worth more than the
  correction it replaces: band power is bandwidth times PSD, and pink PSD falls
  at exactly the rate third-octave bandwidth rises, so **pink noise reads flat**.
  Broadcast music is approximately pink.
- **No spectral tilt.** The grid needs `(centre Hz)^0.3` because peak-bin scoring
  has no answer to a spectrum that falls with frequency. Band summation is that
  answer, derived rather than tuned. The probe holds both ends of it: pink flat
  within ~7 dB across 40 Hz-10 kHz, white noise rising toward the treble.
- **Scale:** dB, 48 dB of range below the rolling peak, over fourteen half-block
  steps — about 3.4 dB a step. The grid's five green levels did not justify a log
  scale and use amplitude^0.5 instead; fourteen steps do, and bars are read
  logarithmically anyway.
- **Dynamics:** the same asymmetric smoothing and the same shared rolling-max AGC
  as the grid, and the same absolute floor — here -90 dBFS, expressible directly
  because band amplitudes are normalised so a full-scale sine reads 1.0.
- **Geometry:** seven rows, the same seven the grid occupies, because the
  now-playing box is a fixed `NOW_HEIGHT` and a mode with its own row count would
  resize the station list under it every time you pressed `s`. Two half-block
  glyphs per row give fourteen steps. Bars are 2 characters wide with a gutter at
  100 columns, losing the gutter and then a character as the terminal narrows.
- **Colour:** one fixed hue per band, red at 20 Hz through violet at 20 kHz.
  Lightness is compensated across the sweep — lifted where the eye finds hue dark
  (red, blue), dropped where it finds it bright (yellow, green) — because at one
  flat lightness the rainbow reads as a loudness curve baked into the frequency
  axis, which is the exact misreading the display exists to prevent.
- **Peak hold:** 700 ms, then falling at 9 half-steps a second. It lives in the
  client, not the daemon, because it is measured in half-block steps and the wire
  format deliberately knows nothing about rows: frames carry 0..100, and the
  client owns its own geometry.
- **Floor ticks:** a silent band draws a dim tick on the bottom row rather than
  nothing. Two of the 31 bands are expected to sit dark on most stations — 128
  kbps streams are lowpassed near 16 kHz — and a gap in the rainbow reads as a
  bug where a dim tick reads as a measurement.

## 3a. Daemon architecture (D10)

```
  radio-garden (TUI client)         radio-garden (TUI client)
        │  attach/detach freely            │
        └──────────────┬───────────────────┘
                       │  unix socket, newline-delimited JSON
                       │  ~/.local/state/radio-garden/sock
              ┌────────┴─────────┐
              │  radio-gardend   │  owns: playback state, OpenTUI audio
              │    (daemon)      │        engine, caffeinate assertion, FFT
              └────────┬─────────┘
                       │
              audio engine ──> speakers
                       └─ tap ──> FFT ──> level frames ──> clients
```

**Client → daemon:** `play {channelId}`, `stop`, `next`, `status`, `subscribe`.
**Daemon → client:** `state {station, place, playing, power, nowPlaying}`,
`spectrum {bands: [u8; 7]}`, `error {…}`.

The daemon auto-spawns on first client connect if no live socket is found.
`radio-garden kill` shuts it down explicitly.

**The audio engine runs headless.** Verified: `setupAudio()` starts and plays with
no renderer attached, so the daemon needs no terminal.

**Failure handling.** A stale socket (daemon crashed) is detected by a failed
connect, then unlinked and respawned. A pidfile alone is insufficient — PIDs are reused.

**The caffeinate assertion is held only while playing**, never merely while the
daemon is alive. An idle daemon holding `-s` would drain the battery for nothing.

**Socket writes to clients are non-blocking and drop frames on congestion**, so a
stalled TUI can never stall playback.

## 4. What the API can and cannot do

Seven operations, no auth, no documented rate limits.

| Endpoint | Returns |
|---|---|
| `GET /api/ara/content/places` | All places with stations — 12,569 entries, 1.85 MB |
| `GET /api/ara/content/page/{placeId}` | Place details |
| `GET /api/ara/content/page/{placeId}/channels` | Stations at a place — **the `n` list** |
| `GET /api/ara/content/channel/{channelId}` | Station details |
| `GET\|HEAD /api/ara/content/listen/{channelId}/channel.mp3` | 302 → upstream stream URL |
| `GET /api/search?q=` | Countries, places, channels (~20 hits, no pagination) |
| `GET /api/geo` | Client geolocation — good default place on first run |

**Not available:** genre/tag filtering, favourites, search pagination, station
health or uptime, anything write-shaped.

**Now-playing *is* available — but from the stream, not the API.** Stations serve
ICY metadata in-band; OpenTUI surfaces it as a `metadata` event. Verified: BBC
World Service reported `StreamTitle: "BBC World Service Online"` within ~1 s (D14).

### Verified gotchas (probed live 2026-08-28)

1. **Cloudflare blocks default clients.** A bare `curl` UA gets `403 Just a moment…`
   on every endpoint; a browser UA gets `200`. **Send a browser `User-Agent` on
   every request**, to the API *and* to upstream stream hosts.
2. **The published spec is stale in two places.**
   - `/search`: real hits nest under `_source.page`, not flat `_source`. No `_id`.
   - `/page/{id}/channels`: items are `{page: {...}}` objects, not the documented
     `ChannelRef` with `title`/`href`.
   - Undocumented fields `preroll` (boolean) and `stream` (hostname) exist on page objects.
3. **`channel.mp3` is a misnomer** — see the codec census below.
4. **`preroll: true` means an advertisement plays first.** Surface it, or users
   will think the station is broken.
5. **Dead stations are normal.** 1 in 71 sampled returned `text/plain`; an earlier
   sample returned a `301` into `text/html`.

### Codec census (71 random stations, 18 random places)

| Content-Type | Count | Share | Path |
|---|---|---|---|
| `audio/mpeg` | 42 | 59% | native |
| `audio/aacp` | 19 | 27% | ffmpeg shim |
| `audio/aac` | 9 | 13% | ffmpeg shim |
| `text/plain` | 1 | 1% | dead |

**39% AAC is why D2 keeps ffmpeg around.** OpenTUI's `AudioStreamFormat` is
`"mp3" | "flac"` only; AAC streams are rejected at the content-type gate. Without
the shim, two stations in five would fail.

## 5. The invariant that protects playback

**Nothing the UI does may interrupt audio.**

Under the superseded ffmpeg design this was load-bearing and fragile: stdout was a
pipe, and failing to drain it would block ffmpeg's writes and stutter playback.
Under D3 it is nearly free — `readTapFrames()` reads a native ring buffer that the
mixer fills regardless of whether anyone is listening. A wedged renderer costs you
stale spectrum frames, never audio.

What remains: spectrum frames pushed to clients must use non-blocking writes and drop
on congestion, so a slow socket cannot back up into the daemon's event loop.

### The direction this analysis missed (found in implementation)

The reasoning above is about daemon → client. The first real bug was the
opposite direction. Bun's `socket.write()` may accept only **part** of a large
buffer and return a short count. A `playStation` message carrying 67 sibling
stations is ~8.3 KB, and the socket accepted **8174 of 8316 bytes**. The
remaining 142 bytes were dropped, the receiver's `JSON.parse` failed, and the
line decoder — which ignores malformed frames by design so one bad frame cannot
kill a connection — swallowed it silently. The command simply vanished: no
error, no crash, no log.

`FrameWriter` (D15) now owns every write in both directions. It retains the
unwritten remainder and flushes it on the socket's `drain` event. Control
messages queue reliably; spectrum frames use `sendDroppable`, which skips a frame
entirely when anything is still pending — so congestion costs visualiser frames
and never commands.

## 6. Constraints that shaped the design

**`⌘` cannot reach a TUI.** Terminals do not encode the Command modifier into
stdin — there is no ANSI sequence for it, and `⌘C` is the terminal's own copy
command. Only Kitty-keyboard-protocol terminals (Ghostty, Kitty, recent iTerm2)
transmit Super at all; Apple Terminal does not. Hence D4.

**Pause is incoherent for live radio.** Nothing to resume — the broadcast moves on.
Hence `space` = stop, and no mute (D12).

**Staying awake is AC-only.** See §7, OPEN-1.

## 7. Design questions (all resolved)

### OPEN-1 — RESOLVED: live power indicator

`man caffeinate`: `-s` is *"valid only when system is running on AC power."* On
battery with the lid closed, macOS sleeps regardless of any userspace assertion.
The always-awake feature **only works plugged in**; this cannot be engineered around.

**Decided:** neither refuse to start nor nag. Show a live badge that flips with the
power source — `⚡︎ lid-safe` on AC, `🔋 will sleep` on battery. Honest, zero
friction, teaches the constraint. Polled from `pmset -g batt`, pushed in `state`.

### OPEN-2 — DISSOLVED

Mute was dropped (D12), so runtime volume control is moot. (Note: had it survived,
D3 would have made it trivial anyway — `AudioStream.setVolume()` exists.)

### OPEN-3 — RESOLVED: two watchdog mechanisms

Detecting dead streams by inspecting HTML covers only the first failure mode:

- **Resolve-time:** follow the 302, check the final `Content-Type`. Non-audio →
  reject before playback. Cheap, reliable, and where HTML inspection belongs. This
  gate also performs the D13 codec routing, so it is on the path regardless.
- **Mid-stream:** a station that connects then stalls emits no HTML. Needs a
  time-based watchdog on tap output and `AudioStream` stats.

**Accepted:** 10 s from connect, 5 s once flowing.

### OPEN-4 — RESOLVED: disk cache, 7-day TTL

`/places` is 1.85 MB. Cache to `~/.cache/radio-garden/places.json`, 7-day TTL,
serve stale immediately and refresh in background. Stations do not move often
enough to pay 1.85 MB of latency every launch.

### OPEN-5 — RESOLVED, then superseded

The ffmpeg dual-output invocation was verified working (§9) before D3 replaced it.

### OPEN-6 — RESOLVED: 5 minute idle timeout

The daemon exits after 5 minutes with nothing playing **and** no client attached.
Any connect or `play` resets the timer. The caffeinate assertion drops the moment
playback stops, well before the daemon exits.

## 8. Verification log

Everything below was executed, not assumed.

| Claim | Evidence |
|---|---|
| API needs a browser UA | Bare curl → `403 Just a moment…`; browser UA → `200`, all 7 endpoints |
| Spec stale on `/search`, `/channels` | Live responses nest under `_source.page` / `items[].page` |
| Codec mix is 59/39/1 | 71 stations across 18 random places, Content-Type after redirects |
| OpenTUI plays MP3 headless | `setupAudio()` + `playStreamUrl()`, no renderer, `state=playing` |
| Tap yields real PCM | `readTapFrames(1024,1)` → 1024 frames/poll, RMS tracking speech 0.0001–0.0626 |
| ICY metadata works | `StreamTitle: "BBC World Service Online"` within ~1 s |
| AAC is rejected | `audio/aac` and `audio/aacp` both fail the content-type gate |
| `audiotoolbox` exists | Present as an output device in stock Homebrew ffmpeg 9.0.1 |
| **D15 partial-write bug** | `playStation` with 67 siblings: `socket.write()` returned 8174 of 8316 bytes; frame lost silently until `FrameWriter` |
| **UI renders correctly** | Headless `createTestRenderer` frame assertions: stopped/playing/buffering states, a 7-row contribution grid painted in all five GitHub greens, preroll `· ad` marker, power badge |
| **Daemon outlives client** | After `q`, `status` still reported `playing`; playback continued until `radio-garden kill` |
| **D13 AAC shim works** | WFDD3 (`audio/aac`) → `ffmpeg -f mp3 pipe:1` → `playStream({format:"mp3"})` → `state=playing`, audible in 9/12 polls |
| **D19 bands are separable** | `probe/thirds-probe.ts`: all 31 ISO centres light their own band; 20/25/31.5 Hz resolve separately, which the grid's 2048 window cannot do |
| **D19 needs no tilt** | Same probe: pink noise flat to 14 of 100 (~6.7 dB) across 40 Hz-10 kHz; white noise rises 53 → 86, i.e. 3 dB/octave |
| **D19 renders** | Headless frame assertions: seven rows in both modes, panel height unchanged across the toggle, 31 distinct bar colours on screen, bars growing upward, peak markers surviving a drop |

## 9. Superseded design (kept for context)

The original plan made ffmpeg a **hard** dependency, with one process serving both
speakers and the visualizer:

```
ffmpeg -user_agent "<UA>" -i "<stream>" -f audiotoolbox - -ac 1 -ar 22050 -f s16le pipe:1
```

This was verified working — exit 0, exactly 264,600 bytes of PCM for a 6 s capture
(22050 × 2 × 6, no drift), RMS 2174, and a plausible speech spectrum through a
1024-point DFT. It was abandoned because OpenTUI's native engine does the same job
with no subprocess, no hard dependency for the 59% MP3 majority, ICY metadata for
free, and an output tap that removes the A/V sync offset (D5) and the pipe-drain
hazard (§5).

The invocation survives as the D13 shim, in reduced form: `aac → mp3` transcode
only, feeding `audio.playStream(body, { format: "mp3" })`.

**Known limitation of the shim:** piping through ffmpeg loses in-band ICY metadata,
so AAC stations will show no now-playing text. A later upgrade could fetch the
stream directly, split it with OpenTUI's exported `createIcyStreamDemuxer`, feed
only the audio bytes to ffmpeg, and emit metadata events by hand — preserving both.

## 10. Non-goals

Recording, playlists, scrobbling, our own station database, Linux/Windows support,
and anything requiring a Radio Garden account.
