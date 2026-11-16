/**
 * JSON files on disk, written so that concurrent writers and crashes cannot leave a half-written
 * file, and read so that one damaged file can neither take the rest of the memory down nor be
 * silently overwritten.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Index just past the first complete top-level JSON value in `raw` (string-aware), or 0. */
function firstValueEnd(raw) {
  let depth = 0
  let inString = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
    } else if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') depth++
    else if ((ch === '}' || ch === ']') && --depth === 0) return i + 1
  }
  return 0
}

/**
 * The JSON value at the start of `raw` when only junk follows it: what v0.6's interleaved writes
 * left behind. Cut where the parser says the junk starts, else after the first complete value; both
 * are one pass, however long the junk (#54).
 */
function salvage(raw, error) {
  const at = /at position (\d+)/.exec(String(error?.message))
  for (const end of [at ? Number(at[1]) : 0, firstValueEnd(raw)]) {
    if (end <= 0) continue
    try { return JSON.parse(raw.slice(0, end)) } catch { /* try the next cut */ }
  }
  return undefined
}

/**
 * Read a JSON file and say what was found:
 *   { state: 'ok', value }          parsed
 *   { state: 'missing' }            no such file
 *   { state: 'salvaged', value }    trailing junk cut off (v0.6 could leave it); the next write repairs the file
 *   { state: 'quarantined', raw }   unreadable; moved aside to `<file>.corrupt-<time>` so nothing overwrites it
 * Errors other than "no such file" are thrown: the caller must not treat them as missing data (#10).
 * So is an unreadable file that cannot be moved aside (#79).
 */
export async function readJsonDetailed(path) {
  let raw
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' }
    throw error
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) }
  } catch (error) {
    const repaired = salvage(raw, error)
    if (repaired !== undefined) {
      console.error(`context-graph: repaired ${path} (${error.message}); it is rewritten on the next save`)
      return { state: 'salvaged', value: repaired }
    }
    const aside = `${path}.corrupt-${Date.now()}`
    // Gone: another reader moved it first. Any other failure (on Windows a sync tool or a scan that
    // holds the file: EBUSY) leaves it in place, and reading it as missing let a memory-off chat
    // read as on and a writer replace the file with no copy kept (#79).
    try { await rename(path, aside) } catch (error) { if (error?.code !== 'ENOENT') throw error }
    console.error(`context-graph: ${path} is unreadable (${error.message}); kept as ${aside}`)
    return { state: 'quarantined', raw }
  }
}

/** Parsed JSON, or undefined when the file is missing or unreadable (see readJsonDetailed). */
export async function readJson(path) {
  return (await readJsonDetailed(path)).value
}

const cache = new Map()
// Two or three entries per chat are read on every message, so the cap sits far above any real
// workspace: at 2,000 a workspace of 1,500 chats evicted what the same pass needed next and took
// about 1 s per message (#63). ponytail: entry count, not bytes; size by bytes if memory matters.
const CACHE_MAX = 20000

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/**
 * Parsed JSON for READ-ONLY use, cached by the file's stat (#33): while a file is unchanged it is
 * not read or parsed again, which took the per-message cost at 150 chats from 37 ms of reads to a
 * few stats. `prepare(value)` runs once per change (to normalize a graph). The result is frozen and
 * shared, so code that tries to change it fails loudly instead of corrupting every later read.
 * Writers use readJson / readJsonDetailed.
 */
export async function readJsonCached(path, prepare = (value) => value) {
  let st
  try {
    st = await stat(path)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    cache.delete(path)
    return undefined
  }
  const key = `${st.mtimeMs}:${st.size}:${st.ino}`
  const hit = cache.get(path)
  if (hit?.key === key) {
    cache.delete(path)
    cache.set(path, hit)
    return hit.value
  }
  const read = await readJsonDetailed(path)
  const value = read.value === undefined ? undefined : deepFreeze(prepare(read.value))
  // A repaired value is cached too, so the repair (and its log line) happens once per change of the
  // file, not on every message until the next save rewrites it.
  if (read.state === 'ok' || read.state === 'salvaged') {
    cache.set(path, { key, value })
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }
  return value
}

/**
 * Rename with a retry: on Windows a rename over a file fails while anyone has that file open, even
 * for a moment (another chat reading it, a sync tool, a virus scan, which can take seconds on a
 * busy machine). Backing off for up to about 5 s outlasts such holds; the old 250 ms lost a meta
 * write now and then under load (review). Writes are off the critical path, so waiting costs nothing.
 */
export async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt < 11 && (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES')) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(800, 25 * 2 ** attempt)))
        continue
      }
      throw error
    }
  }
}

/**
 * Atomic write: a uniquely named temp file, then rename over the target. A shared temp name let two
 * concurrent writes interleave and corrupt the file (#10).
 */
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value), 'utf8')
  try {
    await renameRetry(tmp, path)
  } catch (error) {
    await rm(tmp, { force: true })
    throw error
  }
}

const chains = new Map()

/**
 * Run `fn` after every earlier call with the same key has settled, so read-modify-write sequences on
 * one chat folder never interleave inside this process. Never call `locked` with a key from inside
 * a callback holding the same key: it would wait for itself. ponytail: in-process only; two dsh
 * processes writing one workspace still race (chat numbers are protected separately, see chats.js).
 */
export function locked(key, fn) {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(fn, fn)
  const tail = run.then(() => {}, () => {})
  chains.set(key, tail)
  tail.then(() => { if (chains.get(key) === tail) chains.delete(key) })
  return run
}
