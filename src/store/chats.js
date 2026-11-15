/**
 * On-disk layout under `<dir>` (default `<workspace>/.context-graph`), one folder per chat:
 *   chats/<sessionId>/meta.json    { cid, title, workspace, startedAt, lastActiveAt, turns, builtSeq,
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
import { locked, readJson, readJsonDetailed, writeJson } from './files.js'
import { TOPICS, upgradeChat } from './migrate.js'

export const chatDir = (dir, sid) => join(dir, 'chats', String(sid))

const exists = (path) => stat(path).then(() => true, () => false)

/** The chat's graph, upgraded from an older layout when one is present, repaired; empty when there is none. */
export async function loadGraph(chat) {
  if (await exists(join(chat, 'graph.json'))) await upgradeChat(chat)
  const graph = await readJson(join(chat, TOPICS))
  return graph?.version === GRAPH_VERSION ? normalizeGraph(graph) : emptyGraph()
}

export const saveGraph = (chat, graph) => locked(chat, () => writeJson(join(chat, TOPICS), graph))

export const loadMeta = (dir, sid) => readJson(join(chatDir(dir, sid), 'meta.json'))

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

/** What can still be read from an unreadable meta.json: its chat number and index position. */
function recoverMeta(raw) {
  const number = (name) => {
    const m = new RegExp(`"${name}"\\s*:\\s*(\\d+)`).exec(String(raw ?? ''))
    return m ? Number(m[1]) : undefined
  }
  const out = {}
  if (number('cid') !== undefined) out.cid = number('cid')
  if (number('builtSeq') !== undefined) out.builtSeq = number('builtSeq')
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
      meta = { ...init(), ...(lost === undefined ? {} : recoverMeta(lost)) }
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
    await updateMeta(dir, sid, (meta) => ({ ...meta, legacyRoot: true }), () => ({ title: 'Memory from before v0.4', workspace: dir, startedAt: times[0] ?? now, lastActiveAt: times.at(-1) ?? now, turns: 0 }))
    await upgradeChat(chat)
    await rm(root, { force: true })
    await rm(join(dir, 'src'), { recursive: true, force: true })
    return sid
  })
}
