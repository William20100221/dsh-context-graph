/**
 * The `recall` tool: the model follows an id from a [context-graph] block to the layer below it
 * (a day or chat -> its topics -> one topic's verbatim source; t7 -> a turn of this chat).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { neighbors } from '../core/graph.js'
import { renderChatIndex, renderRange } from '../core/render.js'
import { turnTranscript } from '../core/session.js'
import { parseTimeRange } from '../core/time.js'
import { chatDir, readSource, saveGraph } from '../store/chats.js'

export function registerRecall(ctx, rt, meter) {
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
      const views = await rt.loadViews(agent)
      if (/^\d{4}-\d{2}-\d{2}$/.test(id)) return ok(renderRange(views.filter((v) => !v.own), parseTimeRange(id)))
      const m = /^(?:c(\d+))?(n\d+)?$/.exec(id)
      if (!m || (!m[1] && !m[2])) return { status: 'unknown', text: `"${id}" is not an id. Use c3n12, c3, 2026-11-01 or t7, and only ids you were shown.` }
      const view = m[1] ? views.find((v) => String(v.cid) === m[1]) : views.find((v) => v.own)
      if (!view) return { status: 'unknown', text: m[1] ? `No chat c${m[1]} shared in this workspace.` : 'This chat has no indexed topics yet. Use a full id such as c3n12 from a [context-graph] block.' }
      if (!m[2]) return ok(renderChatIndex(view))
      const node = view.graph.nodes[m[2]]
      if (!node) return { status: 'unknown', text: `No topic ${id}. Only use ids shown in a [context-graph] block.` }
      node.hits = (node.hits ?? 0) + 1
      const chat = chatDir(rt.dirFor(agent), view.sid)
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
}
