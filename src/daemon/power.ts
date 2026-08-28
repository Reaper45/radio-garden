import { spawn, type ChildProcess } from "child_process"
import { execFile } from "child_process"
import { promisify } from "util"
import type { PowerState } from "../shared/protocol"

const exec = promisify(execFile)

/**
 * macOS has two sleeps and only one is ours to prevent (INTENT OPEN-1).
 *
 * `caffeinate -i` blocks idle sleep on any power source. Lid-close sleep is
 * handled below userspace: `man caffeinate` says `-s` is "valid only when system
 * is running on AC power". On battery with the lid shut the machine sleeps no
 * matter what we assert, so we report the truth rather than pretend.
 */
export class PowerManager {
  private proc: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private _state: PowerState = "battery"
  private wanted = false

  constructor(private readonly onChange: (state: PowerState, lidSafe: boolean) => void) {}

  get state(): PowerState {
    return this._state
  }

  /** True only when a closed lid will actually keep playing. */
  get lidSafe(): boolean {
    return this._state === "ac" && this.proc !== null
  }

  async start(): Promise<void> {
    await this.poll()
    this.timer = setInterval(() => void this.poll(), 15_000)
    this.timer.unref?.()
  }

  /** Assertion is held only while playing — an idle daemon must not drain the battery. */
  setPlaying(playing: boolean): void {
    this.wanted = playing
    this.reconcile()
  }

  private async poll(): Promise<void> {
    let next: PowerState = this._state
    try {
      const { stdout } = await exec("/usr/bin/pmset", ["-g", "batt"])
      next = stdout.includes("AC Power") ? "ac" : "battery"
    } catch {
      // if pmset is unavailable, assume battery — the pessimistic answer
      next = "battery"
    }
    const changed = next !== this._state
    this._state = next
    this.reconcile()
    if (changed) this.onChange(this._state, this.lidSafe)
  }

  private reconcile(): void {
    if (this.wanted && !this.proc) {
      // -s survives lid close on AC; -i keeps idle sleep away on battery too
      this.proc = spawn("/usr/bin/caffeinate", ["-s", "-i"], { stdio: "ignore" })
      this.proc.unref()
      this.proc.on("exit", () => {
        this.proc = null
      })
    } else if (!this.wanted && this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.wanted = false
    this.reconcile()
  }
}
