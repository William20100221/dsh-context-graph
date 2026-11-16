/**
 * The `/context-graph` command. Nested plugin: it starts only where a human-command surface exists
 * (the Web and desktop apps), not in headless or ACP runs.
 *
 * No subcommand takes the agent's maintenance slot: that held the user's next message for the whole
 * indexing call and failed outright while a turn was running (#19). Builds read the session and
 * write only this plugin's files, and the per-chat `building` flag already prevents overlap.
 */

import { memoryOn, offPoint, sharedOn } from '../core/chat.js'
import { addCounters, savingsDetail, savingsLine } from '../core/ledger.js'
import { SCORE, matchAcross } from '../core/match.js'
import { renderMap } from '../core/render.js'
import { collectSpan } from '../core/session.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir, loadGraph } from '../store/chats.js'
import { chatEntry, workspaceTotal } from '../store/ledger.js'
import { USAGE, version } from './config.js'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Chats `/context-graph map` lists: about 40 KB at most, whatever the workspace's size (#82). */
const MAP_MAX_CHATS = 40

export function registerCommand(ctx, rt, { build, turnOn, onAtIdle, meter, updates }) {
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
              // Input typed while memory was off can still be on its way into the log: the rest of a
              // running turn, or messages the user typed that dsh holds in the agent's inbox until it
              // takes them (its own notices do not count). Memory then comes back when the chat is
              // idle, so all of it stays in the off stretch (review of #59).
              const busy = collectSpan((seq) => agent.session.eventAt(seq), -1, { completeOnly: true }).open || rt.pendingInput(agent)
              let meta
              if (busy && !memoryOn(await rt.metaFor(agent))) {
                // builder.js turns it on once the chat is idle. The turn may have ended while the
                // flag was written, with no turn end left to come: checked once more (third review).
                await rt.updateFor(agent, (m) => ({ ...m, onWhenIdle: true }))
                if (!(await onAtIdle(agent))) return { kind: 'success', text: 'Memory on when this turn ends · what was typed or queued while it was off stays private\n/context-graph stats shows when it is on.' }
                meta = await rt.metaFor(agent)
              } else {
                // The flag is the real effect; indexing continues in the background.
                meta = await turnOn(agent)
              }
              const shared = (await rt.loadViews(agent)).filter((v) => !v.own && Object.keys(v.graph.nodes).length > 0).length
              // Says whether other chats can use this one: a private chat stays private after on (#64).
              const reach = sharedOn(meta) ? 'other chats in this workspace can use it; /context-graph unshare keeps it private' : 'it stays private; /context-graph share lets other chats use it'
              return { kind: 'success', text: `Memory on · indexing this chat now · ${plural(shared, 'shared chat')} to draw on\nThis chat indexes itself every ${cfg.buildEveryTurns} turns and ${reach}. /context-graph stats shows progress; /context-graph off stops it.` }
            }
            if (sub === 'off') {
              // Where memory went off: from here until on, nothing is indexed or shared (#59). It holds
              // in this app run at once: the write can wait seconds for a file another program holds,
              // and a turn ending meanwhile must not be indexed past this point (fourth review).
              const end = collectSpan((seq) => agent.session.eventAt(seq)).lastSeq
              const st = rt.state(sid)
              // Counted: a second off while the first still waits keeps it held after the first settles.
              st.offFrom = Math.min(st.offFrom ?? end, end)
              st.offsPending = (st.offsPending ?? 0) + 1
              try {
                await rt.updateFor(agent, (m) => {
                  const { onWhenIdle, ...rest } = m
                  return { ...rest, memoryOff: true, offSeq: offPoint(m) ?? end, lastActiveAt: new Date().toISOString() }
                })
              } finally {
                if (--st.offsPending === 0) delete st.offFrom
              }
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
              // dsh keeps the card's whole text in the chat's session log, at every call: the newest
              // chats only (loadViews keeps listChats' order, newest first), the page has the rest (#82).
              const more = all.length > MAP_MAX_CHATS ? `\n… ${plural(all.length - MAP_MAX_CHATS, 'more chat')}; Plugins → Context Graph has the full map` : ''
              return { kind: 'success', text: `${plural(all.length, 'chat')} in ${rt.dirFor(agent)}\n${renderMap(all.slice(0, MAP_MAX_CHATS))}${more}` }
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
            // The chat's own flags, also when its topics could not be read (#62): never "on, shared" by default.
            const meta = own?.meta ?? (await rt.metaFor(agent))
            const m = meter.main
            const cached = m.cacheRead + m.cacheWrite
            const hitRate = m.input + cached > 0 ? Math.round((m.cacheRead / (m.input + cached)) * 100) : 0
            const session = agent.session
            // A new fork counts from its own first turn, not from the inherited ones (#55).
            // While memory is off nothing after the off point waits to be indexed: on makes it a gap (#59).
            const gaps = memoryOn(meta) ? meta?.gaps : [...(meta?.gaps ?? []), [offPoint(meta) + 1, Infinity]]
            const pending = collectSpan((seq) => session.eventAt(seq), rt.indexStart(agent, meta), { gaps }).userTurns
            const shared = views.filter((v) => !v.own).length
            const o = meter.other
            const last = rt.state(sid).lastBuild
            // Counters not yet written (this turn) are included, so the card is current. A ledger
            // that cannot be read now (a sync tool holding it) costs the savings lines, not the card.
            const pendingDelta = rt.state(sid).delta
            const ledger = await Promise.all([chatEntry(rt.dirFor(agent), sid), workspaceTotal(rt.dirFor(agent))]).catch(() => undefined)
            const here = ledger && addCounters(ledger[0].c, pendingDelta)
            const everywhere = ledger && addCounters(ledger[1], pendingDelta)
            const lastLine = !last ? 'Last index: none since the app started'
              : last.status === 'built' ? `Last index: ${plural(last.nodes, 'topic')} (${last.newNodes} new) at ${last.at.slice(11, 16)} UTC`
                : `Last index ${last.status} at ${last.at.slice(11, 16)} UTC: ${last.reason}`
            return {
              kind: 'success',
              text: [
                `Memory ${memoryOn(meta) ? 'on' : meta?.onWhenIdle === true ? 'off until this turn ends' : 'off'} · ${own || !meta ? `${plural(Object.keys(own?.graph.nodes ?? {}).length, 'topic')} in this chat` : 'topics of this chat could not be read'} · ${sharedOn(meta) ? 'shared' : 'private'} · ${plural(shared, 'shared chat')} · ${plural(pending, 'turn')} waiting to be indexed${updates.current() ? ' · update available' : ''}`,
                // What memory did for this chat and the workspace, with the estimate's terms (#35).
                ledger ? savingsLine(here, everywhere) : 'Savings: unavailable for now (the savings ledger could not be read)',
                lastLine,
                `Version ${version}: ${updates.current() ?? 'no newer version found'}`,
                `Graph folder: ${rt.dirFor(agent)}`,
                ...(ledger ? [savingsDetail(here)] : []),
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
