/**
 * The builder: every few human turns, one auxiliary model call indexes the chat's new messages into
 * its topic graph, refreshes the chat's one-line summary, and stores the messages the topics cite.
 * Runs after a turn closes, never on the critical path of a reply.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { BlockAssembler } from '@deepseek-ai/dsh-llm'

import { betterParse, builderPrompt, parseBuilderOutput, planSpan } from '../core/builder.js'
import { memoryOn, offPoint, walkGaps } from '../core/chat.js'
import { mergeDelta } from '../core/graph.js'
import { emptyCounters, usedIn } from '../core/ledger.js'
import { collectSpan, firstPromptSeq, lastAnswer, mergeGaps, titleOf } from '../core/session.js'
import { textOf } from '../core/text.js'
import { chatDir, loadGraph, saveGraph } from '../store/chats.js'
import { addToLedger } from '../store/ledger.js'
import { loadMessages, relabelTurns, saveMessages } from '../store/messages.js'
import { PURPOSE } from './config.js'

/** After this many unusable answers in a row for one span, the span is skipped instead of re-sent again. */
const MAX_FAILED_ANSWERS = 3

/** A chat's last-active time is refreshed at most this often on turns that do not index (#40). */
const TOUCH_MS = 3600000

/**
 * A chat with turns too few to index yet is indexed once it has been quiet this long (#42): longer
 * than an ordinary pause between two turns, which would cost an index each (review of #42).
 */
