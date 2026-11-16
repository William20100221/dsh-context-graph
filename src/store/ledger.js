/**
 * The savings ledger of a workspace (#35): `<dir>/ledger.json`, one small entry per chat, so the
 * estimate survives restarts and the workspace total is one read. Written at most once per turn
 * per chat, off the critical path; a chat needs no folder of its own to have an entry.
 * Format: `{ v: 1, chats: { "<sessionId>": { c: counters, used: [topic ids], msgs: ["<cid>:<seq>"], at: time } } }`:
 * `msgs` are the source messages already counted as stood in for, so each counts once per chat.
 */

import { join } from 'node:path'

import { addCounters, counters, emptyCounters } from '../core/ledger.js'
import { locked, readJson, readJsonCached, writeJson } from './files.js'

const file = (dir) => join(dir, 'ledger.json')

/** Topic ids remembered per chat as used, so each counts once; the newest are kept. */
const USED_MAX = 500
const MSGS_MAX = 1000

/** The ledger, read-only (cached); empty when there is none. */
export async function loadLedger(dir) {
  const value = await readJsonCached(file(dir))
  return value && typeof value.chats === 'object' && value.chats !== null ? value : { v: 1, chats: {} }
}

/** One chat's counters, used topic ids and credited source messages. */
export async function chatEntry(dir, sid) {
  const entry = (await loadLedger(dir)).chats[String(sid)]
  return { c: counters(entry?.c), used: Array.isArray(entry?.used) ? entry.used : [], msgs: Array.isArray(entry?.msgs) ? entry.msgs : [] }
}

/** The workspace total. */
export async function workspaceTotal(dir) {
  return Object.values((await loadLedger(dir)).chats).reduce((sum, entry) => addCounters(sum, counters(entry?.c)), emptyCounters())
}

/**
 * Add `delta` to a chat's counters and remember newly used topic ids. Locked read-modify-write of
 * the one file, so two chats ending a turn together cannot undo each other.
 */
export function addToLedger(dir, sid, delta, usedIds = [], msgKeys = []) {
  return locked(`${dir}#ledger`, async () => {
    const ledger = (await readJson(file(dir))) ?? { v: 1, chats: {} }
    if (typeof ledger.chats !== 'object' || ledger.chats === null) ledger.chats = {}
    const key = String(sid)
    const prev = ledger.chats[key] ?? {}
    const used = [...new Set([...(Array.isArray(prev.used) ? prev.used : []), ...usedIds])].slice(-USED_MAX)
    const msgs = [...new Set([...(Array.isArray(prev.msgs) ? prev.msgs : []), ...msgKeys])].slice(-MSGS_MAX)
    ledger.chats[key] = { c: addCounters(counters(prev.c), delta), used, ...(msgs.length ? { msgs } : {}), at: new Date().toISOString() }
    await writeJson(file(dir), ledger)
  })
}
