/**
 * Reading dsh session events: the human/assistant exchange, turns, titles, and what this plugin has
 * already put into a chat. Pure: callers pass `eventAt(seq)` and surface seqs.
 */

import { SOURCE_KIND } from './chat.js'
import { textOf } from './text.js'

export const isHuman = (event) => event?.type === 'user/message' && event.data?.source?.kind === 'user'

/**
 * Pull the human/assistant exchange out of dsh session events in surface order.
 * @param nodes surface seqs; @param eventAt session lookup; @param afterSeq only events past this seq.
 * @returns { messages: [{ seq, role, text }], lastSeq, userTurns }
 */
export function collectSpan(nodes, eventAt, afterSeq = -1) {
  const messages = []
  let lastSeq = afterSeq
  let userTurns = 0
  for (const seq of nodes) {
    if (seq <= afterSeq) continue
    const event = eventAt(seq)
    if (!event) continue
    lastSeq = Math.max(lastSeq, seq)
    if (isHuman(event)) {
      const text = textOf(event.data.content)
      if (text) { messages.push({ seq, role: 'user', text }); userTurns++ }
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) messages.push({ seq, role: 'assistant', text })
    }
  }
  return { messages, lastSeq, userTurns }
}

/**
 * What this chat has already been sent by the plugin and still holds in context: topic ids
 * (c3n12) and whole block texts. Read from the surface, so after compaction drops a block its
 * topics can be sent again.
 */
export function shownContext(nodes, eventAt) {
  const ids = new Set()
  const texts = new Set()
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type !== 'user/message' || event.data?.source?.kind !== SOURCE_KIND) continue
    const text = textOf(event.data.content)
    texts.add(text)
    for (const m of text.matchAll(/\bc\d+n\d+\b/g)) ids.add(m[0])
  }
  return { ids, texts }
}

/** First human prompt of the log, shortened: the chat's title until dsh gives us a better one. */
export function titleOf(eventAt, width = 60) {
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event)) {
      const text = textOf(event.data.content).replace(/\s+/g, ' ')
      return text.length > width ? `${text.slice(0, width - 1)}…` : text
    }
  }
}

/** Verbatim text of turn `n` (its prompt through the step before the next human prompt). */
export function turnTranscript(eventAt, n, { maxToolChars = 2000 } = {}) {
  let count = 0
  let seq = 0
  for (; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event) && ++count === n) break
  }
  const out = []
  for (let s = seq; ; s++) {
    const event = eventAt(s)
    if (!event || (s > seq && isHuman(event))) break
    if (isHuman(event)) out.push(`**user:**\n${textOf(event.data.content)}`)
    else if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      const text = textOf(blocks)
      if (text) out.push(`**assistant:**\n${text}`)
      for (const b of blocks) if (b.type === 'tool-call') out.push(`**tool call** ${b.name} ${String(b.arguments ?? '').slice(0, 300)}`)
    } else if (event.type === 'tool/result') {
      const text = textOf(event.data?.message?.content)
      out.push(`**tool result:**\n${text.length > maxToolChars ? `${text.slice(0, maxToolChars)}\n…[${text.length - maxToolChars} more chars]` : text}`)
    }
  }
  return out.join('\n\n')
}
