/*
  Does NOT track NEW files added in the root directory after the program is started. Those are picked up only once at the app start.
*/
import * as fs from 'fs'
import * as path from 'path'
import * as util from 'util'
import * as os from 'os'

import * as chokidar from 'chokidar'
import * as fse from 'fs-extra'
import { AsyncWorker } from "./mq3"


export const fs_readdir = util.promisify(fs.readdir)
export const fs_stat = util.promisify(fs.stat)
export const fs_access = util.promisify(fs.access)


const SRC_PATH: string = `/storage/mono`
const TARGET_PATH: string = `/storage/Dropbox/mono`
const STATE_LOCATION: string = path.join(os.homedir(), `.dropbox_serializer_state`)

const IGNORE_SUB_OBJECTS: string[] = [
  `out`,
  `node_modules`,
  `package-lock.json`
]

const IGNORED_GLOBABLLY = /\/(\.ropeproject|__pycache__|\.ipynb_checkpoints)\//

type FSSetOfSources = { [full_path: string]: number }

/** Lists source files that are known to have been copied to the target location before. */
let serialized_states = new class {
  from_source: FSSetOfSources = Object.create(null)
  from_target: FSSetOfSources = Object.create(null)
}
const serializer = new AsyncWorker(async () => {
  await fse.writeJSON(STATE_LOCATION, serialized_states)
})

const ignored_sub_map: { [name: string]: boolean } = ToObject(IGNORE_SUB_OBJECTS, v => v, v => true)


async function MonitorAtAndCopyTo(at: string, to: string, sources: FSSetOfSources): Promise<void> {

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

  const root_entries: string[] = await fs_readdir(at)
  const paths_to_monitor: string[] = []
  for (const entry of root_entries) {
    if (ignored_sub_map[entry] || entry.match(IGNORED_GLOBABLLY)) continue
    paths_to_monitor.push(path.join(at, entry))
  }

  const watcher = chokidar.watch(paths_to_monitor, {
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
      await ProcessWatcherEvent(full_path, stats, to_full_path, sources)
    } catch (ex) {
      console.error(ex.stack)
    }
  })
}


async function ProcessWatcherEvent(full_path: string, stats: fs.Stats | undefined, to_full_path: string, sources: FSSetOfSources): Promise<void> {

  if (full_path.match(IGNORED_GLOBABLLY)) {
    console.log(`Ignored globally: ${full_path}`)
    return
  }

  if (!stats) {
    console.log(`DELETING ${to_full_path}`)
    // Triggered when the file has just been deleted.
    debugger  // DO: verify the delete below
    await fse.remove(to_full_path)

    delete sources[full_path]
    serializer.Trigger()
    return
  }
  if (!stats.isFile()) {
    // console.log(`Ignored (not a file): ${full_path}`)
    return
  }
  if (stats.isSymbolicLink() || stats.isSocket()) {
    console.log(`Ignored (symbolic or socket): ${full_path}`)
    return
  }

  await CompareAndCopy(full_path, stats, to_full_path, sources)
}


async function CompareAndCopy(from: string, from_stats: fs.Stats, to: string, sources: FSSetOfSources): Promise<void> {
  try {
    const to_stats = await fs_stat(to)

    if (from_stats.mtimeMs > to_stats.mtimeMs) {
      console.log(`COPYING ${from} -> ${to}`)
      await fse.copy(from, to, { preserveTimestamps: true })
    }

    sources[from] = 1
    serializer.Trigger()
  } catch (ex) {
    if (FileMissingException(ex)) {
      if (sources[from]) {
        debugger  // DO:
        // Deleted from the target location, delete locally.
        console.log(`DELETED AT TARGET: x ${from}`)
        await fse.remove(from)
        delete sources[from]
        serializer.Trigger()
      } else {
        // A new file, copy.
        console.log(`NEW: ${from} -> ${to}`)
        await fse.ensureDir(path.dirname(to))
        await fse.copy(from, to, { preserveTimestamps: true })
        sources[from] = 1
        serializer.Trigger()
      }

      return
    }

    console.error(ex.stack)
  }
}


function FileMissingException(ex: any): boolean {
  return ex?.code == "ENOENT"
}


function ToObject<ArrayType, MapValueType>(array: ArrayType[] | Iterable<ArrayType>, produce_key_fn: (e: ArrayType) => string | number, produce_value_fn: (e: ArrayType) => MapValueType | undefined): { [key: string]: MapValueType } {

  const o: { [key: string]: MapValueType } = Object.create(null)
  for (const element of array) {
    const value: any = produce_value_fn(element)
    if (value !== undefined) o[produce_key_fn(element)] = value
  }

  return o
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

  MonitorAtAndCopyTo(SRC_PATH, TARGET_PATH, serialized_states.from_source).catch(ex => console.error(ex.stack))
  MonitorAtAndCopyTo(TARGET_PATH, SRC_PATH, serialized_states.from_target).catch(ex => console.error(ex.stack))
}


function AsyncDelay(wait_milliseconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, wait_milliseconds)
  })
}


Initialize().catch(ex => console.error(ex.stack))