const QUIET_MS = 1800000

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
    // What dsh drove from an off stretch (rounds of a goal set there, a reminder scheduled there)
    // is not stored as gaps: every reader walks the log with the off stretches and finds it there
    // (session.js walk), so meta.gaps stays one entry per off stretch however often a reminder
    // fires (second review of #69).
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
      // An off whose write has not landed yet already holds here (runtime.js withPending).
      if (!memoryOn(meta)) return { status: 'off', reason: 'memory is off for this chat; /context-graph on resumes it' }
      // A fork from before 0.10.0 takes its ancestors' off stretches first (runtime.js inheritOffs).
      meta = await rt.inheritOffs(agent, meta)
      // Read from the durable log after the last indexed seq, so compacted turns are not lost (#13).
      const forkSeq = rt.forkSeqOf(session) ?? 0
      // A fork's own titles start at its own first prompt (review of #60).
      const titleFrom = forkSeq ? (firstPromptSeq(eventAt, forkSeq) ?? Infinity) : 0
      span = collectSpan(eventAt, rt.indexStart(agent, meta), { completeOnly, gaps: walkGaps(meta), titleFrom })
      // A command build that stopped before a running turn: that turn is indexed when it ends (#65).
      if (span.open && force) st.indexAtEnd = true
      if (span.messages.length === 0) return { status: 'nothing', reason: 'no new messages since the last build' }
      const chars = span.messages.reduce((n, m) => n + m.text.length, 0)
      const needTurns = Math.max(cfg.buildEveryTurns, st.retryAt)
      if (!force && (span.userTurns < needTurns || chars < cfg.buildMinChars)) {
        // What is waiting, so a chat that goes quiet below the threshold is still indexed (#42).
        return { status: 'skipped', reason: `${span.userTurns}/${needTurns} human turns, ${chars}/${cfg.buildMinChars} chars`, userTurns: span.userTurns, chars }
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
      // A chat gets its folder and chat number only when it is first indexed (#38); a fork has its
      // meta, with its inherited flags, from the moment it is first seen (runtime.js).
      if (!meta) meta = await rt.updateFor(agent, (m) => m)
      const chat = chatDir(rt.dirFor(agent), sid)
      const graph = await loadGraph(chat, { writable: true })
      // The indexing call's usage is this chat's cost in the savings estimate (meter.js).
      st.chat = true
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
      await relabelTurns(chat, span.turnAt).catch((error) => console.error('context-graph: stored turn ids not relabelled (non-fatal)', error))
      await saveGraph(chat, graph)
      await rt.updateFor(agent, (latest) => {
        return {
          ...latest,
          // dsh's own title (model-made or the user's rename) once there is one (#41). A meta whose
          // off stretches were lost (recovered, turnsClosed) takes no new title from the log (review).
          // (Its first-prompt fingerprint is set by runtime.js upToDate before this change runs.)
          title: latest.turnsClosed === true ? latest.title : span.title ?? latest.title ?? titleOf(eventAt, 60, forkSeq, mergeGaps(latest.gaps, span.hidden)),
          ...(delta.summary ? { summary: delta.summary } : {}),
          lastActiveAt: now,
          builtSeq: endSeq
        }
      })
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

  /**
   * Close the turn's savings estimate (#35): topics shown this turn that the answer used count as
   * saved, once per chat; then the turn's counters go to the workspace ledger in one write. A use
   * judged now but not credited yet (the ledger cannot be read) waits in `toCredit` for the next
   * turn instead of being lost (review).
   */
  async function settle(agent, turn = { pending: [], answer: '' }) {
    if (rt.isSubagent(agent)) return
    const sid = rt.sidOf(agent)
    const st = rt.tracked(sid)
    if (!st) return
    const dir = rt.dirFor(agent)
    for (const p of turn.pending) if (usedIn(turn.answer, p.node, p.prompt)) st.toCredit.push(p)
    while (st.toCredit.length > 0) {
      const p = st.toCredit[0]
      // A source that cannot be read stands in for nothing; the use still counts.
      await rt.creditUse(agent, { id: p.id, node: p.node, cid: p.cid, stored: await loadMessages(chatDir(dir, p.sid)).catch(() => ({})) })
      st.toCredit.shift()
    }
    const delta = st.delta
    const used = st.newlyUsed
    const credited = st.newlyCredited
    if (Object.values(delta).every((n) => n === 0) && used.length === 0) return
    st.delta = emptyCounters()
    st.newlyUsed = []
    st.newlyCredited = []
    try {
      await addToLedger(dir, sid, delta, used, credited)
    } catch (error) {
      // Kept for the next turn's write instead of being lost.
      for (const [key, n] of Object.entries(delta)) st.delta[key] += n
      st.newlyUsed.push(...used)
      st.newlyCredited.push(...credited)
      throw error
    }
  }

  /**
   * Memory back on (#59): what was typed while it was off becomes a gap that is never indexed or
   * served, and the chat is indexed up to its last finished turn (a running turn when it ends).
   */
  async function turnOn(agent, { deferred = false } = {}) {
    const end = collectSpan((seq) => agent.session.eventAt(seq)).lastSeq
    let applied = false
    const meta = await rt.updateFor(agent, (m) => {
      // A deferred on that an off has cancelled since does nothing: the later command wins (review).
      if (deferred && m.onWhenIdle !== true) return m
      applied = true
      const { offSeq, onWhenIdle, ...rest } = m
      const from = offPoint(m)
      const gaps = Array.isArray(m.gaps) ? [...m.gaps] : []
      if (from !== undefined && end > from) gaps.push([from + 1, end])
      // Never drop a stretch: past 50 the two oldest merge, also covering the on stretch between them.
      while (gaps.length > 50) gaps.splice(0, 2, [gaps[0][0], gaps[1][1]])
      // A meta that lost its stretches is unsure only up to here: what follows is typed with memory on.
      const closed = m.turnsClosed === true && !Number.isInteger(m.closedThrough) ? { closedThrough: end } : {}
      return { ...rest, memoryOff: false, ...(gaps.length ? { gaps } : {}), ...closed, lastActiveAt: new Date().toISOString() }
    })
    if (!applied) return undefined
    // The chat list may be sent again (memory.js), once.
    const st = rt.state(rt.sidOf(agent))
    Object.assign(st, { announce: true, listed: false })
    // A turn end's own build may still be running: then the next turn end indexes (as for #65).
    void build(agent, { force: true, completeOnly: true }).then((result) => { if (result.status === 'busy') st.indexAtEnd = true })
    return meta
  }

  /**
   * An `on` that waited for the chat to be idle (command.js) takes effect at a turn end, or when the
   * agent goes idle (a stopped or failed turn has no turn end), once no input the user typed is
   * still queued. Outside a turn end (`ending`), the chat must also have no turn running: the
   * check also runs right after the command, when an agent is created (an app restart left the on
   * waiting) and when queued input is removed, none of which brings a turn end (third review).
   */
  async function onAtIdle(agent, { ending = false } = {}) {
    if (rt.isSubagent(agent) || rt.pendingInput(agent)) return false
    if (!ending && (agent.status === 'running' || collectSpan((seq) => agent.session.eventAt(seq), -1, { completeOnly: true }).open)) return false
    if ((await rt.metaFor(agent))?.onWhenIdle !== true) return false
    return (await turnOn(agent, { deferred: true })) !== undefined
  }

  /**
   * A chat left with turns too few to index (below buildEveryTurns, #42): short chats and the last
   * turns of long ones, which often hold the conclusion. It is indexed once quiet for QUIET_MS, or
   * at once when a new chat of its workspace starts (the user has moved on); a turn starting in it
   * cancels that. Timers come from dsh's timer service, so they end with the plugin; without one,
   * chats wait for their next turns as before. A chat cannot tell paused from left, so its timer runs at most once
   * between two regular builds: one resumed after every pause would otherwise be indexed at every
   * turn end (review of #42). A new chat still flushes it every time (the user has moved on, once
   * per new chat), and only a flush that indexed counts as the one (second review). ponytail: an app quit before the timer
   * fires leaves the tail until that chat's next turn; a startup scan (sessionQuery.listSessions)
   * if it matters.
   */
  const quiet = new Map()
  /** Chats indexed once quiet since their last regular build. */
  const flushed = new Set()
  function whenQuiet(agent, result) {
    const sid = rt.sidOf(agent)
    if (result?.status === 'built') flushed.delete(sid)
    const timer = ctx.get('timer')
    if (!timer || result?.status !== 'skipped' || !(result.userTurns >= 1 && result.chars >= cfg.buildMinChars)) return
    quiet.get(sid)?.cancel()
    const entry = { agent, dir: rt.dirFor(agent), cancel: () => {} }
    if (!flushed.has(sid)) entry.cancel = timer.timeout(() => { if (quiet.get(sid) === entry) flush(sid) }, QUIET_MS)
    quiet.set(sid, entry)
  }
  function flush(sid, { early = false } = {}) {
    const entry = quiet.get(sid)
    quiet.delete(sid)
    if (early) entry.cancel()
    // Stops before a running turn, so a flush that comes late never splits one. Memory off, a busy
    // chat or an unusable answer leave the timer to the next turn end.
    void build(entry.agent, { force: true, completeOnly: true }).then((result) => { if (result?.status === 'built') flushed.add(sid) })
  }
  function started(agent) {
    if (rt.isSubagent(agent)) return
    const sid = rt.sidOf(agent)
    quiet.get(sid)?.cancel()
    quiet.delete(sid)
    if (quiet.size === 0 || hasAnswer(agent)) return
    const dir = rt.dirFor(agent)
    for (const [other, entry] of quiet) if (entry.dir === dir) flush(other, { early: true })
  }
  const hasAnswer = (agent) => {
    for (let seq = 0; ; seq++) {
      const event = agent.session.eventAt(seq)
      if (!event) return false
      if (event.type === 'assistant/message') return true
    }
  }

  const whenIdle = (agent) => void onAtIdle(agent).catch((error) => console.error('context-graph: memory on at idle failed (non-fatal)', error))
  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') return started(agent)
    if (status !== 'idle') return
    // A turn that ended normally gave its shown topics to its turn end; a stopped or failed one did
    // not, and they must not be judged against the next turn's answer (third review).
    if (!rt.isSubagent(agent)) rt.state(rt.sidOf(agent)).pending = []
    whenIdle(agent)
  })
  ctx.on('agent/created', ({ agent }) => whenIdle(agent))
  ctx.on('agent/inbox/discarded', ({ agent }) => whenIdle(agent))

  ctx.on('agent/turn-stopping', (payload) => {
    const agent = payload.agent
    const st = rt.state(rt.sidOf(agent))
    const force = st.indexAtEnd === true
    st.indexAtEnd = false
    // This turn's shown topics and its answer, taken now: the index call below can outlast the
    // turn, and a turn must be judged by its own answer, not the next one's (review of #35).
    const turn = { pending: st.pending, answer: st.pending.length > 0 ? lastAnswer(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq)) : '' }
    st.pending = []
    // Fire and forget: the build must never delay the turn's close.
    void onAtIdle(payload.agent, { ending: true })
      .then((resumed) => (resumed ? { status: 'resumed' } : build(payload.agent, { force })))
      .then((result) => {
        if (force && result.status === 'busy') st.indexAtEnd = true
        whenQuiet(payload.agent, result)
        return result.status === 'built' ? undefined : touch(payload.agent)
      })
      .catch((error) => console.error('context-graph: activity update failed (non-fatal)', error))
      // The savings estimate is settled however the index went (review of #35).
      .then(() => settle(payload.agent, turn))
      .catch((error) => console.error('context-graph: savings not written this turn, kept for the next (non-fatal)', error))
  })

  return { build, turnOn, onAtIdle }
}
