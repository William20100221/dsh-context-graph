/**
 * Reading dsh session events: the human/assistant exchange, turns, titles, and what this plugin has
 * already put into a chat. Pure: callers pass `eventAt(seq)` and surface seqs.
 */

import { SOURCE_KIND } from './chat.js'
import { clipTokens, estimateTokens, sliceChars, textOf } from './text.js'

export const isHuman = (event) => event?.type === 'user/message' && event.data?.source?.kind === 'user'

/**
 * The human/assistant exchange after `afterSeq`, read from the durable session log (seq 0, 1, 2 ...
 * until `eventAt` returns nothing). Not from the surface: dsh compaction replaces old turns on the
 * surface with one checkpoint, and turns that were still waiting to be indexed would be lost (#13).
 * Within one session the log is never edited, so nothing outside the conversation is read.
 * Each message carries its turn number (t1 is the first human prompt of the log) and its time.
 * `completeOnly`: stop before a turn that is still running (a `turn/start` with no `turn/end` after
 * it), so a build started by a command mid-turn never splits that turn's question from its answer.
 * @returns { messages: [{ seq, role, text, turn, time }], lastSeq, userTurns, turns, title }
 *   `title`: the chat's latest dsh title (model-made, or the user's own rename), if any (#41).
 */
export function collectSpan(eventAt, afterSeq = -1, { completeOnly = false } = {}) {
  const all = []
  const humans = []
  let end = -1
  let openTurn = -1
  let title
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) break
    end = seq
    if (event.type === 'turn/start') openTurn = seq
    else if (event.type === 'turn/end') openTurn = -1
    else if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title.trim()) title = event.data.title.trim()
    if (isHuman(event)) {
      humans.push(seq)
      const text = textOf(event.data.content)
      if (text && seq > afterSeq) all.push({ seq, role: 'user', text, turn: humans.length, time: event.time })
    } else if (seq > afterSeq && event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) all.push({ seq, role: 'assistant', text, turn: humans.length || undefined, time: event.time })
    }
  }
  const limit = completeOnly && openTurn >= 0 ? openTurn - 1 : end
  const messages = all.filter((m) => m.seq <= limit)
  return {
    messages,
    lastSeq: Math.max(afterSeq, limit),
    userTurns: messages.filter((m) => m.role === 'user').length,
    turns: humans.filter((seq) => seq <= limit).length,
    title
  }
}

const TOPIC_LINE = /^\s*- (c\d+n\d+) /gm
const RECALLED = /^(?:# |\s*- )(c\d+n\d+) /gm

/**
 * What this chat already holds in context, read from the surface (so after compaction drops a
 * block, its topics can be sent again):
 *   ids    topics listed in the plugin's blocks, or fetched with recall (#31). Only topic lines
 *          count, never ids inside prose, so an example id cannot hide a real topic (#51).
 *   texts  whole block texts (an identical day digest is not sent twice)
 *   list   whether the chat list (the top layer) is on the surface (#26)
 */
export function shownContext(nodes, eventAt) {
  const ids = new Set()
  const texts = new Set()
  let list = false
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) {
      const text = textOf(event.data.content)
      texts.add(text)
      if (event.data.source.layer === 'surface') list = true
      for (const m of text.matchAll(TOPIC_LINE)) ids.add(m[1])
    } else if (event?.type === 'tool/result') {
      for (const m of textOf(event.data?.message?.content).matchAll(RECALLED)) ids.add(m[1])
    }
  }
  return { ids, texts, list }
}

/** First human prompt of the log, shortened: the chat's title until dsh names it, and the key fork detection uses. */
export function titleOf(eventAt, width = 60) {
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event)) {
      const text = textOf(event.data.content).replace(/\s+/g, ' ')
      return text.length > width ? `${sliceChars(text, width - 1)}…` : text
    }
  }
}

/** "read_file ×3, bash": tool names in first-use order with counts. */
function toolLine(names) {
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return `[tools: ${[...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')}]`
}

/**
 * Parts kept within `maxTokens`: the prompt and the final answer first (each clipped if huge), then
 * the steps between them, newest first; the oldest steps that do not fit become one marker.
 */
function fit(parts, maxTokens) {
  const joined = (list) => list.map((p) => p.text).join('\n\n')
  if (estimateTokens(joined(parts)) <= maxTokens) return joined(parts)
  const lastAnswer = parts.findLastIndex((p, i) => i > 0 && p.kind === 'assistant')
  const head = { ...parts[0], text: clipTokens(parts[0].text, Math.floor(maxTokens * 0.35)) }
  const answer = lastAnswer > 0 ? { ...parts[lastAnswer], text: clipTokens(parts[lastAnswer].text, Math.floor(maxTokens * 0.45)) } : undefined
  const after = lastAnswer > 0 ? parts.slice(lastAnswer + 1) : []
  const middle = parts.slice(1, lastAnswer > 0 ? lastAnswer : parts.length)
  let room = maxTokens - estimateTokens(joined([head, ...(answer ? [answer] : []), ...after])) - 16
  const kept = []
  for (let i = middle.length - 1; i >= 0; i--) {
    const cost = estimateTokens(middle[i].text) + 1
    if (cost > room) break
    room -= cost
    kept.unshift(middle[i])
  }
  const dropped = middle.length - kept.length
  const marker = dropped > 0 ? [{ text: `…[${dropped} earlier step${dropped === 1 ? '' : 's'} left out]…` }] : []
  return joined([head, ...marker, ...kept, ...(answer ? [answer] : []), ...after])
}

/**
 * Turn `n` (its human prompt through the step before the next one), lean (#47): the prompt, the
 * assistant's text, and its tool use as one line; tool output is left out (it averaged 9,000 tokens
 * on real logs). Capped at about `maxTokens`.
 * @param limitSeq last seq that may be read: another chat's turn stops at its indexed position.
 * @returns { text, seq, endSeq } or undefined when the log has no turn n at or before `limitSeq`.
 */
export function turnTranscript(eventAt, n, { maxTokens = 2000, limitSeq = Infinity } = {}) {
  let count = 0
  let start = -1
  for (let seq = 0; seq <= limitSeq; seq++) {
    const event = eventAt(seq)
    if (!event) break
    if (isHuman(event) && ++count === n) { start = seq; break }
  }
  if (start < 0) return undefined
  const parts = []
  let tools = []
  const flush = () => {
    if (tools.length > 0) parts.push({ kind: 'tools', text: toolLine(tools) })
    tools = []
  }
  let end = start
  for (let seq = start; seq <= limitSeq; seq++) {
    const event = eventAt(seq)
    if (!event || (seq > start && isHuman(event))) break
    end = seq
    if (isHuman(event)) parts.push({ kind: 'user', text: `user:\n${textOf(event.data.content)}` })
    else if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      const text = textOf(blocks)
      if (text) {
        flush()
        parts.push({ kind: 'assistant', text: `assistant:\n${text}` })
      }
      for (const b of blocks) if (b?.type === 'tool-call' && b.name) tools.push(b.name)
    }
  }
  flush()
  return { text: fit(parts, maxTokens), seq: start, endSeq: end }
}
