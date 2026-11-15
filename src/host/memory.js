/**
 * Memory injection: on every human turn, match the prompt against the other shared chats of the
 * workspace and append one short `[context-graph]` block at the END of the request, so the
 * provider's prefix cache survives. The first message of a chat also gets the list of shared chats.
 * Nothing else is ever added to a chat: the update notice lives in /context-graph stats only (#20).
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SOURCE_KIND, memoryOn } from '../core/chat.js'
import { globalId, matchAcross } from '../core/match.js'
import { formatSource, renderChats, renderHits, renderRange } from '../core/render.js'
import { shownContext, titleOf } from '../core/session.js'
import { estimateTokens, textOf } from '../core/text.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir } from '../store/chats.js'
import { capText, loadMessages, sourceOf } from '../store/messages.js'

export function registerMemory(ctx, rt, meter) {
  const { cfg } = rt

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const prompt = payload.messages.filter((m) => m.source?.kind === 'user').map((m) => textOf(m.content)).join('\n')
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    return addMemory(agent, prompt, decision)
  })

  /**
   * A forked chat's parent and fork point (#16). The fork point is a seq, not a time: dsh copies the
   * parent's events into the fork with the same seqs. The parent is the one dsh names in the header
   * when it does; otherwise the shared chat with the fork's title (the fork inherited the first
   * prompt), and among several such chats the one whose stored messages match the fork's own log at
   * the same seqs. When nothing identifies it, the parent stays unknown rather than guessed.
   */
  async function forkOf(agent, views) {
    const own = views.find((v) => v.own)
    const forkSeq = own?.meta.forkSeq ?? rt.forkSeqOf(agent.session)
    if (!forkSeq) return undefined
    const named = own?.meta.parent ?? agent.session.header?.parentSession
    if (named) return { parent: String(named), forkSeq }
    const eventAt = (seq) => agent.session.eventAt(seq)
    const title = titleOf(eventAt)
    const same = views.filter((v) => !v.own && v.meta.title === title)
    if (same.length <= 1) return { parent: same[0]?.sid, forkSeq }
    for (const view of same.slice(0, 5)) {
      const stored = await loadMessages(chatDir(rt.dirFor(agent), view.sid))
      const matches = Object.entries(stored).some(([seq, m]) => Number(seq) < forkSeq && m.x === capText(textOf(eventAt(Number(seq))?.data?.content ?? eventAt(Number(seq))?.data?.message?.content)))
      if (matches) return { parent: view.sid, forkSeq }
    }
    return { parent: undefined, forkSeq }
  }

  /**
   * Topics a fork must not be sent: parent topics whose every cited message lies before the fork
   * point are already in the fork's own context. A topic that also cites later messages is new to it.
   */
  function inheritedIds(views, fork) {
    const parent = fork?.parent && views.find((v) => v.sid === fork.parent)
    if (!parent) return []
    return Object.entries(parent.graph.nodes)
      .filter(([, node]) => Array.isArray(node.refs) && node.refs.length > 0 && node.refs.every((seq) => seq < fork.forkSeq))
      .map(([id]) => globalId(parent, id))
  }

  async function addMemory(agent, prompt, decision) {
    try {
      if (rt.isSubagent(agent) || !prompt) return decision
      if (!memoryOn(await rt.metaFor(agent))) return decision
      const st = rt.state(rt.sidOf(agent))
      const views = await rt.loadViews(agent)
      const fork = await forkOf(agent, views)
      const parts = []
      let layer
      if (st.announce) {
        st.announce = false
        // A fork already holds its parent's conversation, so the parent is not listed to it.
        const list = renderChats(views.filter((v) => v.sid !== fork?.parent), { max: cfg.surfaceMaxChats })
        if (list) { parts.push(list); layer = 'surface' }
      }
      const range = parseTimeRange(prompt)
      // Topics already sent in this chat are still in its context; do not send them again.
      const shown = shownContext(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq))
      const skip = new Set([...shown.ids, ...inheritedIds(views, fork)])
      const { hits, slice } = matchAcross(views, prompt, { max: cfg.maxHits, range, skip })
      if (hits.length === 0 && range) {
        // Sent with every message that names a time, so kept small; recall("YYYY-MM-DD") gives the full day.
        const block = renderRange(views.filter((v) => !v.own), range, { maxChats: cfg.rangeMaxChats, maxTopics: cfg.rangeMaxTopics })
        const ids = block.match(/\bc\d+n\d+\b/g) ?? []
        const seen = shown.texts.has(block) || (ids.length > 0 && ids.every((id) => skip.has(id)))
        if (!seen) parts.push(block)
      } else {
        let inline
        if (hits.length === 1 || (hits.length > 1 && hits[0].score >= 2 * hits[1].score)) {
          const top = hits[0]
          const source = sourceOf(await loadMessages(chatDir(rt.dirFor(agent), top.view.sid)), top.node)
          const text = formatSource(source)
          if (text && text.length <= cfg.inlineMaxChars) inline = { id: top.id, text }
        }
        const block = renderHits(hits, { inline, slice })
        if (block) parts.push(block)
      }
      if (parts.length === 0) return decision
      const text = parts.join('\n\n')
      meter.injected++
      meter.injectedTokens += estimateTokens(text)
      const message = createUserMessage({ content: [{ type: 'text', text }], source: layer ? { kind: SOURCE_KIND, layer } : { kind: SOURCE_KIND } })
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      console.error('context-graph: matcher failed (non-fatal)', error)
      return decision
    }
  }
}
