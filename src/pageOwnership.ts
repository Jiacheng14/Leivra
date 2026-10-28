const LOCK_NAME = 'leivra.chat.write.v1'

// Web Locks are supplied by the browser's storage partition and released on page death.
// Without them, this page must remain read-only; localStorage leases are not atomic.
export class PageOwnership {
  private epoch = 0
  private abort?: AbortController
  private release?: () => void
  private owned = false
  private failed = false
  constructor(
    private locks: Pick<LockManager, 'request'> | undefined,
    private onAcquire: () => void,
    private onRelease: () => void,
    private onUnavailable: () => void
  ) {}
  get available() { return Boolean(this.locks) && !this.failed }
  get isOwner() { return this.owned }
  start() {
    if (!this.available || !this.locks || this.abort) return
    const epoch = ++this.epoch
    const abort = new AbortController()
    this.abort = abort
    void this.locks.request(LOCK_NAME, { mode: 'exclusive', signal: abort.signal }, async lock => {
      if (!lock || epoch !== this.epoch) return
      this.owned = true
      try {
        this.onAcquire()
        await new Promise<void>(resolve => { this.release = resolve })
      } finally {
        this.release = undefined
        if (this.owned) { this.owned = false; this.onRelease() }
      }
    }).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      this.failed = true
      this.onUnavailable()
    }).finally(() => { if (this.abort === abort) this.abort = undefined })
  }
  stop() {
    this.epoch++
    this.abort?.abort()
    this.abort = undefined
    if (this.owned) { this.owned = false; this.onRelease() }
    this.release?.()
  }
}
