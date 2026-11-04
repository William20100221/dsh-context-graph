/**
 * dsh-context-graph: memory of past chats as small per-chat graphs.
 *
 * On in every chat by default. `/context-graph off` stops one chat; switching the plugin off on
 * dsh's Plugins page stops all of them. While on:
 * - `agent/turn-stopping`: every few human turns, one auxiliary model call indexes the new span
 *   into `<workspace>/.context-graph/chats/<session>/graph.json` and stores the cited text verbatim.
 * - `agent/pre-step`: on a human turn, match the prompt against the other shared chats (all chats unless unshared) of this
 *   workspace (a named day is searched first) and append one short `[context-graph]` block at the
 *   end of the request, so the provider's prefix cache survives. On a chat's first message, one block lists
 *   the shared chats, newest first.
 * - Tool `recall`: a topic (c3n12), a chat (c3), a day (2026-11-01) or a turn of this chat (t7).
 * - `llm/stream`: meters main vs builder tokens and cache reads for `/context-graph stats`.
 * Nothing is merged between chats; sharing is a flag on the chat. Stock compaction is untouched.
 */

import { isAbsolute, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  builderInstruction, collectSpan, estimateTokens, matchAcross, memoryOn, mergeDelta, sharedOn, neighbors, parseBuilderOutput, parseTimeRange,
  renderChatIndex, renderChats, renderHits, renderMap, renderRange, shownContext, SOURCE_KIND, tailWithin, titleOf, transcriptForBuilder, turnTranscript
} from './graph.js'
import { appendSource, chatDir, ensureMeta, listChats, loadGraph, loadMeta, readSource, saveGraph, saveMeta } from './store.js'
import { startUpdateCheck } from './update.js'

export const name = 'context-graph'
export const inject = ['tools']

const PURPOSE = 'context-graph'
const USAGE = '[on|off|share|unshare|stats|build|map|find <words>]'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const DEFAULTS = {
  dir: '.context-graph',
  buildEveryTurns: 4,
  buildMinChars: 400,
  maxHits: 5,
  inlineMaxChars: 1200,
  surfaceMaxChats: 20,
  builderMaxTokens: 8192,
  builderMaxInputChars: 60000,
  provider: '',
  model: ''
}

const textOf = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()

