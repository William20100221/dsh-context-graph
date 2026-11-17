/**
 * On-disk layout under `<dir>` (default `<workspace>/.context-graph`), one folder per chat:
 *   chats/<sessionId>/meta.json    { cid, title, startedAt, lastActiveAt, turns, builtSeq,
 *                                    memoryOff?, private?, parent?, forkSeq?, legacyRoot? }
 *   chats/<sessionId>/topics.json  the chat's topic graph (src/core/graph.js, version 2)
 *   chats/<sessionId>/msgs.json    the verbatim messages its topics cite, each once (messages.js)
 *   chats/<sessionId>/graph.json   only in folders from v0.4-v0.6: read-only backup (migrate.js)
 *   chats/.cid/<n>                 empty claim files: chat number n is taken
 * Nothing is merged or copied between chats; the list of chats is the list of folders.
 * Writes to one chat folder are serialized in-process (files.js `locked`).
 */

import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { GRAPH_VERSION, emptyGraph, normalizeGraph } from '../core/graph.js'
import { mergeGaps } from '../core/session.js'
import { locked, readJson, readJsonCached, readJsonDetailed, writeJson } from './files.js'
import { TOPICS, upgradeChat } from './migrate.js'

export const chatDir = (dir, sid) => join(dir, 'chats', String(sid))

const exists = (path) => stat(path).then(() => true, () => false)

const graphOf = (value) => (value?.version === GRAPH_VERSION ? normalizeGraph(value) : undefined)

const LEGACY_CHECK_MS = 60000
const legacyChecks = new Map()

/**
 * Bring a v0.4-v0.6 `graph.json` in this folder up to date, if there is one. Readers look at most
 * once a minute per folder: that stat (and, while the old file is kept as a backup, a re-read of
 * the topics) was a third of the per-message cost at 150 chats (#33). A reader inside the minute
 * waits for the check that is still running, so a folder's first upgrade is never read half-done.
 * The builder looks on every write, so topics an older plugin copy adds to the old file are merged
 * before anything is saved. A failed check is not remembered.
 */
function legacyUpgrade(chat, writable) {
  const last = legacyChecks.get(chat)
  if (!writable && last && Date.now() - last.at < LEGACY_CHECK_MS) return last.done
  const entry = { at: Date.now(), done: exists(join(chat, 'graph.json')).then((found) => (found ? upgradeChat(chat) : false)) }
  legacyChecks.set(chat, entry)
  entry.done.catch(() => { if (legacyChecks.get(chat) === entry) legacyChecks.delete(chat) })
  return entry.done
}

/**
 * The chat's graph, upgraded from an older layout when one is present, repaired; empty when there
 * is none. Read-only and shared through the read cache (#33) unless `writable` (the builder).
 */
export async function loadGraph(chat, { writable = false } = {}) {
  await legacyUpgrade(chat, writable)
  const file = join(chat, TOPICS)
  const graph = writable ? graphOf(await readJson(file)) : await readJsonCached(file, graphOf)
  return graph ?? emptyGraph()
}

export const saveGraph = (chat, graph) => locked(chat, () => writeJson(join(chat, TOPICS), graph))

/**
 * A chat's meta (read-only). One that exists but cannot be read, or is gone while a set-aside copy
 * of it exists, reads as private with memory off (and its chat number, when that can be recovered):
 * the lost file may have said so, and memory on is the default (#50). Nothing is written here;
 * updateMeta writes the same fail-closed meta on the next change.
 */
export async function loadMeta(dir, sid) {
  const folder = chatDir(dir, sid)
  const file = join(folder, 'meta.json')
  const meta = await readJsonCached(file)
  if (meta && typeof meta === 'object') return meta
  const lost = await setAside(folder, 'meta.json')
  return lost === undefined ? undefined : Object.freeze({ ...recoverMeta(lost), private: true, memoryOff: true, recovered: true })
}

/**
 * The next free chat number. Claimed with an exclusive create, so two chats starting at once (or two
 * dsh windows on one workspace) can never share one (#11). Existing chats keep their numbers.
 */
