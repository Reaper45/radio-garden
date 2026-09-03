# radio-garden

A terminal client for [radio.garden](https://radio.garden/): browse stations by
place, play one, and watch the audio scroll past as a GitHub contribution graph.
Playback runs in a background daemon, so it survives closing the terminal — and a
closed lid, when you're on mains power.

> Inspired by [radio.garden](https://radio.garden/) and built on its API, which
> is undocumented and unofficial. This project is not affiliated with or endorsed
> by Radio Garden, and the API may change or disappear without notice.

![radio-garden playing HomeBoyz Radio FM 103.5, Nairobi](doc/screenshot.png)

Seven log-spaced frequency rows, 40 Hz to 16 kHz, a new column every 100 ms — a
spectrogram in GitHub's five shades of green. The squares are real FFT output,
not decoration: a bass-heavy track fills the bottom rows, a cymbal lights the top
one, and silence empties the grid. The capture above is live output, not a
mockup — HomeBoyz Radio FM 103.5 out of Nairobi, five seconds of it.

The grid does not advance a column at a time. A square is three characters wide,
so the strip slides one character every 33 ms and the leading square is clipped
mid-glyph as it leaves: the motion runs at the render tick, 30 steps a second,
rather than hopping a whole cell ten times a second.

## Requirements

- **Bun** (tested on 1.3.9)
- **macOS** — power handling and audio output are macOS-specific
- **ffmpeg** *(optional)* — only for AAC stations, ~39% of the catalogue. Without
  it, MP3 stations play and AAC ones report a clear error. `brew install ffmpeg`

## Run

```bash
bun install
bun start           # launch the player
bun run kill        # stop background playback
```

## Keys

| Key | Action |
|---|---|
| `↑` `↓` | move through the station list |
| `⏎` | play the selected station |
| `space` | stop |
| `n` | next station in the current place |
| `/` | search stations and places |
| `q` | quit the client — **playback keeps going** |

`q` leaves the daemon running by design; `bun run kill` stops the music. The
daemon also exits on its own after five idle minutes.

## The lid badge

`⚡︎ lid-safe` / `🔋 will sleep` reports what actually happens if you shut the lid.
On mains power a `caffeinate -s` assertion is held while playing and audio
survives lid-close. On battery it does not — `-s` is "valid only when system is
running on AC power" (`man caffeinate`), and lid-close sleep is handled below
userspace. The assertion is held only while something plays, so an idle daemon
never keeps the machine awake.

## How it works

```
Radio Garden API ──resolve 302──> upstream URL ──> codec?
                                       ┌───────────┴───────────┐
                                  audio/mpeg               audio/aac*
                                       │                       │
                              playStreamUrl()          ffmpeg → mp3 → playStream()
                                       └───────────┬───────────┘
                                        OpenTUI audio engine → speakers
                                                   │
                                          output tap → FFT → levels → clients
```

Playback, buffering, reconnect and ICY metadata come from
[OpenTUI](https://github.com/anomalyco/opentui)'s native audio engine, which
accepts MP3 and FLAC only — hence the ffmpeg transcode for AAC. Both paths
converge on the same output tap, which is what the spectrum reads, so the grid
tracks the audio you hear rather than a decode running ahead of it.

Design rationale, the API's undocumented behaviour, and the measurements behind
these choices are in [`doc/INTENT.md`](doc/INTENT.md).

## Layout

```
src/
  shared/protocol.ts   message types, socket paths, FrameWriter
  api/client.ts        Radio Garden API, places cache, codec routing
  daemon/
    main.ts            socket server, lifecycle, auto-skip
    player.ts          playback, codec routing, watchdogs
    spectrum.ts        FFT and per-band contribution levels
    power.ts           pmset polling and the caffeinate assertion
  client/
    tui.ts             wiring: connection, keys, bootstrap
    graph.ts           scrolling column history behind the contribution grid
    view.ts            pure rendering
probe/                 runnable checks against the live API and real audio
```

## Probes

```bash
bun probe/fft-probe.ts       # tones land in the right bands; music scatters across levels
bun probe/view-probe.ts      # headless render assertions
bun probe/api-probe.ts       # live API: search, places, codec routing
bun probe/daemon-probe.ts    # daemon end to end, spectrum frames flowing
bun probe/audio-probe.ts     # OpenTUI native playback + ICY metadata
bun probe/aac-shim-probe.ts  # ffmpeg AAC path
```

## Credits

The idea is [radio.garden](https://radio.garden/)'s — a globe you spin to hear
what a place sounds like right now. This is that, minus the globe, in a terminal.

Thanks to [jonasrmichel/radio-garden-openapi](https://jonasrmichel.github.io/radio-garden-openapi/)
for documenting the API. Radio Garden publishes no official spec, so that write-up
is what the endpoints in `src/api/client.ts` are built against.
