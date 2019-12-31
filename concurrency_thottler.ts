type WorkerFn = () => Promise<void>

const LIMIT: number = 64

let total_workers_running: number = 0
let queued_items: WorkerFn[] = []


export async function ScheduleOrExecute(work_item: WorkerFn): Promise<void> {
  if (total_workers_running >= LIMIT) {
    queued_items.push(work_item)
    return
  }

  ++total_workers_running

  try {
    await work_item()
  } catch (ex) {
    console.error(ex.stack)
  }

  while (queued_items.length) {
    const next_item: WorkerFn = queued_items.shift()!
    try {
      await next_item()
    } catch (ex) {
      console.error(ex.stack)
    }
  }

  --total_workers_running
}
