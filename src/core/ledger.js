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
 *   history     the old total (#104): for each earlier chat whose memory this chat USED (a recall, or
 *               an answer saying two of a topic's words the prompt did not), that chat's whole
 *               conversation as kept (#93), counted once per chat that used it, at its first use:
 *               the history that would otherwise have been input to bring that chat back
 *   used        topics used, once each per chat
 * Saved = history - memory making (indexing) - searching (notes, recalls, their cached re-sends,
 * the recall tool): what memory spared against taking the earlier conversations in as input.
 * Prices differ by kind, so the balance is in input-token equivalents: cached input and output are
 * weighted (WEIGHTS), uncached input counts 1.
 */

import { nodeTokens, wordsIn } from './match.js'
import { estimateTokens, tokenize } from './text.js'

/** Price of a token relative to an uncached input token (DeepSeek: cache hits ~1/10, output ~4x). */
export const WEIGHTS = { cached: 0.1, output: 4 }

export const emptyCounters = () => ({ sent: 0, resent: 0, tool: 0, recalled: 0, indexIn: 0, indexCached: 0, indexOut: 0, history: 0, used: 0, requests: 0 })

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

/**
 * The estimate in input-token equivalents (#104): the old total (history), memory making (the
 * indexing calls) and searching (what memory sent and the tool it rides on); saved = history - making
 * - searching. `saved` is the old total and `net` what is left after the cost, as the page shows them.
 */
export function balance(c, weights = WEIGHTS) {
  const making = c.indexIn + weights.cached * c.indexCached + weights.output * c.indexOut
  const searching = c.sent + c.recalled + weights.cached * (c.resent + c.tool)
  const cost = making + searching
  return { history: Math.round(c.history), making: Math.round(making), searching: Math.round(searching), cost: Math.round(cost), saved: Math.round(c.history), net: Math.round(c.history - cost) }
}

/** Tokens of a chat's whole kept conversation (#93, #104): every message stored, whole. */
export function historyTokens(stored) {
  return Object.values(stored ?? {}).reduce((n, m) => n + (typeof m?.x === 'string' ? estimateTokens(m.x) : 0), 0)
}

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
 * What a used topic stands in for (#104): its chat's whole kept conversation, once per chat that
 * used it. `credited` holds the chats already counted (`c3`); returns the tokens and the key this adds.
 */
export function standInChat(stored, cid, credited) {
  const key = `c${cid}`
  if (credited.has(key)) return { tokens: 0, keys: [] }
  return { tokens: historyTokens(stored), keys: [key] }
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

/** The card's details: each term of the estimate, so the number can be checked (#104). */
export function savingsDetail(c, weights = WEIGHTS) {
  const b = balance(c, weights)
  return [
    `Estimate (input-token equivalents; cached input x${weights.cached}, output x${weights.output}): saved = old total - making - searching = ${b.net}`,
    `- old total: ${b.history} (the whole kept conversations of the earlier chats whose memory this chat used, each once; ${c.used} topic${c.used === 1 ? '' : 's'} used)`,
    `- memory making: ${b.making} = indexing in ${c.indexIn} / cached ${c.indexCached} / out ${c.indexOut}`,
    `- searching: ${b.searching} = notes sent ${c.sent} + recalls ${c.recalled} + re-sent as cached ${c.resent} + recall tool ${c.tool}`
  ].join('\n')
}
