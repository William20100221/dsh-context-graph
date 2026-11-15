/**
 * JSON files on disk, written so that concurrent writers and crashes cannot leave a half-written
 * file, and read so that one damaged file can neither take the rest of the memory down nor be
 * silently overwritten.
 */

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Longest prefix of `raw` that parses: repairs a file with trailing bytes from an interleaved write. */
function salvage(raw) {
  let end = raw.length
  for (let tries = 0; tries < 64; tries++) {
    end = raw.lastIndexOf('}', end - 1)
    if (end < 0) return undefined
    try { return JSON.parse(raw.slice(0, end + 1)) } catch { /* keep looking */ }
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
    const repaired = salvage(raw)
    if (repaired !== undefined) {
      console.error(`context-graph: repaired ${path} (${error.message}); it is rewritten on the next save`)
      return { state: 'salvaged', value: repaired }
    }
    const aside = `${path}.corrupt-${Date.now()}`
    try { await rename(path, aside) } catch { /* another reader moved it first */ }
    console.error(`context-graph: ${path} is unreadable (${error.message}); kept as ${aside}`)
    return { state: 'quarantined', raw }
  }
}

/** Parsed JSON, or undefined when the file is missing or unreadable (see readJsonDetailed). */
export async function readJson(path) {
  return (await readJsonDetailed(path)).value
}

/** Rename with a short retry: on Windows a rename fails for a moment while another process has the file open. */
export async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      if (attempt < 4 && (error?.code === 'EPERM' || error?.code === 'EBUSY' || error?.code === 'EACCES')) {
        await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
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
