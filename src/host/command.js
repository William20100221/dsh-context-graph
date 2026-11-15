/**
 * The `/context-graph` command. Nested plugin: it starts only where a human-command surface exists
 * (the Web and desktop apps), not in headless or ACP runs.
 *
 * No subcommand takes the agent's maintenance slot: that held the user's next message for the whole
 * indexing call and failed outright while a turn was running (#19). Builds read the session and
 * write only this plugin's files, and the per-chat `building` flag already prevents overlap.
 */

import { memoryOn, sharedOn } from '../core/chat.js'
import { SCORE, matchAcross } from '../core/match.js'
import { renderMap } from '../core/render.js'
import { collectSpan } from '../core/session.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir, loadGraph } from '../store/chats.js'
import { USAGE, version } from './config.js'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

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
              // The chat list may be sent again (memory.js), once.
              Object.assign(rt.state(sid), { announce: true, listed: false })
              // The flag is the real effect; indexing continues in the background, up to the last
              // finished turn (a running turn is indexed when it ends).
              void build(agent, { force: true, completeOnly: true })
              const shared = (await rt.loadViews(agent)).filter((v) => !v.own && Object.keys(v.graph.nodes).length > 0).length
              return { kind: 'success', text: `Memory on · indexing this chat now · ${plural(shared, 'shared chat')} to draw on\nThis chat indexes itself every ${cfg.buildEveryTurns} turns and other chats in this workspace can use it. /context-graph stats shows progress; /context-graph unshare keeps it private; /context-graph off stops it.` }
            }
            if (sub === 'off') {
              await rt.setFlags(agent, { memoryOff: true })
              return { kind: 'success', text: 'Memory off for this chat · no memory blocks are added and recall cannot read other chats\nThe graph stays; /context-graph on resumes. To turn memory off in every chat, switch dsh-context-graph off on the Plugins page.' }
            }
            if (sub === 'share' || sub === 'unshare') {
              const meta = await rt.setFlags(agent, { private: sub === 'unshare' })
              const topics = Object.keys((await loadGraph(chatDir(rt.dirFor(agent), sid))).nodes).length
              const hint = memoryOn(meta) ? '' : '\nMemory is off for this chat, so it has nothing new to share until /context-graph on.'
              return { kind: 'success', text: sub === 'share' ? `Shared with the workspace · ${plural(topics, 'topic')}\nOther chats with memory on can now match and recall this chat.${hint}` : `No longer shared · ${plural(topics, 'topic')} stay private to this chat` }
            }
            if (sub === 'build') {
              const result = await build(agent, { force: true, signal: invocation.signal, completeOnly: true })
              if (result.status !== 'built') return { kind: 'error', text: `Build ${result.status}: ${result.reason ?? ''}`.trim() }
              return { kind: 'success', text: `${plural(result.nodes, 'topic')} indexed (${result.newNodes} new) · this chat has ${plural(result.totalNodes, 'topic')}${result.more ? ' · older turns read; the rest follows at the next build' : ''}\nLinks: ${result.edges}\nFolder: ${result.dir}` }
            }
            if (sub === 'map') {
              // Every chat of the workspace, private ones too: this is the user's own view. Loaded once (#49).
              const all = await rt.loadViews(agent, { all: true })
              return { kind: 'success', text: `${plural(all.length, 'chat')} in ${rt.dirFor(agent)}\n${renderMap(all)}` }
            }
            const views = await rt.loadViews(agent)
            if (sub === 'find') {
              const query = rest.join(' ')
              // Every match, each copy on its own line: a person searching wants to see all of them.
              const { hits } = matchAcross(views, query, { max: 10, range: parseTimeRange(query), floor: SCORE.label, cover: false, collapse: false })
              if (hits.length === 0) return { kind: 'success', text: 'No matching topics in shared chats' }
              return { kind: 'success', text: [`${hits.length} matching ${hits.length === 1 ? 'topic' : 'topics'}`, ...hits.map(({ id, node }) => `${id} ${node.label}: ${node.gist}`)].join('\n') }
            }
            if (sub !== 'stats') return { kind: 'error', text: `Usage: /context-graph ${USAGE}` }
            const own = views.find((v) => v.own)
            const m = meter.main
            const cached = m.cacheRead + m.cacheWrite
            const hitRate = m.input + cached > 0 ? Math.round((m.cacheRead / (m.input + cached)) * 100) : 0
            const session = agent.session
            // A new fork counts from its own first turn, not from the inherited ones (#55).
            const pending = collectSpan((seq) => session.eventAt(seq), rt.indexStart(agent, own?.meta)).userTurns
            const shared = views.filter((v) => !v.own).length
            const o = meter.other
            const last = rt.state(sid).lastBuild
            const lastLine = !last ? 'Last index: none since the app started'
              : last.status === 'built' ? `Last index: ${plural(last.nodes, 'topic')} (${last.newNodes} new) at ${last.at.slice(11, 16)} UTC`
                : `Last index ${last.status} at ${last.at.slice(11, 16)} UTC: ${last.reason}`
            return {
              kind: 'success',
              text: [
                `Memory ${memoryOn(own?.meta) ? 'on' : 'off'} · ${plural(Object.keys(own?.graph.nodes ?? {}).length, 'topic')} in this chat · ${sharedOn(own?.meta) ? 'shared' : 'private'} · ${plural(shared, 'shared chat')} · ${plural(pending, 'turn')} waiting to be indexed${updates.current() ? ' · update available' : ''}`,
                lastLine,
                `Version ${version}: ${updates.current() ?? 'no newer version found'}`,
                `Graph folder: ${rt.dirFor(agent)}`,
                'Counters below are since the app started:',
                `Builds: ${meter.builds}; builder tokens in/out: ${meter.builder.input + meter.builder.cacheRead + meter.builder.cacheWrite}/${meter.builder.output}`,
                `Injected blocks: ${meter.injected} (~${meter.injectedTokens} tokens); recalls: ${meter.recalls}`,
                `Conversation requests: ${m.requests}; input ${m.input} uncached + ${m.cacheRead} cache-read + ${m.cacheWrite} cache-write; cache-hit ${hitRate}%`,
                `Other model calls (compaction, titles): ${o.requests}; input ${o.input + o.cacheRead + o.cacheWrite}, output ${o.output}`
              ].join('\n')
            }
          }
        })
      }, 'context-graph command')
    }
  })
}