function claimCid(dir) {
  return locked(`${dir}#cid`, async () => {
    const chats = await readChats(dir)
    let cid = chats.reduce((max, c) => Math.max(max, Number(c.meta.cid) || 0), 0) + 1
    const claims = join(dir, 'chats', '.cid')
    await mkdir(claims, { recursive: true })
    for (; ; cid++) {
      try {
        await writeFile(join(claims, String(cid)), '', { flag: 'wx' })
        return cid
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
      }
    }
  })
}

/** The newest set-aside copy of `name` in `folder` (`<name>.corrupt-<time>`), as text; undefined when there is none. */
async function setAside(folder, name) {
  let files = []
  try { files = await readdir(folder) } catch { return undefined }
  const newest = files.filter((f) => f.startsWith(`${name}.corrupt-`)).sort().at(-1)
  return newest ? readFile(join(folder, newest), 'utf8') : undefined
}

/**
 * What can still be read from an unreadable meta.json: its chat number, index and fork positions,
 * the title and summary it had (made safely before the damage), and the stretches typed while
 * memory was off (#59). A meta whose stretches cannot be read back may have had some, so every turn
 * of that chat stays closed to other chats, and no title is taken from its log (review).
 */
function recoverMeta(raw) {
  const text = String(raw ?? '')
  const number = (name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(text)
    return m ? Number(m[1]) : undefined
  }
  const string = (name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`).exec(text)
    try { return m ? JSON.parse(m[1]) : undefined } catch { return undefined }
  }
  const out = {}
  for (const name of ['cid', 'builtSeq', 'offSeq', 'forkSeq', 'closedThrough']) if (number(name) !== undefined) out[name] = number(name)
  for (const name of ['title', 'summary', 'firstKey']) if (typeof string(name) === 'string') out[name] = string(name)
  const m = /"gaps"\s*:\s*(\[(?:\s*\[\s*-?\d+\s*,\s*-?\d+\s*\]\s*,?)*\s*\])/.exec(text)
  let gaps
  try { gaps = m ? JSON.parse(m[1]) : undefined } catch { gaps = undefined }
  if (Array.isArray(gaps)) out.gaps = gaps
  // A meta repaired before stays unsure where it was (a second damage must not reopen those turns).
  if (!Array.isArray(gaps) || /"turnsClosed"\s*:\s*true/.test(text)) out.turnsClosed = true
  return out
}

/**
 * Read-modify-write of one chat's meta under the chat's lock, so a flag set by a command and a
 * build finishing at the same moment can no longer undo each other (#10). A chat seen for the first
 * time gets `init()` plus a freshly claimed chat number. A meta.json that exists but cannot be read
 * is never replaced by a fresh identity: its chat number and index position are recovered where
 * possible, and the chat fails closed (private, memory off) because the lost file may have said so.
 */
export function updateMeta(dir, sid, change = (meta) => meta, init = () => ({})) {
  return locked(chatDir(dir, sid), async () => {
    const file = join(chatDir(dir, sid), 'meta.json')
    const read = await readJsonDetailed(file)
    let meta = read.value
    if (!meta || typeof meta !== 'object') {
      // An unreadable meta may already have been set aside by a reader (listChats): use that copy.
      const lost = read.state === 'quarantined' ? read.raw : await setAside(chatDir(dir, sid), 'meta.json')
      // A fresh meta's title comes from the log, which may hold an off stretch the lost file knew of:
      // a recovered meta keeps only the title it can read back (review).
      // A fork's fresh meta holds its ancestors' off stretches (offsInherited): they join the ones
      // read back, never give way to them (second review of #69).
      const fresh = await init()
      const back = lost === undefined ? undefined : recoverMeta(lost)
      meta = back === undefined ? fresh : { ...fresh, title: undefined, ...back, ...(Array.isArray(fresh?.gaps) && Array.isArray(back.gaps) ? { gaps: mergeGaps(fresh.gaps, back.gaps) } : {}) }
      if (lost !== undefined) Object.assign(meta, { private: true, memoryOff: true, recovered: new Date().toISOString() })
      if (!Number.isInteger(meta.cid)) meta.cid = await claimCid(dir)
    }
    const next = change({ ...meta }) ?? meta
    await writeJson(file, next)
    return next
  })
}

/** Every chat folder with a readable meta.json, unsorted. Folders starting with '.' are bookkeeping. */
async function readChats(dir) {
  let names = []
  try { names = await readdir(join(dir, 'chats')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const metas = await Promise.all(names.filter((n) => !n.startsWith('.')).map(async (sid) => ({
    sid,
    // One entry that cannot be read (a stray file, a locked folder) must not hide every other chat.
    meta: await loadMeta(dir, sid).catch((error) => {
      console.error(`context-graph: skipping chat ${sid} (${error?.code ?? error?.message})`)
      return undefined
    })
  })))
  return metas.filter((c) => c.meta && typeof c.meta === 'object')
}

const migrations = new Map()

/**
 * Every chat with a readable meta.json, newest activity first. A meta.json that does not parse is
 * skipped instead of failing the whole workspace (#10). The first call for a workspace also brings
 * memory written by v0.1-v0.3 into the chat layout (#17); a migration that failed is retried by a
 * later call, at most once a minute.
 */
export async function listChats(dir) {
  const entry = migrations.get(dir)
  if (!entry || (entry.failedAt && Date.now() - entry.failedAt > 60000)) {
    const next = {}
    next.done = migrateRootLayout(dir).catch((error) => {
      next.failedAt = Date.now()
      console.error('context-graph: memory from before v0.4 is not migrated yet; retrying later', error)
    })
    migrations.set(dir, next)
  }
  await migrations.get(dir).done
  const chats = await readChats(dir)
  return chats.sort((a, b) => String(b.meta.lastActiveAt ?? '').localeCompare(String(a.meta.lastActiveAt ?? '')))
}

/**
 * v0.1-v0.3 kept one graph per workspace at `<dir>/graph.json` with sources in `<dir>/src/`; v0.4
 * moved to one folder per chat and stopped reading it, so that memory became invisible (#17).
 * The files are COPIED into a chat folder (the original session's id when every topic came from one
 * session, else `legacy`), given a meta, and upgraded; the root copy is removed only after all of
 * that succeeded, so an interrupted run simply repeats. A folder that belongs to a real chat is never
 * used as the target.
 */
export function migrateRootLayout(dir) {
  return locked(`${dir}#root`, async () => {
    const root = join(dir, 'graph.json')
    const graph = await readJson(root)
    if (!graph || typeof graph.nodes !== 'object' || graph.nodes === null) return undefined
    const nodes = Object.values(graph.nodes)
    const sessions = new Set(nodes.flatMap((n) => (Array.isArray(n.src) ? n.src : []).map((s) => s?.session)).filter(Boolean))
    const candidates = [...(sessions.size === 1 ? [String([...sessions][0])] : []), 'legacy', ...Array.from({ length: 20 }, (_, i) => `legacy-${i + 2}`)]
    let sid
    for (const name of candidates) {
      // Free, half-copied by an interrupted run (no meta.json yet), or already ours: never a real chat.
      const meta = join(chatDir(dir, name), 'meta.json')
      if (!(await exists(chatDir(dir, name))) || !(await exists(meta)) || (await loadMeta(dir, name))?.legacyRoot === true) { sid = name; break }
    }
    if (!sid) throw new Error('no free folder name for the migrated memory')
    const chat = chatDir(dir, sid)
    await mkdir(chat, { recursive: true })
    await cp(root, join(chat, 'graph.json'))
    if (await exists(join(dir, 'src'))) await cp(join(dir, 'src'), join(chat, 'src'), { recursive: true })
    const times = nodes.flatMap((n) => [n.updated, ...(Array.isArray(n.src) ? n.src : []).map((s) => s?.at)]).filter(Boolean).sort()
    const now = new Date().toISOString()
    await updateMeta(dir, sid, (meta) => ({ ...meta, legacyRoot: true }), () => ({ title: 'Memory from before v0.4', startedAt: times[0] ?? now, lastActiveAt: times.at(-1) ?? now, turns: 0 }))
    await upgradeChat(chat)
    await rm(root, { force: true })
    await rm(join(dir, 'src'), { recursive: true, force: true })
    return sid
  })
}
