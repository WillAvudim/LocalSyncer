export class AsyncWorker {
  private in_progress: boolean = false
  private trigger_after_current_one: boolean = false


  constructor(public async_worker: () => Promise<void>) { }


  Trigger() {
    if (this.in_progress) {
      this.trigger_after_current_one = true
    } else {
      this.in_progress = true
      setTimeout(() => this.Exec(), 3000)
    }
  }


  /** Used by unit tests to wait out till all items are processed. */
  IsIdle() { return !this.in_progress && !this.trigger_after_current_one }


  private async Exec(): Promise<void> {
    try {
      await this.async_worker()
    } catch (ex) {
      console.error(ex.stack)
    }

    if (this.trigger_after_current_one) {
      this.trigger_after_current_one = false
      setTimeout(() => this.Exec(), 10)
    } else {
      this.in_progress = false
    }
  }
}
