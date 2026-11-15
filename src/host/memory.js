/**
 * Memory injection: on every human turn, match the prompt against the other shared chats of the
 * workspace and append one short `[context-graph]` block at the END of the request, so the
 * provider's prefix cache survives. The first message of a chat also gets the list of shared chats.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SOURCE_KIND, memoryOn } from '../core/chat.js'
import { matchAcross } from '../core/match.js'
import { renderChats, renderHits, renderRange } from '../core/render.js'
import { shownContext } from '../core/session.js'
import { estimateTokens, textOf } from '../core/text.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir, readSource } from '../store/chats.js'

export function registerMemory(ctx, rt, meter, updates) {
  const { cfg } = rt
  let noticeShown = false

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const prompt = payload.messages.filter((m) => m.source?.kind === 'user').map((m) => textOf(m.content)).join('\n')
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const result = await addMemory(agent, prompt, decision)
    return prompt && !rt.isSubagent(agent) ? addUpdateNotice(result) : result
  })

  /** Once per app start, ask the model to pass an available update on to the user. */
  function addUpdateNotice(decision) {
    const notice = updates.current()
    if (!notice || noticeShown) return decision
    noticeShown = true
    const message = createUserMessage({
      content: [{ type: 'text', text: `[${SOURCE_KIND}] ${notice} At the end of your reply, tell the user this in one short line.` }],
      source: { kind: SOURCE_KIND, notice: true }
    })
    return { ...decision, messages: [...decision.messages, message] }
  }

  async function addMemory(agent, prompt, decision) {
    try {
      if (rt.isSubagent(agent) || !prompt) return decision
      if (!memoryOn(await rt.metaFor(agent))) return decision
      const st = rt.state(rt.sidOf(agent))
      const views = await rt.loadViews(agent)
      const parts = []
      let layer
      if (st.announce) {
        st.announce = false
        const list = renderChats(views, { max: cfg.surfaceMaxChats })
        if (list) { parts.push(list); layer = 'surface' }
      }
      const range = parseTimeRange(prompt)
      // Topics already sent in this chat are still in its context; do not send them again (#5).
      const shown = shownContext(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq))
      const { hits, slice } = matchAcross(views, prompt, { max: cfg.maxHits, range, skip: shown.ids })
      if (hits.length === 0 && range) {
        // Sent with every message that names a time, so kept small; recall("YYYY-MM-DD") gives the full day.
        const block = renderRange(views.filter((v) => !v.own), range, { maxChats: cfg.rangeMaxChats, maxTopics: cfg.rangeMaxTopics })
        const ids = block.match(/\bc\d+n\d+\b/g) ?? []
        const seen = shown.texts.has(block) || (ids.length > 0 && ids.every((id) => shown.ids.has(id)))
        if (!seen) parts.push(block)
      } else {
        let inline
        if (hits.length === 1 || (hits.length > 1 && hits[0].score >= 2 * hits[1].score)) {
          const top = hits[0]
          const text = await readSource(chatDir(rt.dirFor(agent), top.view.sid), top.id.slice(top.id.indexOf('n')))
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
