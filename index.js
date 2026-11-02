/**
 * dsh-context-graph: memory of past conversations as a small graph, so the model reads node
 * gists instead of old messages and fetches verbatim text only when it needs it.
 *
 * - `agent/turn-stopping`: every few human turns, one cheap auxiliary model call indexes the new
 *   span into `<workspace>/.context-graph/graph.json` and stores the cited messages verbatim.
 * - `agent/pre-step`: on a human turn, lexically match the prompt against the graph and append one
 *   short `[context-graph]` block to the admitted messages (end of the request, so the provider's
 *   prefix cache survives). The first human turn of a session also gets the cross-session surface layer.
 * - Tool `recall`: verbatim source and neighbours of one node.
 * - `llm/stream`: meters main vs builder tokens and cache reads for `/context-graph stats`.
 * Stock compaction is untouched.
 */

import { isAbsolute, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { mkdir, stat, writeFile } from 'node:fs/promises'

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  builderInstruction, collectSpan, emptyGraph, estimateTokens, foldKept, matchNodes, mergeDelta, neighbors, onlyFromSession,
  parseBuilderOutput, planFold, renderFoldIndex, renderHits, renderSurface, SOURCE_KIND, surfaceNodes, transcriptForBuilder,
  turnIndex, turnTranscript
} from './graph.js'
import { appendSource, loadGraph, readSource, saveGraph } from './store.js'
import { startUpdateCheck } from './update.js'

export const name = 'context-graph'
export const inject = ['tools']

const PURPOSE = 'context-graph'
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

const DEFAULTS = {
  dir: '.context-graph',
  buildEveryTurns: 4,
  buildMinChars: 400,
  maxHits: 5,
  inlineMaxChars: 1200,
  surfaceMaxNodes: 40,
  builderMaxTokens: 8192,
  provider: '',
  model: '',
  fold: true,
  foldAtTokens: 24000,
  keepTurns: 2
}

const textOf = (content) => (Array.isArray(content) ? content : []).filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim()

