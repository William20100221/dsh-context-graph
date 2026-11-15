/**
 * The builder: every few human turns, one auxiliary model call indexes the chat's new messages into
 * its topic graph and stores the cited text verbatim. Runs after a turn closes, never on the
 * critical path of a reply.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { builderInstruction, parseBuilderOutput, tailWithin, transcriptForBuilder } from '../core/builder.js'
import { memoryOn } from '../core/chat.js'
import { mergeDelta } from '../core/graph.js'
import { collectSpan, titleOf } from '../core/session.js'
import { textOf } from '../core/text.js'
import { appendSource, chatDir, loadGraph, saveGraph, saveMeta } from '../store/chats.js'
import { PURPOSE } from './config.js'

export function registerBuilder(ctx, rt, meter) {
  const { cfg } = rt

  async function build(agent, { force = false, turn = null } = {}) {
    const session = agent.session
    const sid = rt.sidOf(agent)
    const st = rt.state(sid)
    if (st.building) return { status: 'busy' }
    // ponytail: subagent chatter stays out of the graph; revisit if delegated work holds decisions worth keeping.
    if (rt.isSubagent(agent)) return { status: 'skipped', reason: 'subagent session' }
    st.building = true
    let span
    const failed = (reason) => {
      if (span) st.retryAt = span.userTurns + cfg.buildEveryTurns
      return { status: 'failed', reason }
    }
    try {
      let meta = await rt.metaFor(agent)
      if (!memoryOn(meta)) return { status: 'off', reason: 'memory is off for this chat; /context-graph on resumes it' }
      // A chat that never ran a command has no folder yet; give it one so it gets a chat number (#1).
      if (!meta) meta = await rt.setFlags(agent, {})
      // The index position is kept in meta.json so an app restart does not index the chat again (#2).
      span = collectSpan(session.surface.nodes, (seq) => session.eventAt(seq), meta.builtSeq ?? -1)
      const chars = span.messages.reduce((n, m) => n + m.text.length, 0)
      if (span.messages.length === 0) return { status: 'nothing', reason: 'no new messages since the last build' }
      const needTurns = Math.max(cfg.buildEveryTurns, st.retryAt)
      if (!force && (span.userTurns < needTurns || chars < cfg.buildMinChars)) {
        return { status: 'skipped', reason: `${span.userTurns}/${needTurns} human turns, ${chars}/${cfg.buildMinChars} chars` }
      }
      // A long chat indexed for the first time keeps the call small: only its newest messages are read (#4).
      const messages = tailWithin(span.messages, cfg.builderMaxInputChars)
      const llm = ctx.get('llm')
      if (!llm) return { status: 'unavailable', reason: 'no llm service in this composition' }
      const target = rt.resolveTarget(agent)
      if (!target) return { status: 'unavailable', reason: 'no provider/model routed yet' }
      const chat = chatDir(rt.dirFor(agent), sid)
      const graph = await loadGraph(chat)
      const prompt = `${transcriptForBuilder(messages)}\n\n${builderInstruction(graph)}`
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        maxTokens: cfg.builderMaxTokens,
        sessionId: session.id,
        purpose: PURPOSE
      })) assembler.push(chunk)
      const finish = assembler.finish
      if (finish?.kind === 'error' || finish?.kind === 'aborted') throw new Error(finish.failure?.message ?? finish.kind)
      const blocks = assembler.blocks()
      const answer = textOf(blocks)
      // Some thinking models put everything, JSON included, into reasoning blocks.
      const reasoning = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text).join('\n')
      const delta = parseBuilderOutput(answer) ?? parseBuilderOutput(reasoning)
      if (!delta || (delta.nodes.length === 0 && finish?.kind === 'max-tokens')) {
        const saved = join(chat, 'last-builder-output.txt')
        await mkdir(chat, { recursive: true })
        await writeFile(saved, `finish: ${finish?.kind}\n\n--- answer ---\n${answer}\n\n--- reasoning ---\n${reasoning}\n`, 'utf8')
        const why = finish?.kind === 'max-tokens'
          ? `the model ran out of output tokens (builderMaxTokens ${cfg.builderMaxTokens}) before finishing`
          : 'builder output was not the expected JSON'
        return failed(`${why}; raw output saved to ${saved}`)
      }
      // Reversibility rule: a node is written only when it cites text we can store verbatim.
      delta.nodes = delta.nodes.filter((n) => n.msgs.some((i) => messages[i]))
      const now = new Date().toISOString()
      const touched = mergeDelta(graph, delta, { session: sid, turn, now })
      for (const { id, msgs } of touched) {
        const cited = msgs.map((i) => messages[i]).filter(Boolean)
        if (cited.length > 0) await appendSource(chat, id, { session: sid, turn, at: now, messages: cited })
      }
      await saveGraph(chat, graph)
      // Re-read: a share/off command may have changed the flags while the model was answering.
      const latest = (await rt.metaFor(agent)) ?? meta
      await saveMeta(rt.dirFor(agent), sid, { ...latest, title: latest.title ?? titleOf((seq) => session.eventAt(seq)), lastActiveAt: now, turns: (latest.turns ?? 0) + span.userTurns, builtSeq: span.lastSeq })
      st.retryAt = 0
      meter.builds++
      return { status: 'built', nodes: touched.length, newNodes: touched.filter((t) => t.isNew).length, totalNodes: Object.keys(graph.nodes).length, edges: graph.edges.length, dir: chat }
    } catch (error) {
      console.error('context-graph: build failed (non-fatal)', error)
      return failed(String(error?.message ?? error))
    } finally {
      st.building = false
    }
  }

  ctx.on('agent/turn-stopping', (payload) => {
    // Fire and forget: the build must never delay the turn's close.
    void build(payload.agent, { turn: payload.turn })
  })

  return build
}
