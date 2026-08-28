# radio-garden

A terminal client for [radio.garden](https://radio.garden/): browse stations by
place, play one, and watch a live ASCII spectrum of the audio. Playback runs in a
background daemon, so it survives closing the terminal — and a closed lid, when
you're on mains power.

```
 radio.garden                                                 ⚡︎ lid-safe
┌────────────────────────────────────────────────────────────────────────┐
│ KUTX FM 98.9                                                           │
│ Austin TX, United States                                               │
│ ♪ Khruangbin — August 10                                               │
│   ▁▂▂▃▄▄▅▆▇▇█  ▁▂▃▃▄▅▅▆▇▇█ ▁▁▂▃▃▄▅▆▆▇██ ▁▁▂▃▄▄▅▆▆▇█  ▁▂▂▃▄▄▅▆▇▇█  ▁▂   │
└────────────────────────────────────────────────────────────────────────┘
┌─ Austin TX, United States ─────────────────────────────────────────────┐
│  ▶ KUTX FM 98.9                                                        │
│    Austin TX, United States                                            │
│    Boss Country Radio                                                  │
│    Austin TX, United States  · ad                                      │
└────────────────────────────────────────────────────────────────────────┘
↑↓ move   ⏎ play   space stop   n next   / search   q quit
```

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
                                              output tap → FFT → bars → clients
```

Playback, buffering, reconnect and ICY metadata come from
[OpenTUI](https://github.com/anomalyco/opentui)'s native audio engine, which
accepts MP3 and FLAC only — hence the ffmpeg transcode for AAC. Both paths
converge on the same output tap, which is what the spectrum reads, so the bars
track the audio you hear rather than a decode running ahead of it.

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
    spectrum.ts        FFT and bar magnitudes
    power.ts           pmset polling and the caffeinate assertion
  client/
    tui.ts             wiring: connection, keys, bootstrap
    view.ts            pure rendering
probe/                 runnable checks against the live API and real audio
```

## Probes

```bash
bun probe/fft-probe.ts       # tones land in the right log buckets
bun probe/view-probe.ts      # headless render assertions
bun probe/api-probe.ts       # live API: search, places, codec routing
bun probe/daemon-probe.ts    # daemon end to end, bars flowing
bun probe/audio-probe.ts     # OpenTUI native playback + ICY metadata
bun probe/aac-shim-probe.ts  # ffmpeg AAC path
```
