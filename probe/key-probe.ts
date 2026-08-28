import { createCliRenderer, BoxRenderable, SelectRenderable, SelectRenderableEvents, TextRenderable } from "@opentui/core"
import { appendFileSync } from "fs"
const log = (s: string) => appendFileSync("/tmp/keys.log", s + "\n")
const r = await createCliRenderer({ targetFps: 30, exitOnCtrlC: true })
const box = new BoxRenderable(r, { id: "b", flexDirection: "column", width: "100%", height: "100%" })
r.root.add(box)
box.add(new TextRenderable(r, { id: "t", content: "key probe" }))
const sel = new SelectRenderable(r, {
  id: "s", flexGrow: 1,
  options: [
    { name: "alpha", description: "first", value: "a" },
    { name: "beta", description: "second", value: "b" },
    { name: "gamma", description: "third", value: "c" },
  ],
})
box.add(sel)
sel.on(SelectRenderableEvents.SELECTION_CHANGED, (i: number) => log(`SELECTION_CHANGED index=${i}`))
sel.on(SelectRenderableEvents.ITEM_SELECTED, (i: number, opt: any) => log(`ITEM_SELECTED index=${i} name=${opt?.name}`))
r.keyInput.on("keypress", (k) => log(`keypress name=${k.name} seq=${JSON.stringify(k.sequence)} ctrl=${k.ctrl}`))
sel.focus()
log(`focused=${(sel as any).focused ?? "?"}`)
r.start()
setTimeout(() => { r.destroy(); process.exit(0) }, 9000)