export function apply(ctx, config = {}) {
  const { _updates, ...rest } = config
  const cfg = { ...DEFAULTS, ...rest }
  // `_updates` lets tests stand in for the network check.
  const updates = _updates ?? startUpdateCheck(version)
  let noticeShown = false
  const sessions = new Map()
  const meter = {
    main: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builder: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builds: 0,
    injected: 0,
    injectedTokens: 0,
    recalls: 0
  }

  const state = (sid) => {
    let st = sessions.get(sid)
    // retryAt: after a failed build, wait for this many new human turns before trying again (#3).
    if (!st) { st = { building: false, announce: true, retryAt: 0 }; sessions.set(sid, st) }
    return st
  }

  const sidOf = (agent) => String(agent.session.id)
  const isSubagent = (agent) => agent.options?.origin === 'subagent' || agent.session.header?.origin === 'subagent'

  function dirFor(agent) {
    const base = agent.options?.cwd ?? agent.session.header?.cwd ?? process.cwd()
    return isAbsolute(cfg.dir) ? cfg.dir : join(base, cfg.dir)
  }

  const metaFor = (agent) => loadMeta(dirFor(agent), sidOf(agent))

  async function setFlags(agent, flags) {
    const dir = dirFor(agent)
    const session = agent.session
    const now = new Date().toISOString()
    const meta = await ensureMeta(dir, sidOf(agent), { title: titleOf((seq) => session.eventAt(seq)), workspace: dir, now })
    Object.assign(meta, flags, { lastActiveAt: now })
    await saveMeta(dir, sidOf(agent), meta)
    return meta
  }

  /** Own chat plus every shared chat of the workspace, graphs loaded. ponytail: re-read per turn; cache by mtime if a workspace grows large. */
  async function loadViews(agent) {
    const dir = dirFor(agent)
    const sid = sidOf(agent)
    const views = []
    for (const { sid: other, meta } of await listChats(dir)) {
      const own = other === sid
      if (!own && !sharedOn(meta)) continue
      views.push({ sid: other, cid: meta.cid, meta, own, graph: await loadGraph(chatDir(dir, other)) })
    }
    return views
  }

  function resolveTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
    const { provider, model } = agent.options ?? {}
    return provider && model ? { provider, model } : undefined
  }

  // ---------- builder ----------
  async function build(agent, { force = false, turn = null } = {}) {
    const session = agent.session
    const sid = sidOf(agent)
    const st = state(sid)
    if (st.building) return { status: 'busy' }
    // ponytail: subagent chatter stays out of the graph; revisit if delegated work holds decisions worth keeping.
    if (isSubagent(agent)) return { status: 'skipped', reason: 'subagent session' }
    st.building = true
    let span
    const failed = (reason) => {
      if (span) st.retryAt = span.userTurns + cfg.buildEveryTurns
      return { status: 'failed', reason }
    }
    try {
      let meta = await metaFor(agent)
      if (!memoryOn(meta)) return { status: 'off', reason: 'memory is off for this chat; /context-graph on resumes it' }
      // A chat that never ran a command has no folder yet; give it one so it gets a chat number (#1).
      if (!meta) meta = await setFlags(agent, {})
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
      const target = resolveTarget(agent)
      if (!target) return { status: 'unavailable', reason: 'no provider/model routed yet' }
      const chat = chatDir(dirFor(agent), sid)
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
      const latest = (await metaFor(agent)) ?? meta
      await saveMeta(dirFor(agent), sid, { ...latest, title: latest.title ?? titleOf((seq) => session.eventAt(seq)), lastActiveAt: now, turns: (latest.turns ?? 0) + span.userTurns, builtSeq: span.lastSeq })
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

  // ---------- matcher ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const prompt = payload.messages.filter((m) => m.source?.kind === 'user').map((m) => textOf(m.content)).join('\n')
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const result = await addMemory(agent, prompt, decision)
    return prompt && !isSubagent(agent) ? addUpdateNotice(result) : result
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
      if (isSubagent(agent) || !prompt) return decision
      if (!memoryOn(await metaFor(agent))) return decision
      const st = state(sidOf(agent))
      const views = await loadViews(agent)
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
        const block = renderRange(views.filter((v) => !v.own), range)
        const ids = block.match(/\bc\d+n\d+\b/g) ?? []
        const seen = shown.texts.has(block) || (ids.length > 0 && ids.every((id) => shown.ids.has(id)))
        if (!seen) parts.push(block)
      } else {
        let inline
        if (hits.length === 1 || (hits.length > 1 && hits[0].score >= 2 * hits[1].score)) {
          const top = hits[0]
          const text = await readSource(chatDir(dirFor(agent), top.view.sid), top.id.slice(top.id.indexOf('n')))
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

  // ---------- meter ----------
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    const bucket = options.purpose === PURPOSE ? meter.builder : meter.main
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk?.type === 'usage' && chunk.usage) {
            bucket.input += chunk.usage.inputTokens ?? 0
            bucket.cacheRead += chunk.usage.cacheReadTokens ?? 0
            bucket.cacheWrite += chunk.usage.cacheWriteTokens ?? 0
            bucket.output += chunk.usage.outputTokens ?? 0
          }
          yield chunk
        }
      } finally {
        bucket.requests++
      }
    }
    return tracked()
  })

  // ---------- recall tool ----------
  ctx.tools.register(defineTool({
    name: 'recall',
    description: [
      'Fetch the exact text behind an id shown in a [context-graph] block. A topic id (c3n12) returns its verbatim source and linked topics;',
      'a chat id (c3) returns that chat\'s topics; a day (2026-11-01) returns every chat and topic from that day; a turn id (t7) returns turn 7 of this chat word for word.',
      'Call it when a gist is relevant but not precise enough to answer. Never invent an id; only use ids you were shown.'
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'c3n12 (topic), c3 (chat), 2026-11-01 (day) or t7 (turn of this chat).' },
      depth: { type: 'integer', description: '0 (default): this topic only. 1: also include each linked topic\'s gist.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok', 'unknown'], required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text }]
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent?.session) return { status: 'unknown', text: 'recall is unavailable: no session attached to this call.' }
      const id = String(args.id ?? '').trim()
      const ok = (text) => { meter.recalls++; return { status: 'ok', text } }
      const turn = /^t(\d+)$/.exec(id)
      if (turn) {
        const text = turnTranscript((seq) => agent.session.eventAt(seq), Number(turn[1]))
        return text === undefined ? { status: 'unknown', text: `No turn ${id} in this chat.` } : ok(`# ${id} (verbatim)\n\n${text}`)
      }
      const views = await loadViews(agent)
      if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return ok(renderRange(views.filter((v) => !v.own), parseTimeRange(id)))
      const m = /^(?:c(\d+))?(n\d+)?$/.exec(id)
      if (!m || (!m[1] && !m[2])) return { status: 'unknown', text: `"${id}" is not an id. Use c3n12, c3, 2026-11-01 or t7, and only ids you were shown.` }
      const view = m[1] ? views.find((v) => String(v.cid) === m[1]) : views.find((v) => v.own)
      if (!view) return { status: 'unknown', text: m[1] ? `No chat c${m[1]} shared in this workspace.` : 'This chat has no indexed topics yet. Use a full id such as c3n12 from a [context-graph] block.' }
      if (!m[2]) return ok(renderChatIndex(view))
      const node = view.graph.nodes[m[2]]
      if (!node) return { status: 'unknown', text: `No topic ${id}. Only use ids shown in a [context-graph] block.` }
      node.hits = (node.hits ?? 0) + 1
      const chat = chatDir(dirFor(agent), view.sid)
      saveGraph(chat, view.graph).catch((error) => console.error('context-graph: hit count save failed', error))
      const lines = [`# ${id} ${node.label}`, `${node.kind}. ${node.gist}`, '']
      const source = await readSource(chat, m[2])
      lines.push(source ? source.trim() : '(no verbatim source stored for this topic)')
      const links = neighbors(view.graph, m[2])
      if (links.length > 0) {
        lines.push('', 'Linked topics:')
        for (const link of links) {
          const other = view.graph.nodes[link.id]
          const otherId = `c${view.cid}${link.id}`
          const arrow = link.direction === 'out' ? `${id} ${link.relation} ${otherId}` : `${otherId} ${link.relation} ${id}`
          lines.push(`- ${arrow}: ${other.label}${args.depth >= 1 ? ` — ${other.gist}` : ''}`)
        }
      }
      return ok(lines.join('\n'))
    }
  }))

  // ---------- /context-graph command (nested: only where a human-command surface exists) ----------
  ctx.plugin({
    name: 'context-graph-command',
    inject: ['commands'],
    apply(cmdCtx) {
      cmdCtx.effect(function* () {
        yield cmdCtx.commands.register({
          name: 'context-graph',
          description: `Chat memory graph: /context-graph ${USAGE}`,
          // Without `input`, dsh clients run the bare name and send any typed arguments to the model as chat.
          input: { hint: USAGE },
          async handler(invocation) {
            const [sub = 'stats', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
            const agent = invocation.agent
            const sid = sidOf(agent)
            if (sub === 'on') {
              await setFlags(agent, { memoryOff: false })
              state(sid).announce = true
              const result = await agent.runMaintenance(() => build(agent, { force: true }))
              const shared = (await loadViews(agent)).filter((v) => !v.own).length
              const indexed = result.status === 'built' ? `${result.totalNodes} topics in this chat` : `nothing indexed yet (${result.reason ?? result.status})`
              return { kind: 'success', text: `Memory on · ${indexed} · ${shared} shared ${shared === 1 ? 'chat' : 'chats'} to draw on\nThis chat indexes itself every ${cfg.buildEveryTurns} turns and other chats in this workspace can use it. /context-graph unshare keeps it private; /context-graph off stops it.` }
            }
            if (sub === 'off') {
              await setFlags(agent, { memoryOff: true })
              return { kind: 'success', text: 'Memory off for this chat · nothing is added to its requests\nThe graph stays; /context-graph on resumes. To turn memory off in every chat, switch dsh-context-graph off on the Plugins page.' }
            }
            if (sub === 'share' || sub === 'unshare') {
              const meta = await setFlags(agent, { private: sub === 'unshare' })
              const topics = Object.keys((await loadGraph(chatDir(dirFor(agent), sid))).nodes).length
              const hint = memoryOn(meta) ? '' : '\nMemory is off for this chat, so it has nothing new to share until /context-graph on.'
              return { kind: 'success', text: sub === 'share' ? `Shared with the workspace · ${topics} topics\nOther chats with memory on can now match and recall this chat.${hint}` : `No longer shared · ${topics} topics stay private to this chat` }
            }
            if (sub === 'build') {
              const result = await agent.runMaintenance(() => build(agent, { force: true }))
              if (result.status !== 'built') return { kind: 'error', text: `Build ${result.status}: ${result.reason ?? ''}`.trim() }
              return { kind: 'success', text: `${result.nodes} topics indexed (${result.newNodes} new) · this chat has ${result.totalNodes} topics\nLinks: ${result.edges}\nFolder: ${result.dir}` }
            }
            const views = await loadViews(agent)
            if (sub === 'map') {
              const all = []
              for (const { sid: other, meta } of await listChats(dirFor(agent))) all.push({ sid: other, cid: meta.cid, meta, own: other === sid, graph: await loadGraph(chatDir(dirFor(agent), other)) })
              return { kind: 'success', text: `${all.length} ${all.length === 1 ? 'chat' : 'chats'} in ${dirFor(agent)}\n${renderMap(all)}` }
            }
            if (sub === 'find') {
              const query = rest.join(' ')
              const { hits } = matchAcross(views, query, { max: cfg.maxHits, range: parseTimeRange(query) })
              if (hits.length === 0) return { kind: 'success', text: 'No matching topics in shared chats' }
              return { kind: 'success', text: [`${hits.length} matching ${hits.length === 1 ? 'topic' : 'topics'}`, ...hits.map(({ id, node }) => `${id} ${node.label}: ${node.gist}`)].join('\n') }
            }
            if (sub !== 'stats') return { kind: 'error', text: `Usage: /context-graph ${USAGE}` }
            const own = views.find((v) => v.own)
            const m = meter.main
            const cached = m.cacheRead + m.cacheWrite
            const hitRate = m.input + cached > 0 ? Math.round((m.cacheRead / (m.input + cached)) * 100) : 0
            const session = agent.session
            const pending = collectSpan(session.surface.nodes, (seq) => session.eventAt(seq), own?.meta.builtSeq ?? -1).userTurns
            const shared = views.filter((v) => !v.own).length
            return {
              kind: 'success',
              text: [
                `Memory ${memoryOn(own?.meta) ? 'on' : 'off'} · ${Object.keys(own?.graph.nodes ?? {}).length} topics in this chat · ${sharedOn(own?.meta) ? 'shared' : 'private'} · ${shared} shared ${shared === 1 ? 'chat' : 'chats'} · ${pending} turns waiting to be indexed${updates.current() ? ' · update available' : ''}`,
                `Version ${version}: ${updates.current() ?? 'no newer version found'}`,
                `Graph folder: ${dirFor(agent)}`,
                'Counters below are since the app started:',
                `Builds: ${meter.builds}; builder tokens in/out: ${meter.builder.input + meter.builder.cacheRead + meter.builder.cacheWrite}/${meter.builder.output}`,
                `Injected blocks: ${meter.injected} (~${meter.injectedTokens} tokens); recalls: ${meter.recalls}`,
                `Main requests: ${m.requests}; input ${m.input} uncached + ${m.cacheRead} cache-read + ${m.cacheWrite} cache-write; cache-hit ${hitRate}%`
              ].join('\n')
            }
          }
        })
      }, 'context-graph command')
    }
  })
}
