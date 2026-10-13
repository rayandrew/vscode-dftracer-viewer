// Fires `onIdle` once the owner has been inactive for `timeoutMs()`. A timeout
// of 0 or less disables it. Becoming active again cancels a pending fire.
export class IdleTimer {
  private timer?: NodeJS.Timeout;

  constructor(
    private timeoutMs: () => number,
    private onIdle: () => void,
  ) {}

  setActive(active: boolean): void {
    if (active) {
      this.dispose();
      return;
    }
    const ms = this.timeoutMs();
    if (this.timer || ms <= 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.onIdle();
    }, ms);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
