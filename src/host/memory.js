/**
 * Memory injection: on every human turn, match the prompt against the other shared chats of the
 * workspace and append one short `[context-graph]` block at the END of the request, so the
 * provider's prefix cache survives. The first message of a chat also gets the top layer: one line
 * per earlier chat. Unrelated messages get nothing (#23). Nothing else is ever added to a chat.
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'

import { SOURCE_KIND, memoryOn } from '../core/chat.js'
import { matchAcross } from '../core/match.js'
import { formatSource, renderChats, renderHits, renderRange } from '../core/render.js'
import { PROMPT_KINDS, eventText, promptText, shownContext, titleOf } from '../core/session.js'
import { estimateTokens } from '../core/text.js'
import { asksAboutPast, parseTimeRange } from '../core/time.js'
import { capText, sourceOf } from '../store/messages.js'

const TOPIC_LINE = /^\s*- (c\d+n\d+) /gm

/** A goal round of a revision that already had one on the surface: its objective was matched then (#69). */
const roundSeen = (agent, source) => source?.kind === 'goal' && agent.session.surface.nodes.some((seq) => {
  const event = agent.session.eventAt(seq)
  const s = event?.type === 'user/message' ? event.data?.source : undefined
  return s?.kind === 'goal' && s.goalId === source.goalId && s.revision === source.revision
})

