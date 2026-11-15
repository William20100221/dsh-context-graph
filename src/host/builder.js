/**
 * The builder: every few human turns, one auxiliary model call indexes the chat's new messages into
 * its topic graph, refreshes the chat's one-line summary, and stores the messages the topics cite.
 * Runs after a turn closes, never on the critical path of a reply.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { betterParse, builderPrompt, parseBuilderOutput, planSpan } from '../core/builder.js'
import { memoryOn } from '../core/chat.js'
import { mergeDelta } from '../core/graph.js'
import { collectSpan, titleOf } from '../core/session.js'
import { textOf } from '../core/text.js'
import { chatDir, loadGraph, saveGraph } from '../store/chats.js'
import { saveMessages } from '../store/messages.js'
import { PURPOSE } from './config.js'

/** After this many unusable answers in a row for one span, the span is skipped instead of re-sent again. */
const MAX_FAILED_ANSWERS = 3

/** A chat's last-active time is refreshed at most this often on turns that do not index (#40). */
const TOUCH_MS = 3600000

/** The seq just before the middle prompt of a span: the half a cut-off answer is retried with (#45). */
function firstHalfEnd(messages) {
  const prompts = messages.filter((m) => m.role === 'user')
  return prompts.length >= 2 ? prompts[Math.floor(prompts.length / 2)].seq - 1 : undefined
}

