import { appendFileSync } from "fs"

const target = process.env.RG_DEBUG
/** console.log is unusable inside a TUI; set RG_DEBUG=/path/to/log to trace. */
export function debug(...parts: unknown[]): void {
  if (!target) return
  const line = parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ")
  try {
    appendFileSync(target, `${new Date().toISOString().slice(11, 23)} ${line}\n`)
  } catch {}
}