export function apply(ctx, config = {}) {
  const { _updates, ...rest } = config
  const cfg = { ...DEFAULTS, ...rest }
  // `_updates` lets tests stand in for the network check.
  const updates = _updates ?? startUpdateCheck(version)
  let noticeShown = false
  const sessions = new Map()
  const graphCache = new Map()
  const meter = {
    main: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builder: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builds: 0,
    folds: 0,
    foldSaved: 0,
    injected: 0,
    injectedTokens: 0,
    recalls: 0
  }

  const state = (sid) => {
    let st = sessions.get(sid)
    if (!st) { st = { lastBuiltSeq: -1, building: false, surfaceSent: false }; sessions.set(sid, st) }
    return st
  }

  function dirFor(agent) {
    const base = agent.options?.cwd ?? agent.session.header?.cwd ?? process.cwd()
    return isAbsolute(cfg.dir) ? cfg.dir : join(base, cfg.dir)
  }

  /** Graph read with an mtime check so other sessions' builds show up without a restart. */
  async function getGraph(dir) {
    let mtimeMs = 0
    try { mtimeMs = (await stat(join(dir, 'graph.json'))).mtimeMs } catch { return emptyGraph() }
    const cached = graphCache.get(dir)
    if (cached && cached.mtimeMs === mtimeMs) return cached.graph
    const graph = await loadGraph(dir)
    graphCache.set(dir, { mtimeMs, graph })
    return graph
  }

  function resolveTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
    const { provider, model } = agent.options ?? {}
    return provider && model ? { provider, model } : undefined
  }

  function surfaceAlreadyOnLog(session) {
    return session.surface.nodes.some((seq) => {
      const event = session.eventAt(seq)
      return event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.layer === 'surface'
    })
  }

  // ---------- builder ----------
  const isSubagent = (agent) => agent.options?.origin === 'subagent' || agent.session.header?.origin === 'subagent'

  async function build(agent, { force = false, turn = null } = {}) {
    const session = agent.session
    const sid = String(session.id)
    const st = state(sid)
    if (st.building) return { status: 'busy' }
    // ponytail: subagent chatter stays out of the project graph; revisit if delegated work holds decisions worth keeping.
    if (isSubagent(agent)) return { status: 'skipped', reason: 'subagent session' }
    st.building = true
    try {
      const span = collectSpan(session.surface.nodes, (seq) => session.eventAt(seq), st.lastBuiltSeq)
      const chars = span.messages.reduce((n, m) => n + m.text.length, 0)
      if (span.messages.length === 0) return { status: 'nothing', reason: 'no new messages since the last build' }
      if (!force && (span.userTurns < cfg.buildEveryTurns || chars < cfg.buildMinChars)) {
        return { status: 'skipped', reason: `${span.userTurns}/${cfg.buildEveryTurns} human turns, ${chars}/${cfg.buildMinChars} chars` }
      }
      const llm = ctx.get('llm')
      if (!llm) return { status: 'unavailable', reason: 'no llm service in this composition' }
      const target = resolveTarget(agent)
      if (!target) return { status: 'unavailable', reason: 'no provider/model routed yet' }
      const dir = dirFor(agent)
      const graph = await loadGraph(dir)
      const prompt = `${transcriptForBuilder(span.messages)}\n\n${builderInstruction(graph)}`
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
        const saved = join(dir, 'last-builder-output.txt')
        await mkdir(dir, { recursive: true })
        await writeFile(saved, `finish: ${finish?.kind}\n\n--- answer ---\n${answer}\n\n--- reasoning ---\n${reasoning}\n`, 'utf8')
        const why = finish?.kind === 'max-tokens'
          ? `the model ran out of output tokens (builderMaxTokens ${cfg.builderMaxTokens}) before finishing`
          : 'builder output was not the expected JSON'
        return { status: 'failed', reason: `${why}; raw output saved to ${saved}` }
      }
      // Reversibility rule: a node is written only when it cites text we can store verbatim.
      delta.nodes = delta.nodes.filter((n) => n.msgs.some((i) => span.messages[i]))
      const now = new Date().toISOString()
      const touched = mergeDelta(graph, delta, { session: sid, turn, now })
      for (const { id, msgs } of touched) {
        const cited = msgs.map((i) => span.messages[i]).filter(Boolean)
        if (cited.length > 0) await appendSource(dir, id, { session: sid, turn, at: now, messages: cited })
      }
      await saveGraph(dir, graph)
      st.lastBuiltSeq = span.lastSeq
      meter.builds++
      return { status: 'built', nodes: touched.length, newNodes: touched.filter((t) => t.isNew).length, totalNodes: Object.keys(graph.nodes).length, edges: graph.edges.length, dir }
    } catch (error) {
      console.error('context-graph: build failed (non-fatal)', error)
      return { status: 'failed', reason: String(error?.message ?? error) }
    } finally {
      st.building = false
    }
  }

  ctx.on('agent/turn-stopping', (payload) => {
    // Fire and forget: the build must never delay the turn's close.
    void build(payload.agent, { turn: payload.turn })
  })

  // ---------- fold: replace old turns of this chat with a table of contents ----------
  function rangeTokens(session, seqs) {
    const wanted = new Set(seqs)
    try {
      const nodes = ctx.get('tokenMeter')?.measure(session)?.nodes
      if (Array.isArray(nodes)) return nodes.filter((n) => wanted.has(n.seq)).reduce((sum, n) => sum + (n.tokens ?? n.heuristicTokens ?? 0), 0)
    } catch { /* fall back to the estimate */ }
    return seqs.reduce((sum, seq) => sum + estimateTokens(JSON.stringify(session.eventAt(seq)?.data ?? '')), 0)
  }

  async function fold(agent, { force = false } = {}) {
    const session = agent.session
    const sid = String(session.id)
    const eventAt = (seq) => session.eventAt(seq)
    const plan = planFold(session.surface.nodes, eventAt, { keepTurns: cfg.keepTurns, maxSeq: state(sid).lastBuiltSeq })
    if (!plan) return { status: 'skipped', reason: `nothing indexed outside the last ${cfg.keepTurns} turns yet` }
    const before = rangeTokens(session, plan.shadowedSeqs)
    if (!force && before < cfg.foldAtTokens) return { status: 'skipped', reason: `foldable part is ~${before} tokens, folds at ${cfg.foldAtTokens}` }
    const turns = turnIndex(eventAt, plan.endSeq)
    const index = renderFoldIndex(await getGraph(dirFor(agent)), sid, turns, { maxNodes: cfg.surfaceMaxNodes })
    const kept = foldKept(plan.shadowedSeqs, eventAt)
    const after = estimateTokens([index, ...kept.blocks.map((b) => b.text ?? '')].join('\n'))
    // Never-worse gate: a fold must at least halve what it replaces, or it is not worth breaking the cache.
    if (after * 2 > before) return { status: 'skipped', reason: `table of contents (~${after}) is not under half of the ~${before} tokens it would replace` }
    const message = createUserMessage({
      content: [{ type: 'text', text: index }, ...kept.blocks],
      source: { kind: SOURCE_KIND, fold: true, keptKinds: kept.kinds, foldedTurns: turns.length, foldedTokens: before }
    })
    session.append('user/message', message, {
      surfaceOp: { op: 'replace', startSeq: plan.startSeq, endSeq: plan.endSeq },
      sourceEventSeqs: [...plan.shadowedSeqs]
    })
    meter.folds++
    meter.foldSaved += before - after
    return { status: 'folded', turns: turns.length, before, after }
  }

  // ---------- matcher ----------
  ctx.on('agent/pre-step', async (payload, next) => {
    const agent = payload.agent
    const prompt = payload.messages.filter((m) => m.source?.kind === 'user').map((m) => textOf(m.content)).join('\n')
    // Fold only at the start of a human turn: the previous turn is closed, so no tool call is open.
    if (cfg.fold && prompt && !isSubagent(agent)) {
      try { await fold(agent) } catch (error) { console.error('context-graph: fold failed (non-fatal)', error) }
    }
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
      const dir = dirFor(agent)
      const graph = await getGraph(dir)
      if (Object.keys(graph.nodes).length === 0) return decision
      const sid = String(agent.session.id)
      const st = state(sid)
      const sessionCompacted = agent.session.surface.replaceGeneration > 0
      const parts = []
      let layer
      if (!st.surfaceSent) {
        st.surfaceSent = true
        // Nodes that only come from this very session are still in its context: no need to repeat them.
        const ids = surfaceNodes(graph, cfg.surfaceMaxNodes).filter((id) => sessionCompacted || !onlyFromSession(graph.nodes[id], sid))
        if (ids.length > 0 && !surfaceAlreadyOnLog(agent.session)) {
          parts.push(renderSurface(graph, ids))
          layer = 'surface'
        }
      }
      const hits = matchNodes(graph, prompt, { max: cfg.maxHits, session: sid, sessionCompacted })
      let inline
      if (hits.length === 1 || (hits.length > 1 && hits[0].score >= 2 * hits[1].score)) {
        const text = await readSource(dir, hits[0].id)
        if (text && text.length <= cfg.inlineMaxChars) inline = { id: hits[0].id, text }
      }
      const block = renderHits(graph, hits, { inline })
      if (block) parts.push(block)
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
      'Fetch verbatim text behind an id shown in a [context-graph] block: a topic id (n17) returns its source messages and neighbouring topics; a turn id (t7) returns that folded turn of this conversation exactly.',
      'Call it when a gist is relevant but not precise enough to answer. Never invent an id; only use ids you were shown.'
    ].join(' '),
    parameters: {
      id: { type: 'string', required: true, description: 'Topic id such as n17, or turn id such as t7.' },
      depth: { type: 'integer', description: '0 (default): this node only. 1: also include each neighbour\'s gist.' }
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
      const turn = /^t(\d+)$/.exec(id)
      if (turn) {
        const text = turnTranscript((seq) => agent.session.eventAt(seq), Number(turn[1]))
        if (text === undefined) return { status: 'unknown', text: `No turn ${id} in this conversation.` }
        meter.recalls++
        return { status: 'ok', text: `# ${id} (verbatim)\n\n${text}` }
      }
      const dir = dirFor(agent)
      const graph = await getGraph(dir)
      const node = graph.nodes[id]
      if (!node) return { status: 'unknown', text: `No node "${id}" in this project's context graph. Only use ids shown in a [context-graph] block.` }
      meter.recalls++
      node.hits = (node.hits ?? 0) + 1
      saveGraph(dir, graph).catch((error) => console.error('context-graph: hit count save failed', error))
      const lines = [`# ${id} ${node.label}`, `${node.kind}. ${node.gist}`, '']
      const source = await readSource(dir, id)
      lines.push(source ? source.trim() : '(no verbatim source stored for this node)')
      const links = neighbors(graph, id)
      if (links.length > 0) {
        lines.push('', 'Neighbours:')
        for (const link of links) {
          const other = graph.nodes[link.id]
          const arrow = link.direction === 'out' ? `${id} ${link.relation} ${link.id}` : `${link.id} ${link.relation} ${id}`
          lines.push(`- ${arrow}: ${other.label}${args.depth >= 1 ? ` — ${other.gist}` : ''}`)
        }
      }
      return { status: 'ok', text: lines.join('\n') }
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
          description: 'Project memory graph: /context-graph [stats|build|fold|find <words>]',
          // Without `input`, dsh clients run the bare name and send any typed arguments to the model as chat.
          input: { hint: '[stats|build|fold|find <words>]' },
          async handler(invocation) {
            const [sub = 'stats', ...rest] = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
            const agent = invocation.agent
            if (sub === 'fold') {
              const result = await agent.runMaintenance(async () => {
                await build(agent, { force: true })
                return fold(agent, { force: true })
              })
              if (result.status !== 'folded') return { kind: 'error', text: `Not folded: ${result.reason}` }
              return { kind: 'success', text: `Folded t1-t${result.turns} · ~${result.before} → ~${result.after} tokens per request\nThe model now sees a table of contents for these turns and calls recall for exact text.` }
            }
            if (sub === 'build') {
              const result = await agent.runMaintenance(() => build(agent, { force: true }))
              if (result.status !== 'built') return { kind: 'error', text: `Build ${result.status}: ${result.reason ?? ''}`.trim() }
              return { kind: 'success', text: `${result.nodes} topics indexed (${result.newNodes} new) · graph has ${result.totalNodes} topics\nLinks: ${result.edges}\nFolder: ${result.dir}` }
            }
            const graph = await getGraph(dirFor(agent))
            if (sub === 'find') {
              const hits = matchNodes(graph, rest.join(' '), { max: cfg.maxHits })
              if (hits.length === 0) return { kind: 'success', text: 'No matching topics' }
              const lines = hits.map(({ id, node }) => `${id} ${node.label}: ${node.gist}`)
              return { kind: 'success', text: [`${hits.length} matching ${hits.length === 1 ? 'topic' : 'topics'}`, ...lines].join('\n') }
            }
            if (sub !== 'stats') return { kind: 'error', text: 'Usage: /context-graph [stats|build|fold|find <words>]' }
            const m = meter.main
            const cached = m.cacheRead + m.cacheWrite
            const hitRate = m.input + cached > 0 ? Math.round((m.cacheRead / (m.input + cached)) * 100) : 0
            const session = agent.session
            const pending = collectSpan(session.surface.nodes, (seq) => session.eventAt(seq), state(String(session.id)).lastBuiltSeq).userTurns
            return {
              kind: 'success',
              text: [
                `${Object.keys(graph.nodes).length} topics · ${graph.edges.length} links · ${pending} turns waiting to be indexed${updates.current() ? ' · update available' : ''}`,
                `Version ${version}: ${updates.current() ?? 'no newer version found'}`,
                `Graph folder: ${dirFor(agent)}`,
                `This chat indexes itself every ${cfg.buildEveryTurns} turns; /context-graph build indexes it now.`,
                'Counters below are since the app started:',
                `Builds: ${meter.builds}; builder tokens in/out: ${meter.builder.input + meter.builder.cacheRead + meter.builder.cacheWrite}/${meter.builder.output}`,
                `Folds: ${meter.folds}; ~${meter.foldSaved} input tokens removed from every later request`,
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