export function registerBuilder(ctx, rt, meter) {
  const { cfg } = rt
  const efforts = new Map()

  /**
   * The route's lowest reasoning effort (#44), chosen the way dsh's own title generator does;
   * undefined for a route without efforts, or when this dsh cannot say (then nothing is sent, which
   * is always valid). Topic extraction does not need paid thinking.
   */
  async function lowestEffort(llm, target, signal) {
    const key = `${target.provider}\n${target.model}`
    if (efforts.has(key)) return efforts.get(key)
    if (typeof llm.resolveModelInfo !== 'function') return undefined
    try {
      const info = await llm.resolveModelInfo(target.provider, target.model, signal)
      const effort = info?.reasoning?.efforts?.[0]?.id
      efforts.set(key, effort)
      return effort
    } catch {
      return undefined
    }
  }

  /**
   * Index the chat's messages since the last build.
   * @param force build now even below the turn/char thresholds (the `build` and `on` commands).
   * @param signal aborts the model call (the command's own signal, so cancelling it stops the build).
   * @param completeOnly stop before a turn that is still running (builds started by a command).
   */
  async function build(agent, { force = false, signal, completeOnly = false } = {}) {
    const session = agent.session
    const eventAt = (seq) => session.eventAt(seq)
    const sid = rt.sidOf(agent)
    const st = rt.state(sid)
    if (st.building) return { status: 'busy', reason: 'this chat is already being indexed' }
    // ponytail: subagent chatter stays out of the graph; revisit if delegated work holds decisions worth keeping.
    if (rt.isSubagent(agent)) return { status: 'skipped', reason: 'subagent session' }
    st.building = true
    let span
    let read
    let endSeq
    const finish = (result) => {
      if (['built', 'failed', 'cancelled'].includes(result.status)) st.lastBuild = { ...result, at: new Date().toISOString() }
      return result
    }
    const failed = (reason, { half = false } = {}) => {
      if (span) {
        st.retryAt = span.userTurns + cfg.buildEveryTurns
        // The retry reads the same span, not the span plus every turn since (#45); after an answer
        // cut off by the token cap, only its first half.
        if (endSeq !== undefined) st.pin = (half && read ? firstHalfEnd(read) : undefined) ?? endSeq
      }
      return finish({ status: 'failed', reason })
    }
    try {
      let meta = await rt.metaFor(agent)
      if (!memoryOn(meta)) return { status: 'off', reason: 'memory is off for this chat; /context-graph on resumes it' }
      // Read from the durable log after the last indexed seq, so compacted turns are not lost (#13).
      span = collectSpan(eventAt, rt.indexStart(agent, meta), { completeOnly })
      if (span.messages.length === 0) return { status: 'nothing', reason: 'no new messages since the last build' }
      const chars = span.messages.reduce((n, m) => n + m.text.length, 0)
      const needTurns = Math.max(cfg.buildEveryTurns, st.retryAt)
      if (!force && (span.userTurns < needTurns || chars < cfg.buildMinChars)) {
        return { status: 'skipped', reason: `${span.userTurns}/${needTurns} human turns, ${chars}/${cfg.buildMinChars} chars` }
      }
      const pinned = st.pin === undefined ? span.messages : span.messages.filter((m) => m.seq <= st.pin)
      if (pinned.length === 0) st.pin = undefined
      // Every prompt is read; a span too long for one call is read in whole turns, oldest first (#46).
      const plan = planSpan(pinned.length > 0 ? pinned : span.messages, cfg.builderMaxInputChars)
      read = plan.messages
      // Never past what this build read: a pin left by a build that read into a running turn must
      // not carry a command build (which stops before that turn) beyond its own span.
      endSeq = plan.rest ? plan.rest.seq - 1 : Math.min(st.pin ?? Infinity, span.lastSeq)
      const llm = ctx.get('llm')
      if (!llm) return { status: 'unavailable', reason: 'no llm service in this composition' }
      const target = rt.resolveTarget(agent)
      if (!target) return { status: 'unavailable', reason: 'no provider/model routed yet' }
      // A chat gets its folder and chat number only when it is first indexed (#38).
      if (!meta) meta = await rt.updateFor(agent, (m) => m)
      const chat = chatDir(rt.dirFor(agent), sid)
      const graph = await loadGraph(chat, { writable: true })
      const prompt = builderPrompt({ graph, summary: meta.summary, messages: read, assistantCap: plan.assistantCap })
      const effort = await lowestEffort(llm, target, signal)
      const assembler = new BlockAssembler()
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        ...(effort ? { reasoningEffort: effort } : {}),
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
      const usable = delta ? delta.nodes.filter((n) => n.msgs.some((i) => i < read.length)) : []
      // "Nothing worth remembering" is a complete answer whose nodes are empty (or that says skip);
      // an answer cut off by the token cap never counts as one.
      const nothing = usable.length === 0 && delta?.skip === true && end?.kind !== 'max-tokens'
      if (!delta || (usable.length === 0 && !nothing)) {
        // An unusable answer is a failure, not an empty build: the span stays unindexed and is
        // retried later instead of being skipped for good (#14). The raw answer is kept for diagnosis.
        const saved = join(chat, 'last-builder-output.txt')
        await mkdir(chat, { recursive: true })
        await writeFile(saved, `finish: ${end?.kind}\n\n--- answer ---\n${answer}\n\n--- reasoning ---\n${reasoning}\n`, 'utf8')
        const cutOff = end?.kind === 'max-tokens'
        const why = cutOff
          ? `the model ran out of output tokens (builderMaxTokens ${cfg.builderMaxTokens}) before finishing`
          : delta ? 'the model\'s answer had no topic citing a message of this span' : 'builder output was not the expected JSON'
        st.failedAnswers = (st.failedAnswers ?? 0) + 1
        if (st.failedAnswers >= MAX_FAILED_ANSWERS) {
          // A span the model keeps failing on is skipped, and only that span: turns that arrived
          // since stay unindexed for the next build, which waits the normal number of turns (#45, #53).
          st.failedAnswers = 0
          st.pin = undefined
          st.retryAt = 0
          await rt.updateFor(agent, (latest) => ({ ...latest, builtSeq: Math.max(latest.builtSeq ?? -1, endSeq) }))
          return finish({ status: 'failed', reason: `${why}; skipped these turns after ${MAX_FAILED_ANSWERS} unusable answers in a row; raw output saved to ${saved}` })
        }
        return failed(`${why}; raw output saved to ${saved}`, { half: cutOff })
      }
      st.failedAnswers = 0
      st.pin = undefined
      delta.nodes = usable
      const now = new Date().toISOString()
      const refsOf = (msgs) => msgs.map((i) => read[i]?.seq).filter(Number.isInteger)
      const touched = mergeDelta(graph, delta, { now, refsOf })
      // Commit order: the cited text first (idempotent by seq), then the graph that points at it,
      // then the index position. A crash in between can repeat work but never attaches the wrong
      // text to a topic (#12).
      const cited = [...new Set(usable.flatMap((n) => n.msgs))].map((i) => read[i]).filter(Boolean)
      await saveMessages(chat, cited)
      await saveGraph(chat, graph)
      await rt.updateFor(agent, (latest) => ({
        ...latest,
        // dsh's own title (model-made or the user's rename) once there is one (#41).
        title: span.title ?? latest.title ?? titleOf(eventAt),
        firstPrompt: latest.firstPrompt ?? titleOf(eventAt),
        ...(delta.summary ? { summary: delta.summary } : {}),
        lastActiveAt: now,
        builtSeq: endSeq
      }))
      st.retryAt = 0
      meter.builds++
      return finish({ status: 'built', nodes: touched.length, newNodes: touched.filter((t) => t.isNew).length, totalNodes: Object.keys(graph.nodes).length, edges: graph.edges.length, dir: chat, more: Boolean(plan.rest) })
    } catch (error) {
      if (signal?.aborted) return finish({ status: 'cancelled', reason: 'the command was cancelled' })
      console.error('context-graph: build failed (non-fatal)', error)
      return failed(String(error?.message ?? error))
    } finally {
      st.building = false
    }
  }

  /**
   * A chat resumed for a few turns is active again even if nothing was indexed (#40): its
   * last-active time moves, at most once an hour, so it ranks as recent and shows up for "today".
   */
  async function touch(agent) {
    if (rt.isSubagent(agent)) return
    const meta = await rt.metaFor(agent)
    if (!meta || !memoryOn(meta)) return
    if (Date.now() - Date.parse(meta.lastActiveAt ?? 0) < TOUCH_MS) return
    await rt.updateFor(agent, (latest) => ({ ...latest, lastActiveAt: new Date().toISOString() }))
  }

  ctx.on('agent/turn-stopping', (payload) => {
    // Fire and forget: the build must never delay the turn's close.
    void build(payload.agent)
      .then((result) => (result.status === 'built' ? undefined : touch(payload.agent)))
      .catch((error) => console.error('context-graph: activity update failed (non-fatal)', error))
  })

  return build
}
