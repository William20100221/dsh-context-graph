/**
 * The savings ledger of a workspace (#35): one small file per chat, `<dir>/ledger/<sessionId>.json`,
 * so the estimate survives restarts and a turn end writes only its own chat's entry, not the whole
 * workspace's (#83). Written at most once per turn per chat, off the critical path; a chat needs no
 * folder of its own to have an entry.
 * Format: `{ c: counters, used: [topic ids], msgs: ["<cid>:<seq>"] }`, zero counters and empty lists
 * left out (#78): `msgs` are the source messages already counted as stood in for, so each counts
 * once per chat. `<dir>/ledger.json`, the one file 0.9.0 kept (`{ v: 1, chats: { "<sessionId>":
 * entry } }`), is only read: a chat's entry there is where its own file starts.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import { addCounters, counters, emptyCounters } from '../core/ledger.js'
import { locked, readJson, readJsonCached, writeJson } from './files.js'

const folder = (dir) => join(dir, 'ledger')
const file = (dir, sid) => join(folder(dir), `${sid}.json`)

/** Topic ids remembered per chat as used, so each counts once; the newest are kept. */
const USED_MAX = 500
const MSGS_MAX = 1000

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

/** One chat's counters, used topic ids and credited source messages. */
export async function chatEntry(dir, sid) {
  const entry = (await readJsonCached(file(dir, sid))) ?? (await oldEntries(dir))[String(sid)]
  return { c: counters(entry?.c), used: Array.isArray(entry?.used) ? entry.used : [], msgs: Array.isArray(entry?.msgs) ? entry.msgs : [] }
}

/** The workspace total. */
export async function workspaceTotal(dir) {
  return Object.values((await loadLedger(dir)).chats).reduce((sum, entry) => addCounters(sum, counters(entry?.c)), emptyCounters())
}

/**
 * Add `delta` to a chat's counters and remember newly used topic ids. Locked read-modify-write of
 * the chat's own file, so two writes for one chat (a slow turn end, then the next) cannot undo each other.
 */
export function addToLedger(dir, sid, delta, usedIds = [], msgKeys = []) {
  const path = file(dir, sid)
  return locked(path, async () => {
    const prev = (await readJson(path)) ?? (await oldEntries(dir))[String(sid)] ?? {}
    const used = [...new Set([...(Array.isArray(prev.used) ? prev.used : []), ...usedIds])].slice(-USED_MAX)
    const msgs = [...new Set([...(Array.isArray(prev.msgs) ? prev.msgs : []), ...msgKeys])].slice(-MSGS_MAX)
    const c = Object.fromEntries(Object.entries(addCounters(counters(prev.c), delta)).filter(([, n]) => n !== 0))
    await writeJson(path, { c, ...(used.length ? { used } : {}), ...(msgs.length ? { msgs } : {}) })
  })
}
