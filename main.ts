import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import * as os from 'os'

import * as chokidar from 'chokidar'
import * as fse from 'fs-extra'
import { AsyncWorker } from "./mq3"
import { TransformBackward, TransformForward } from "./transformation"
import { ScheduleOrExecute } from "./concurrency_thottler"


const fs_stat = util.promisify(fs.stat)
const fs_access = util.promisify(fs.access)
const fs_utimes = util.promisify(fs.utimes)


const SRC_PATH: string = `/storage/mono`
const TARGET_PATH: string = `/storage/Dropbox/mono`
const STATE_LOCATION: string = path.join(os.homedir(), `.dropbox_serializer_state`)

const IGNORED_OBJECTS: string[] = ["**/out/**", "**/node_modules/**", "**/package-lock.json", "**/.ropeproject/**", "**/__pycache__/**", "**/.ipynb_checkpoints/**"]

type FSSetOfSources = { [full_path: string]: number }
type FileTransformer = (from_path: string, to_path: string) => Promise<void>

/** Lists source files that are known to have been copied to the target location before. */
let serialized_states = new class {
  from_source: FSSetOfSources = Object.create(null)
  from_target: FSSetOfSources = Object.create(null)
}
const serializer = new AsyncWorker(async () => {
  await fse.writeJSON(STATE_LOCATION, serialized_states)
})


async function MonitorAtAndCopyTo(at: string, to: string, sources: FSSetOfSources, transformer: FileTransformer): Promise<void> {

  // Lose entries for the no longer existing source files.
  for (const full_path of Object.keys(sources)) {
    try {
      await fs_access(full_path)
    } catch (ex) {
      // Correct thing to do since if it was deleted in the interim, the opposite scanner will detect it and remove it at the target as well, if it's still there.
      console.log(`Removing from local cache: ${full_path}`)
      delete sources[full_path]
    }
  }

  serializer.Trigger()

  const watcher = chokidar.watch(at, {
    ignored: IGNORED_OBJECTS,
    depth: 25,
    ignoreInitial: false,
    alwaysStat: true,
    followSymlinks: false,
    awaitWriteFinish: {
      stabilityThreshold: 5000,
      pollInterval: 1000
    },
  })

  watcher.on("all", async (event_name, full_path, stats) => {
    // If the stats is missing, it might be something atomically renaming/replacing it, so let's give it a few chances, it might reappear.
    if (!stats) {
      await AsyncDelay(2000)
      try {
        // 1st chance.
        stats = await fs_stat(full_path)
      } catch (ex) {
        await AsyncDelay(3000)
        try {
          // last chance.
          stats = await fs_stat(full_path)
        } catch (ex) {
          console.log(`CONSIDERED DELETED: ${full_path}`)
        }
      }
    }

    const to_full_path: string = full_path.replace(at, to)
    try {
      await ProcessWatcherEvent(full_path, stats, to_full_path, sources, transformer)
    } catch (ex) {
      console.error(ex.stack)
    }
  })
}


async function ProcessWatcherEvent(full_path: string, stats: fs.Stats | undefined, to_full_path: string, sources: FSSetOfSources, transformer: FileTransformer): Promise<void> {

  if (!stats) {
    console.log(`DELETING ${to_full_path}`)
    // Triggered when the file has just been deleted.
    await fse.remove(to_full_path)

    delete sources[full_path]
    serializer.Trigger()
    return
  }

  if (!stats.isFile()) return

  if (stats.isSymbolicLink() || stats.isSocket()) {
    console.log(`Ignored (symbolic or socket): ${full_path}`)
    return
  }

  await CompareAndCopy(full_path, stats, to_full_path, sources, transformer)
}


async function CompareAndCopy(from: string, from_stats: fs.Stats, to: string, sources: FSSetOfSources, transformer: FileTransformer): Promise<void> {
  try {
    const to_stats = await fs_stat(to)

    if (from_stats.mtimeMs > to_stats.mtimeMs) {
      await ScheduleOrExecute(async () => {
        console.log(`COPYING ${from} -> ${to}`)
        await transformer(from, to)
        // Preserve original timestamps.
        await fs_utimes(to, from_stats.atime, from_stats.mtime)

        sources[from] = 1
        serializer.Trigger()
      })
    } else {
      sources[from] = 1
      serializer.Trigger()
    }
  } catch (ex) {
    if (FileMissingException(ex)) {
      if (sources[from]) {
        // Deleted from the target location, delete locally.
        console.log(`DELETED AT TARGET: x ${from}`)
        await fse.remove(from)
        delete sources[from]
        serializer.Trigger()
      } else {
        await ScheduleOrExecute(async () => {
          // A new file, copy.
          console.log(`NEW: ${from} -> ${to}`)
          await fse.ensureDir(path.dirname(to))
          await transformer(from, to)
          // Preserve original timestamps.
          await fs_utimes(to, from_stats.atime, from_stats.mtime)

          sources[from] = 1
          serializer.Trigger()
        })
      }

      return
    }

    console.error(ex.stack)
  }
}


function FileMissingException(ex: any): boolean {
  return ex?.code == "ENOENT"
}


async function Initialize(): Promise<void> {
  try {
    serialized_states = await fse.readJSON(STATE_LOCATION)
  } catch (ex) {
    if (!FileMissingException(ex)) {
      console.error(ex)
      throw ex
    }
  }

  MonitorAtAndCopyTo(SRC_PATH, TARGET_PATH, serialized_states.from_source, TransformForward).catch(ex => console.error(ex.stack))
  MonitorAtAndCopyTo(TARGET_PATH, SRC_PATH, serialized_states.from_target, TransformBackward).catch(ex => console.error(ex.stack))
}


function AsyncDelay(wait_milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, wait_milliseconds)
  })
}


Initialize().catch(ex => console.error(ex.stack))
