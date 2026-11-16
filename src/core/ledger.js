/**
 * What memory costs and what it saves, per chat (#35). Pure: the host feeds it what it sees, the
 * store persists the counters, and this module turns them into an honest estimate.
 *
 * Counters of one chat (all tokens, the plugin's own estimate unless noted):
 *   sent        blocks the plugin appended (topic lines, sources, the chat list, day digests), once
 *   resent      the same blocks sent again as cached input with every later request of the chat
 *   tool        the recall tool's definition, cached input on every request
 *   recalled    recall results, once (they stay in context like a block: also in resent)
 *   indexIn / indexCached / indexOut   the indexing calls for this chat, as dsh reported them
 *   stoodIn     for each topic the chat USED, its newest cited messages (up to 3) as stored, each
 *               counted once per chat (one answer often gives several topics): what the user
 *               would otherwise have had to bring back into the chat (an estimate that errs low).
 *               What memory sent instead is the cost.
 *   used        topics used, once each per chat
 * Prices differ by kind, so the balance is in input-token equivalents: cached input and output are
 * weighted (WEIGHTS), uncached input counts 1.
 */

import { nodeTokens, wordsIn } from './match.js'
import { capText, estimateTokens, tokenize } from './text.js'

/** Price of a token relative to an uncached input token (DeepSeek: cache hits ~1/10, output ~4x). */
export const WEIGHTS = { cached: 0.1, output: 4 }

export const emptyCounters = () => ({ sent: 0, resent: 0, tool: 0, recalled: 0, indexIn: 0, indexCached: 0, indexOut: 0, stoodIn: 0, used: 0, requests: 0 })

const COUNTERS = Object.keys(emptyCounters())

/** Counters with every field present and numeric (a hand-edited or older ledger reads safely). */
export function counters(value) {
  const out = emptyCounters()
  for (const key of COUNTERS) {
    const n = Number(value?.[key])
    if (Number.isFinite(n) && n > 0) out[key] = n
  }
  return out
}

/** Element-wise sum, for workspace totals. */
export function addCounters(a, b) {
  const out = emptyCounters()
  for (const key of COUNTERS) out[key] = (a?.[key] ?? 0) + (b?.[key] ?? 0)
  return out
}

/** What memory cost and what it stood in for, in input-token equivalents. */
export function balance(c, weights = WEIGHTS) {
  const cost = c.sent + c.recalled + c.indexIn + weights.cached * (c.resent + c.tool + c.indexCached) + weights.output * c.indexOut
  return { cost: Math.round(cost), saved: Math.round(c.stoodIn), net: Math.round(c.stoodIn - cost) }
}

const OMITTED = /…\[(\d+) chars omitted; the full turn is in the chat's dsh log\]…/

/**
 * Tokens of a stored message as it is stored now: its head and tail. A source kept whole by an
 * older version (migrated from v0.4-v0.6) counts as if it had been cut the same way (review).
 */
export const storedTokens = (text) => estimateTokens(capText(text).replace(OMITTED, ''))

/**
 * Whether an answer used a topic it was shown: it says two of the topic's words (label, aliases or
 * gist) that the prompt did not bring, counted as matching counts words (one Chinese word once, an
 * exact identifier of its label twice). The prompt's words count as already said, so an answer
 * that only repeats the question does not count, nor does a new word written next to them twice
 * (review of #35). Checked once per turn, off the critical path.
 */
export function usedIn(answer, node, prompt = '') {
  return wordsIn(answer, nodeTokens(node), tokenize(prompt)) >= 2
}

/**
 * What a used topic stood in for, erring low: its newest `max` cited messages at their stored size,
 * each counted once per chat (one answer often gives several topics). `credited` holds the
 * `<cid>:<seq>` keys already counted; returns the tokens and the keys this topic adds.
 */
export function standIn(node, stored, cid, credited, max = 3) {
  const newest = [...new Set(node.refs ?? [])].sort((a, b) => b - a).slice(0, max)
  const fresh = newest.filter((seq) => !credited.has(`${cid}:${seq}`))
  return { tokens: fresh.reduce((n, seq) => n + storedTokens(stored[String(seq)]?.x), 0), keys: fresh.map((seq) => `${cid}:${seq}`) }
}

/** "about 8,600": rounded so a reader does not take the estimate for an exact count. */
export function approx(n) {
  const abs = Math.abs(n)
  const step = abs >= 100000 ? 1000 : abs >= 1000 ? 100 : 10
  return (Math.sign(n) * Math.round(abs / step) * step).toLocaleString('en-US')
}

const nothing = (c) => Object.values(c).every((n) => n === 0)
const said = (n) => (n >= 0 ? `saved about ${approx(n)} tokens` : `cost about ${approx(-n)} tokens more than it saved`)

/** One line for the /context-graph card: what memory did for this chat and the workspace. */
export function savingsLine(chat, workspace) {
  if (nothing(chat) && nothing(workspace)) return 'Savings: nothing measured yet'
  const here = nothing(chat) ? 'nothing yet in this chat' : `${said(balance(chat).net)} in this chat`
  return `Savings (estimate): ${here} · ${said(balance(workspace).net)} in this workspace`
}

/** The card's details: each term of the estimate, so the number can be checked. */
export function savingsDetail(c, weights = WEIGHTS) {
  const { cost, saved } = balance(c, weights)
  return [
    `Estimate (input-token equivalents; cached input x${weights.cached}, output x${weights.output}):`,
    `- stood in for: ${saved} (${c.used} topic${c.used === 1 ? '' : 's'} used: their newest messages as stored, each counted once)`,
    `- memory cost: ${cost} = notes sent ${c.sent} + recalls ${c.recalled} + re-sent as cached ${c.resent} + recall tool ${c.tool} + indexing in ${c.indexIn} / cached ${c.indexCached} / out ${c.indexOut}`
  ].join('\n')
}
