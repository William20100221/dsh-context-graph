/**
 * The deepest stored layer: the verbatim messages topics were drawn from, one file per chat
 * (`chats/<sid>/msgs.json`), each message stored ONCE under its seq however many topics cite it.
 * Up to v0.6 every topic kept its own copy (3x on real data) and grew a section per rebuild (#12).
 * Format: `{ v: 1, m: { "<seq>": { r: "user"|"assistant", t: turn, a: time, x: text } } }`.
 */

import { join } from 'node:path'

import { capText } from '../core/text.js'
import { locked, readJson, readJsonCached, writeJson } from './files.js'

/** Long messages keep their head and tail (core/text.js); the full text stays in dsh's own session log. */
export { capText }

const file = (chat) => join(chat, 'msgs.json')

/** `{ [seq]: { r, t, a, x } }` for one chat, read-only (cached, #33); empty when nothing is stored yet. */
export async function loadMessages(chat) {
  const store = await readJsonCached(file(chat))
  return store && typeof store.m === 'object' && store.m !== null ? store.m : {}
}

/**
 * Add messages (`[{ seq, role, text, turn, time }]`) that are not stored yet. Idempotent: writing
 * the same seq twice is a no-op, so a build that is retried after a crash cannot duplicate text.
 */
export function saveMessages(chat, messages) {
  return locked(`${chat}#msgs`, async () => {
    const store = (await readJson(file(chat))) ?? { v: 1, m: {} }
    if (typeof store.m !== 'object' || store.m === null) store.m = {}
    let changed = false
    for (const m of messages) {
      const key = String(m.seq)
      if (!Number.isInteger(m.seq) || Object.hasOwn(store.m, key)) continue
      store.m[key] = { r: m.role, ...(m.turn ? { t: m.turn } : {}), ...(m.time ? { a: m.time } : {}), x: capText(m.text) }
      changed = true
    }
    if (changed) await writeJson(file(chat), store)
  })
}

/**
 * Give stored messages the turn `turnAt(seq)` says (#71: turn ids follow dsh's own turns now).
 * Under the lock saveMessages takes; when nothing changes, nothing is written.
 */
export function relabelTurns(chat, turnAt) {
  return locked(`${chat}#msgs`, async () => {
    const store = await readJson(file(chat))
    let changed = false
    for (const [seq, m] of Object.entries(store?.m ?? {})) {
      const t = turnAt(Number(seq))
      if (t === undefined || !m || typeof m !== 'object' || m.t === t) continue
      m.t = t
      changed = true
    }
    if (changed) await writeJson(file(chat), store)
  })
}

/** The stored messages a topic cites, oldest first: `[{ seq, role, turn, text }]`. */
export function sourceOf(messages, node) {
  return (node?.refs ?? [])
    .filter((seq) => Object.hasOwn(messages, String(seq)))
    .map((seq) => {
      const m = messages[String(seq)]
      return { seq, role: m.r, turn: m.t, text: m.x }
    })
}
