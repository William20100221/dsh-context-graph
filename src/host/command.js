/**
 * The `/context-graph` command. Nested plugin: it starts only where a human-command surface exists
 * (the Web and desktop apps), not in headless or ACP runs.
 */

import { memoryOn, sharedOn } from '../core/chat.js'
import { matchAcross } from '../core/match.js'
import { renderMap } from '../core/render.js'
import { collectSpan } from '../core/session.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir, listChats, loadGraph } from '../store/chats.js'
import { USAGE, version } from './config.js'

export function registerCommand(ctx, rt, { build, meter, updates }) {
  const { cfg } = rt
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
            const sid = rt.sidOf(agent)
            if (sub === 'on') {
              await rt.setFlags(agent, { memoryOff: false })
              rt.state(sid).announce = true
              const result = await agent.runMaintenance(() => build(agent, { force: true }))
              const shared = (await rt.loadViews(agent)).filter((v) => !v.own).length
              const indexed = result.status === 'built' ? `${result.totalNodes} topics in this chat` : `nothing indexed yet (${result.reason ?? result.status})`
              return { kind: 'success', text: `Memory on · ${indexed} · ${shared} shared ${shared === 1 ? 'chat' : 'chats'} to draw on\nThis chat indexes itself every ${cfg.buildEveryTurns} turns and other chats in this workspace can use it. /context-graph unshare keeps it private; /context-graph off stops it.` }
            }
            if (sub === 'off') {
              await rt.setFlags(agent, { memoryOff: true })
              return { kind: 'success', text: 'Memory off for this chat · nothing is added to its requests\nThe graph stays; /context-graph on resumes. To turn memory off in every chat, switch dsh-context-graph off on the Plugins page.' }
            }
            if (sub === 'share' || sub === 'unshare') {
              const meta = await rt.setFlags(agent, { private: sub === 'unshare' })
              const topics = Object.keys((await loadGraph(chatDir(rt.dirFor(agent), sid))).nodes).length
              const hint = memoryOn(meta) ? '' : '\nMemory is off for this chat, so it has nothing new to share until /context-graph on.'
              return { kind: 'success', text: sub === 'share' ? `Shared with the workspace · ${topics} topics\nOther chats with memory on can now match and recall this chat.${hint}` : `No longer shared · ${topics} topics stay private to this chat` }
            }
            if (sub === 'build') {
              const result = await agent.runMaintenance(() => build(agent, { force: true }))
              if (result.status !== 'built') return { kind: 'error', text: `Build ${result.status}: ${result.reason ?? ''}`.trim() }
              return { kind: 'success', text: `${result.nodes} topics indexed (${result.newNodes} new) · this chat has ${result.totalNodes} topics\nLinks: ${result.edges}\nFolder: ${result.dir}` }
            }
            const views = await rt.loadViews(agent)
            if (sub === 'map') {
              const all = []
              for (const { sid: other, meta } of await listChats(rt.dirFor(agent))) all.push({ sid: other, cid: meta.cid, meta, own: other === sid, graph: await loadGraph(chatDir(rt.dirFor(agent), other)) })
              return { kind: 'success', text: `${all.length} ${all.length === 1 ? 'chat' : 'chats'} in ${rt.dirFor(agent)}\n${renderMap(all)}` }
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
                `Graph folder: ${rt.dirFor(agent)}`,
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