export function registerMemory(ctx, rt, meter) {
  const { cfg } = rt

  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    // The user's input however dsh drove it: typed, a /goal round (its objective, once per goal
    // revision), a reminder, a late answer to a question (#69).
    const prompt = payload.messages.filter((m) => PROMPT_KINDS.has(m.source?.kind) && !roundSeen(agent, m.source)).map(promptText).filter(Boolean).join('\n')
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    refreshContext(agent)
    return addMemory(agent, prompt, decision)
  })

  /**
   * After a compaction, blocks no longer on the surface stop being charged as re-sent (#35, review):
   * checked on every step, memory on or off; read again only when dsh's replace count moved.
   */
  function refreshContext(agent) {
    const st = rt.isSubagent(agent) ? undefined : rt.tracked(rt.sidOf(agent))
    const generation = agent.session.surface.replaceGeneration
    if (!st || st.generation === generation) return
    st.generation = generation
    st.inContext = shownContext(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq)).tokens
  }

  /**
   * Whether a fork already holds a topic (#16, #52). A fork carries its ancestors' events under the
   * same seqs, so a topic of ANY chat (parent, grandparent ...) whose every cited message is word for
   * word this chat's own event at that seq, before its fork point, is already in its context.
   * Decided by content, so no parent has to be identified or remembered.
   */
  function holds(agent, forkSeq, stored, node) {
    const refs = node.refs ?? []
    if (refs.length === 0 || !refs.every((seq) => seq < forkSeq)) return false
    return refs.every((seq) => {
      const x = stored[String(seq)]?.x
      const own = eventText(agent.session.eventAt(seq))
      return x !== undefined && own !== '' && (x === own || x === capText(own))
    })
  }

  /**
   * Every ancestor of a fork starts with the fork's own first prompt (dsh copies the log from seq 0),
   * so only chats with that first prompt need their stored messages compared. This keeps a fork's
   * first message from parsing every chat's msgs.json (review of #52).
   */
  const ancestorLike = (view, first) => rt.startsWith(view.meta, first)

  /** The hits a fork already holds. */
  async function inherited(agent, forkSeq, hits) {
    const out = new Set()
    if (!forkSeq) return out
    const first = titleOf((seq) => agent.session.eventAt(seq))
    for (const hit of hits) {
      if (ancestorLike(hit.view, first) && holds(agent, forkSeq, await rt.messagesOf(agent, hit.view), hit.node)) out.add(hit)
    }
    return out
  }

  /** Chats a fork holds entirely (its ancestors up to the fork point): not worth a line in its list. */
  async function heldChats(agent, forkSeq, views) {
    const out = new Set()
    if (!forkSeq) return out
    const first = titleOf((seq) => agent.session.eventAt(seq))
    for (const view of views) {
      const nodes = Object.values(view.graph.nodes)
      if (view.own || nodes.length === 0 || !ancestorLike(view, first) || !nodes.every((n) => (n.refs ?? []).every((seq) => seq < forkSeq))) continue
      const stored = await rt.messagesOf(agent, view)
      if (nodes.every((node) => holds(agent, forkSeq, stored, node))) out.add(view)
    }
    return out
  }

  async function addMemory(agent, prompt, decision) {
    try {
      if (rt.isSubagent(agent) || !prompt) return decision
      const st = rt.state(rt.sidOf(agent))
      // From now on the savings estimate follows this chat (meter.js), memory on or off: the recall
      // tool rides with its requests either way.
      st.chat = true
      rt.noteDir(agent)
      // An off whose write is still waiting for the file already holds here (runtime.js withPending).
      if (!memoryOn(await rt.metaFor(agent))) return decision
      const views = await rt.loadViews(agent)
      // What this chat already holds: blocks and recalls still on its surface.
      const shown = shownContext(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq))
      // Read from the surface on every human turn, so a compaction that dropped old blocks is seen.
      st.inContext = shown.tokens
      st.generation = agent.session.surface.replaceGeneration
      const forkSeq = rt.forkSeqOf(agent.session)
      const parts = []
      let layer
      // The top layer, once per chat (#26): on its first turn (no answer on the surface yet), or
      // after /context-graph on. Never while a list is still on the surface, and an app restart or a
      // compaction does not bring it back: the chat has its own work in context by then.
      const firstTurn = !agent.session.surface.nodes.some((seq) => agent.session.eventAt(seq)?.type === 'assistant/message')
      // Chats this fork holds word for word (its ancestors): listed nowhere, neither in the list nor in a day digest.
      let heldViews
      const held = async () => (heldViews ??= await heldChats(agent, forkSeq, views))
      const listing = (firstTurn || st.announce) && !st.listed && !shown.list
      st.listed = true
      st.announce = false
      const range = parseTimeRange(prompt)
      const { hits: found, lead, total } = matchAcross(views, prompt, { max: cfg.maxHits, range, skip: shown.ids })
      const holds = await inherited(agent, forkSeq, found)
      const hits = found.filter((hit) => !holds.has(hit))
      if (total === 0 && range && asksAboutPast(prompt)) {
        // A question about a day with no topic hit gets that day's digest, kept small; recall("YYYY-MM-DD") has the rest (#24).
        const skipped = await held()
        const block = renderRange(views.filter((v) => !v.own && !skipped.has(v)), range, { maxChats: cfg.rangeMaxChats, maxTopics: cfg.rangeMaxTopics })
        const ids = [...block.matchAll(TOPIC_LINE)].map((m) => m[1])
        const seen = shown.texts.has(block) || (ids.length > 0 && ids.every((id) => shown.ids.has(id)))
        if (!seen) parts.push(block)
      }
      let inline
      if (hits.length > 0) {
        // Only a hit that clearly answers the message has its source inlined, within a token budget (#39).
        if (lead && hits[0] === lead) {
          const text = formatSource(sourceOf(await rt.messagesOf(agent, lead.view), lead.node))
          if (text && estimateTokens(text) <= cfg.inlineMaxTokens) inline = { id: lead.id, text }
        }
        parts.push(renderHits(hits, { inline }))
      }
      if (listing) {
        // Evidence before tokens (#76): the list rides with the chat's first block or a question
        // about earlier work; alone, never with a message whose words are in no earlier chat.
        const skipped = await held()
        const list = renderChats(views.filter((v) => !skipped.has(v)), { prompt, maxTokens: cfg.listMaxTokens, maxChats: cfg.listMaxChats, related: parts.length === 0 && !asksAboutPast(prompt) })
        if (list) { parts.unshift(list); layer = 'surface' }
      }
      if (parts.length === 0) return decision
      const text = parts.join('\n\n')
      const tokens = estimateTokens(text)
      meter.injected++
      meter.injectedTokens += tokens
      st.delta.sent += tokens
      st.inContext += tokens
      st.justSent += tokens
      // Checked against the answer at turn end: a topic the answer uses counts as saved (#35).
      for (const hit of hits) st.pending.push({ id: hit.id, sid: hit.view.sid, cid: hit.view.cid, node: hit.node, prompt })
      const message = createUserMessage({ content: [{ type: 'text', text }], source: layer ? { kind: SOURCE_KIND, layer } : { kind: SOURCE_KIND } })
      return { ...decision, messages: [...decision.messages, message] }
    } catch (error) {
      console.error('context-graph: matcher failed (non-fatal)', error)
      return decision
    }
  }
}
