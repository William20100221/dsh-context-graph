/**
 * The deepest stored layer: the verbatim messages topics were drawn from, one file per chat
 * (`chats/<sid>/msgs.json`), each message stored ONCE under its seq however many topics cite it.
 * Up to v0.6 every topic kept its own copy (3x on real data) and grew a section per rebuild (#12).
 * Format: `{ v: 2, complete?: true, m: { "<seq>": { r: "user"|"assistant", t: turn, a: time, x: text } } }`,
 * `t` being dsh's own turn number (#71); a `v: 1` store (up to 0.9.0) counted typed prompts instead.
 * Since 0.13.0 (#93) every message indexing reads is stored, whole (keepText), not only the cited
 * ones cut to their head and tail; `complete` says the store holds every message of the indexed span
 * (a chat first indexed by 0.13.0, or one completed from dsh's log by host/keeper.js).
 */

import { join } from 'node:path'

import { capText } from '../core/text.js'
import { locked, readJson, readJsonCached, writeJson } from './files.js'

export { capText }

/**
 * What is stored of one message (#93): all of it, up to 200,000 characters; a longer one (a pasted
 * log) keeps its first 160,000 and last 40,000. What the model is sent is capped by recall's own
 * token budgets, not by this.
 */
export const keepText = (text) => capText(text, 160000, 40000)

/** The mark a message cut by 0.12.0 and before carries: such a copy is replaced by a whole one. */
const CUT = /\n…\[\d+ chars omitted; the full turn is in the chat's dsh log\]…\n/

const file = (chat) => join(chat, 'msgs.json')

/**
 * The store for READ-ONLY use (cached, #33). A file that cannot be read now (a damaged one another
 * program holds, #79) reads as nothing stored: readers show no source instead of failing the whole
 * block or recall, as the page and the savings estimate already did (review of #79). Writers use readJson.
 */
const readStore = (chat) => readJsonCached(file(chat)).catch(() => undefined)

/** `{ [seq]: { r, t, a, x } }` for one chat, read-only; empty when nothing is stored (or readable) yet. */
export async function loadMessages(chat) {
  const store = await readStore(chat)
  return store && typeof store.m === 'object' && store.m !== null ? store.m : {}
}

/**
 * Whether a chat's stored turn ids still count typed prompts (a store from 0.9.0 or older): such an
 * id names another turn than dsh's, so it is not shown until relabelTurns converts it (review of #71).
 */
export async function oldTurns(chat) {
  const store = await readStore(chat)
  return store?.v !== 2 && Object.values(store?.m ?? {}).some((m) => m?.t !== undefined)
}

/** Whether a chat's store holds every message of its indexed span (#93). */
export async function storeComplete(chat) {
  return (await readStore(chat))?.complete === true
}

/**
 * Add messages (`[{ seq, role, text, turn, time }]`) that are not stored yet, whole (keepText).
 * Idempotent: writing the same seq twice is a no-op, so a build that is retried after a crash cannot
 * duplicate text; the one change made to a stored message is a cut copy (0.12.0 and before)
 * replaced by its whole text (#93). `complete` marks the store as holding the whole indexed span.
 */
export function saveMessages(chat, messages, { complete = false } = {}) {
  return locked(`${chat}#msgs`, async () => {
    const store = (await readJson(file(chat))) ?? { v: 2, m: {} }
    if (typeof store.m !== 'object' || store.m === null) store.m = {}
    let changed = false
    for (const m of messages) {
      const key = String(m.seq)
      if (!Number.isInteger(m.seq)) continue
      const kept = keepText(m.text)
      const old = store.m[key]
      if (old && !(typeof old.x === 'string' && CUT.test(old.x) && kept.length > old.x.length)) continue
      store.m[key] = old ? { ...old, x: kept } : { r: m.role, ...(m.turn ? { t: m.turn } : {}), ...(m.time ? { a: m.time } : {}), x: kept }
      changed = true
    }
    if (complete && store.complete !== true) {
      store.complete = true
      changed = true
    }
    if (changed) await writeJson(file(chat), store)
  })
}

/**
 * Give stored messages the turn `turnAt(seq)` says (#71: turn ids follow dsh's own turns now) and
 * mark the store as numbered so (v 2). Under the lock saveMessages takes; when nothing changes,
 * nothing is written.
 */
export function relabelTurns(chat, turnAt) {
  return locked(`${chat}#msgs`, async () => {
    const store = await readJson(file(chat))
    if (typeof store?.m !== 'object' || store.m === null) return
    let changed = store.v !== 2
    for (const [seq, m] of Object.entries(store.m)) {
      const t = turnAt(Number(seq))
      if (t === undefined || !m || typeof m !== 'object' || m.t === t) continue
      m.t = t
      changed = true
    }
    if (changed) await writeJson(file(chat), { ...store, v: 2 })
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
