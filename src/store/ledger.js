/**
 * The savings ledger of a workspace (#35): one small file per chat, `<dir>/ledger/<sessionId>.json`,
 * so the estimate survives restarts and a turn end writes only its own chat's entry, not the whole
 * workspace's (#83). Written once per turn per chat and when an index outside a turn end ends
 * (#105), off the critical path; a chat needs no folder of its own to have an entry, and its entry
 * stays when its memory is deleted (#107).
 * Format: `{ v: 2, c: counters, used: [topic ids], chats: ["c3"] }`, zero counters and empty lists
 * left out (#78): `chats` are the earlier chats whose history this chat already counted, each once
 * (#104). An entry without `v: 2` (0.16 and before counted source messages, `msgs`) is converted
 * once by convertLedger. `<dir>/ledger.json`, the one file 0.9.0 kept (`{ v: 1, chats: {
 * "<sessionId>": entry } }`), is only read: a chat's entry there is where its own file starts.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { addCounters, counters, emptyCounters, historyTokens } from '../core/ledger.js'
import { idMapper } from '../core/numbers.js'
import { chatDir, listChats } from './chats.js'
import { loadMessages } from './messages.js'
import { locked, readJson, readJsonCached, writeJson } from './files.js'

const folder = (dir) => join(dir, 'ledger')
const file = (dir, sid) => join(folder(dir), `${sid}.json`)

/** Topic ids remembered per chat as used, so each counts once; the newest are kept. */
const USED_MAX = 500
const CHATS_MAX = 1000

/** The entries 0.9.0 kept in one file, read-only (cached: nothing writes that file any more). */
async function oldEntries(dir) {
  const value = await readJsonCached(join(dir, 'ledger.json'))
  return value && typeof value.chats === 'object' && value.chats !== null ? value.chats : {}
}

/** Every chat's entry, read-only (cached per file): `{ v: 1, chats: { "<sessionId>": entry } }`. */
export async function loadLedger(dir) {
  const chats = { ...(await oldEntries(dir)) }
  let names = []
  try { names = (await readdir(folder(dir))).filter((name) => name.endsWith('.json')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const entries = await Promise.all(names.map((name) => readJsonCached(join(folder(dir), name))))
  names.forEach((name, i) => { if (entries[i]) chats[name.slice(0, -'.json'.length)] = entries[i] })
  return { v: 1, chats }
}

/** One chat's counters, used topic ids and the earlier chats whose history it counted. */
export async function chatEntry(dir, sid) {
  const entry = (await readJsonCached(file(dir, sid))) ?? (await oldEntries(dir))[String(sid)]
  return { v: entry?.v, c: counters(entry?.c), used: Array.isArray(entry?.used) ? entry.used : [], chats: Array.isArray(entry?.chats) ? entry.chats : [] }
}

/**
 * An entry written before #104 as the old-total rule would have it: from the topics it recorded as
 * used, each earlier chat they came from counts its whole kept conversation, once. The cost terms
 * are kept; the old stand-in count goes (counters() drops it). An entry already converted is kept.
 */
async function upgraded(dir, prev) {
  if (!prev || prev.v === 2) return prev
  const used = Array.isArray(prev.used) ? prev.used : []
  const cids = [...new Set(used.map((id) => /^c(\d+)n/.exec(String(id))?.[1]).filter(Boolean))]
  const chats = cids.length > 0 ? await listChats(dir) : []
  let history = 0
  for (const cid of cids) {
    const chat = chats.find((c) => String(c.meta.cid) === cid)
    if (chat) history += historyTokens(await loadMessages(chatDir(dir, chat.sid)).catch(() => ({})))
  }
  return { v: 2, c: { ...counters(prev.c), history }, used, chats: cids.map((cid) => `c${cid}`) }
}

/** The entry as written: version 2, zero counters and empty lists left out. */
const written = (entry) => {
  const c = Object.fromEntries(Object.entries(counters(entry.c)).filter(([, n]) => n !== 0))
  return { v: 2, c, ...(entry.used?.length ? { used: entry.used } : {}), ...(entry.chats?.length ? { chats: entry.chats } : {}) }
}

/** Convert a chat's entry written before #104, once (the start-up sweep, a chat's first credit). */
export function convertLedger(dir, sid) {
  const path = file(dir, sid)
  return locked(path, async () => {
    const prev = (await readJson(path)) ?? (await oldEntries(dir))[String(sid)]
    if (!prev || prev.v === 2) return false
    await writeJson(path, written(await upgraded(dir, prev)))
    return true
  })
}

/**
 * After chats were renumbered (#109), every chat's used topic ids and counted chats in the new
 * numbers; a deleted chat's are dropped, so the chat that takes its number later is not taken for
 * it. Entries from before #104 are converted first (convertLedger), by the numbers they were
 * written with. Runs inside the numbering lock, so no chat gets a number meanwhile.
 * ponytail: an app quit between the metas and this leaves old keys (one chat counted twice at most).
 */
export async function remapLedgers(dir, renumbering) {
  const map = idMapper(renumbering)
  let names = []
  try { names = (await readdir(folder(dir))).filter((name) => name.endsWith('.json')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  for (const name of names) {
    const path = join(folder(dir), name)
    await locked(path, async () => {
      const prev = await readJson(path)
      if (!prev || prev.v !== 2) return
      const ids = (list) => (Array.isArray(list) ? list.map(map).filter(Boolean) : [])
      await writeJson(path, written({ c: prev.c, used: ids(prev.used), chats: ids(prev.chats) }))
    })
  }
}

/** The workspace total. */
export async function workspaceTotal(dir) {
  return Object.values((await loadLedger(dir)).chats).reduce((sum, entry) => addCounters(sum, counters(entry?.c)), emptyCounters())
}

/**
 * Add `delta` to a chat's counters and remember newly used topic ids. Locked read-modify-write of
 * the chat's own file, so two writes for one chat (a slow turn end, then the next) cannot undo each other.
 */
export function addToLedger(dir, sid, delta, usedIds = [], chatKeys = []) {
  const path = file(dir, sid)
  return locked(path, async () => {
    // An entry from before #104 is converted in the same write, so it is never marked converted
    // without its old total (a turn that only adds costs comes first, say).
    const prev = (await upgraded(dir, (await readJson(path)) ?? (await oldEntries(dir))[String(sid)])) ?? {}
    const used = [...new Set([...(Array.isArray(prev.used) ? prev.used : []), ...usedIds])].slice(-USED_MAX)
    const chats = [...new Set([...(Array.isArray(prev.chats) ? prev.chats : []), ...chatKeys])].slice(-CHATS_MAX)
    await writeJson(path, written({ c: addCounters(counters(prev.c), delta), used, chats }))
  })
}
