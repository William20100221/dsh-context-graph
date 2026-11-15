/**
 * The builder: every few human turns, one auxiliary model call indexes the chat's new messages into
 * its topic graph and stores the messages the topics cite. Runs after a turn closes, never on the
 * critical path of a reply.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { betterParse, builderInstruction, parseBuilderOutput, tailWithin, transcriptForBuilder } from '../core/builder.js'
import { memoryOn } from '../core/chat.js'
import { mergeDelta } from '../core/graph.js'
import { collectSpan, titleOf } from '../core/session.js'
import { textOf } from '../core/text.js'
import { chatDir, loadGraph, saveGraph } from '../store/chats.js'
import { saveMessages } from '../store/messages.js'
import { PURPOSE } from './config.js'

/** After this many unusable answers in a row for one span, the span is skipped instead of re-sent again. */
const MAX_FAILED_ANSWERS = 3

export function registerBuilder(ctx, rt, meter) {
  const { cfg } = rt

  /**
   * Index the chat's messages since the last build.
   * @param force build now even below the turn/char thresholds (the `build` and `on` commands).
   * @param signal aborts the model call (the command's own signal, so cancelling it stops the build).
   * @param completeOnly stop before a turn that is still running (builds started by a command).
   */
  async function build(agent, { force = false, signal, completeOnly = false } = {}) {
    const session = agent.session
    const sid = rt.sidOf(agent)
    const st = rt.state(sid)
    if (st.building) return { status: 'busy', reason: 'this chat is already being indexed' }
    // ponytail: subagent chatter stays out of the graph; revisit if delegated work holds decisions worth keeping.
    if (rt.isSubagent(agent)) return { status: 'skipped', reason: 'subagent session' }
    st.building = true
    let span
    const finish = (result) => {
      if (['built', 'failed', 'cancelled'].includes(result.status)) st.lastBuild = { ...result, at: new Date().toISOString() }
      return result
    }
    const failed = (reason) => {
      if (span) st.retryAt = span.userTurns + cfg.buildEveryTurns
      return finish({ status: 'failed', reason })
    }
    try {
      let meta = await rt.metaFor(agent)
      if (!memoryOn(meta)) return { status: 'off', reason: 'memory is off for this chat; /context-graph on resumes it' }
      // A chat that never ran a command has no folder yet; this gives it one and a chat number.
      if (!meta) meta = await rt.updateFor(agent, (m) => m)
      // Read from the durable log after the last indexed seq, so compacted turns are not lost (#13).
      span = collectSpan((seq) => session.eventAt(seq), meta.builtSeq ?? -1, { completeOnly })
      const chars = span.messages.reduce((n, m) => n + m.text.length, 0)
      if (span.messages.length === 0) return { status: 'nothing', reason: 'no new messages since the last build' }
      const needTurns = Math.max(cfg.buildEveryTurns, st.retryAt)
      if (!force && (span.userTurns < needTurns || chars < cfg.buildMinChars)) {
        return { status: 'skipped', reason: `${span.userTurns}/${needTurns} human turns, ${chars}/${cfg.buildMinChars} chars` }
      }
      // A long chat indexed for the first time keeps the call small: only its newest messages are read.
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
        purpose: PURPOSE,
        ...(signal ? { signal } : {})
      })) assembler.push(chunk)
      const end = assembler.finish
      if (end?.kind === 'error' || end?.kind === 'aborted') throw new Error(end.failure?.message ?? end.kind)
      const blocks = assembler.blocks()
      const answer = textOf(blocks)
      // Some thinking models put everything, JSON included, into reasoning blocks.
      const reasoning = blocks.filter((b) => b?.type === 'reasoning').map((b) => b.text).join('\n')
      const delta = betterParse(parseBuilderOutput(answer), parseBuilderOutput(reasoning))
      // Reversibility rule: a topic is written only when it cites a message of this span.
      const usable = delta ? delta.nodes.filter((n) => n.msgs.some((i) => i < messages.length)) : []
      // "Nothing worth remembering" is a complete answer whose nodes are empty (or that says skip);
      // an answer cut off by the token cap never counts as one.
      const nothing = usable.length === 0 && delta?.skip === true && end?.kind !== 'max-tokens'
      if (!delta || (usable.length === 0 && !nothing)) {
        // An unusable answer is a failure, not an empty build: the span stays unindexed and is
        // retried later instead of being skipped for good (#14). The raw answer is kept for diagnosis.
        const saved = join(chat, 'last-builder-output.txt')
        await mkdir(chat, { recursive: true })
        await writeFile(saved, `finish: ${end?.kind}\n\n--- answer ---\n${answer}\n\n--- reasoning ---\n${reasoning}\n`, 'utf8')
        const why = end?.kind === 'max-tokens'
          ? `the model ran out of output tokens (builderMaxTokens ${cfg.builderMaxTokens}) before finishing`
          : delta ? 'the model\'s answer had no topic citing a message of this span' : 'builder output was not the expected JSON'
        st.failedAnswers = (st.failedAnswers ?? 0) + 1
        if (st.failedAnswers >= MAX_FAILED_ANSWERS) {
          // A span the model keeps failing on would otherwise be re-sent, growing, every few turns.
          st.failedAnswers = 0
          await rt.updateFor(agent, (latest) => ({ ...latest, builtSeq: span.lastSeq, turns: span.turns }))
          return failed(`${why}; skipped these turns after ${MAX_FAILED_ANSWERS} unusable answers in a row; raw output saved to ${saved}`)
        }
        return failed(`${why}; raw output saved to ${saved}`)
      }
      st.failedAnswers = 0
      delta.nodes = usable
      const now = new Date().toISOString()
      const refsOf = (msgs) => msgs.map((i) => messages[i]?.seq).filter(Number.isInteger)
      const touched = mergeDelta(graph, delta, { now, refsOf })
      // Commit order: the cited text first (idempotent by seq), then the graph that points at it,
      // then the index position. A crash in between can repeat work but never attaches the wrong
      // text to a topic (#12).
      const cited = [...new Set(usable.flatMap((n) => n.msgs))].map((i) => messages[i]).filter(Boolean)
      await saveMessages(chat, cited)
      await saveGraph(chat, graph)
      await rt.updateFor(agent, (latest) => ({
        ...latest,
        title: latest.title ?? titleOf((seq) => session.eventAt(seq)),
        lastActiveAt: now,
        turns: span.turns,
        builtSeq: span.lastSeq
      }))
      st.retryAt = 0
      meter.builds++
      return finish({ status: 'built', nodes: touched.length, newNodes: touched.filter((t) => t.isNew).length, totalNodes: Object.keys(graph.nodes).length, edges: graph.edges.length, dir: chat })
    } catch (error) {
      if (signal?.aborted) return finish({ status: 'cancelled', reason: 'the command was cancelled' })
      console.error('context-graph: build failed (non-fatal)', error)
      return failed(String(error?.message ?? error))
    } finally {
      st.building = false
    }
  }

  ctx.on('agent/turn-stopping', (payload) => {
    // Fire and forget: the build must never delay the turn's close.
    void build(payload.agent)
  })

  return build
}
