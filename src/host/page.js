/**
 * The plugin's page in Plugins (#35, #36): read-only routes for the client module.
 *   GET api/context-graph.overview                 workspaces with memory: chats, topics, savings
 *   GET api/context-graph.map?w=<key>              one workspace, laid out: chats, topics, links
 *   GET api/context-graph.topic?w=<key>&id=c3n12   one topic: gist, aliases, links, its sources
 *
 * Nested plugin with `inject: ['connection']`: it starts only where dsh's connection exists, and
 * dsh answers 403 to every principal but the owner on these routes. A workspace is named by a key
 * the overview handed out, never by a path in the request, so nothing outside the known memory
 * folders can be read. This is the owner's own view: private and memory-off chats are included
 * and marked. Nothing here writes, and nothing reaches a chat's context.
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { memoryOn, sharedOn } from '../core/chat.js'
import { has, neighbors } from '../core/graph.js'
import { layoutMap } from '../core/layout.js'
import { addCounters, balance, counters, emptyCounters } from '../core/ledger.js'
import { chatSummary } from '../core/render.js'
import { chatDir, listChats, loadGraph } from '../store/chats.js'
import { loadLedger } from '../store/ledger.js'
import { loadMessages, sourceOf } from '../store/messages.js'

const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
const keyOf = (dir) => createHash('sha1').update(dir).digest('hex').slice(0, 12)
const exists = (path) => stat(path).then(() => true, () => false)

export function registerPage(ctx, rt) {
  const { cfg } = rt

  /** Every memory folder this app knows: dsh's registered workspaces, and folders used in this run. */
  async function known() {
    const dirs = new Map()
    let workspaces = []
    try { workspaces = ctx.get('workspaceRegistry')?.list?.() ?? [] } catch { /* not mounted here */ }
    for (const w of workspaces) {
      if (typeof w?.path !== 'string') continue
      dirs.set(isAbsolute(cfg.dir) ? cfg.dir : join(w.path, cfg.dir), { title: w.title || w.path, path: w.path })
    }
    for (const [dir, info] of rt.seenDirs) if (!dirs.has(dir)) dirs.set(dir, info)
    const out = []
    for (const [dir, info] of dirs) if (await exists(join(dir, 'chats'))) out.push({ key: keyOf(dir), dir, ...info })
    return out
  }

  /** The ledger, or none for this answer while it cannot be read (a sync tool holding it): chats and the map still load. */
  const ledgerOf = (dir) => loadLedger(dir).catch((error) => {
    console.error(`context-graph: page reads no savings for ${dir} (${error?.code ?? error?.message})`)
    return { v: 1, chats: {}, unreadable: true }
  })

  async function chatsOf(dir) {
    const ledger = await ledgerOf(dir)
    // One chat whose topics cannot be read is left out, as in the chats themselves (#62).
    const read = async ({ sid, meta }) => ({ sid, cid: meta.cid, meta, graph: await loadGraph(chatDir(dir, sid)), c: counters(ledger.chats[sid]?.c), unreadable: ledger.unreadable === true })
    const chats = await Promise.all((await listChats(dir)).map((chat) => read(chat).catch((error) => {
      console.error(`context-graph: page skips chat ${chat.sid} (${error?.code ?? error?.message})`)
      return undefined
    })))
    return chats.filter(Boolean)
  }

  async function overview() {
    const out = []
    for (const w of await known()) {
      const chats = await chatsOf(w.dir).catch((error) => {
        console.error(`context-graph: page skips workspace ${w.title} (${error?.code ?? error?.message})`)
        return undefined
      })
      if (!chats) continue
      const ledger = await ledgerOf(w.dir)
      const total = Object.values(ledger.chats).reduce((sum, e) => addCounters(sum, counters(e?.c)), emptyCounters())
      out.push({
        key: w.key,
        title: w.title,
        path: w.path,
        chats: chats.length,
        indexed: chats.filter((c) => Object.keys(c.graph.nodes).length > 0).length,
        topics: chats.reduce((n, c) => n + Object.keys(c.graph.nodes).length, 0),
        used: total.used,
        // null while the ledger cannot be read: the page says so instead of showing zeros (third review).
        savings: ledger.unreadable ? null : balance(total)
      })
    }
    return { workspaces: out }
  }

  /**
   * The chats the map draws, which are the chats the topic route opens: each needs topics and its
   * own number (a meta that could not be read has none until it is written again, and a copied
   * folder can repeat one: the first chat with topics keeps it).
   */
  async function drawn(dir) {
    const seen = new Set()
    return (await chatsOf(dir)).filter((c) => Number.isInteger(c.cid) && Object.keys(c.graph.nodes).length > 0 && !seen.has(c.cid) && seen.add(c.cid))
  }

  async function map(w) {
    const chats = await drawn(w.dir)
    const layout = layoutMap(chats.map((c) => ({ cid: c.cid, lastActiveAt: c.meta.lastActiveAt, graph: c.graph })))
    const byCid = new Map(chats.map((c) => [c.cid, c]))
    return {
      key: w.key,
      title: w.title,
      width: layout.width,
      height: layout.height,
      chats: layout.chats.map((spot) => {
        const c = byCid.get(spot.cid)
        return {
          ...spot,
          title: c.meta.title ?? '',
          summary: chatSummary({ meta: c.meta, graph: c.graph }),
          shared: sharedOn(c.meta),
          memory: memoryOn(c.meta),
          startedAt: c.meta.startedAt,
          lastActiveAt: c.meta.lastActiveAt,
          savings: c.unreadable ? null : balance(c.c),
          used: c.c.used
        }
      }),
      // Labels only: gists and sources are fetched when a topic is opened.
      topics: layout.topics.map((t) => {
        const node = byCid.get(t.cid).graph.nodes[t.id]
        return [t.cid, t.id, node.label, node.kind, t.x, t.y, t.degree]
      }),
      edges: layout.edges
    }
  }

  async function topic(w, id) {
    const m = /^c(\d+)(n\d+)$/.exec(String(id ?? ''))
    if (!m) return undefined
    const chat = (await drawn(w.dir)).find((c) => String(c.cid) === m[1])
    if (!chat) return undefined
    const graph = chat.graph
    if (!has(graph, m[2])) return undefined
    const node = graph.nodes[m[2]]
    // Sources that cannot be read leave the topic itself readable (review).
    const stored = await loadMessages(chatDir(w.dir, chat.sid)).catch(() => ({}))
    const sources = sourceOf(stored, node).slice(-3).map((s) => ({ role: s.role, turn: s.turn, text: String(s.text ?? '').slice(0, 600) }))
    return {
      id,
      label: node.label,
      gist: node.gist,
      kind: node.kind,
      aliases: node.aliases ?? [],
      updated: node.updated,
      chat: { cid: chat.meta.cid, title: chat.meta.title ?? '', summary: chatSummary({ meta: chat.meta, graph }) },
      links: neighbors(graph, m[2]).map((l) => ({ id: `c${chat.meta.cid}${l.id}`, label: graph.nodes[l.id].label, relation: l.relation, direction: l.direction })),
      sources
    }
  }

  const route = (name, handle) => ({
    path: `/api/context-graph.${name}`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const query = new URL(request.url).searchParams
        if (name === 'overview') return json(await overview())
        const w = (await known()).find((k) => k.key === query.get('w'))
        if (!w) return json({ error: 'unknown workspace' }, 404)
        const value = await handle(w, query)
        return value === undefined ? json({ error: 'not found' }, 404) : json(value)
      } catch (error) {
        console.error('context-graph: page request failed (non-fatal)', error)
        return json({ error: 'failed' }, 500)
      }
    }
  })

  ctx.plugin({
    name: 'context-graph-page',
    inject: ['connection'],
    apply(pageCtx) {
      for (const r of [route('overview'), route('map', (w) => map(w)), route('topic', (w, q) => topic(w, q.get('id')))]) {
        pageCtx.effect(function* () {
          yield pageCtx.connection.fetch.register(r)
        }, `context-graph page: ${r.path}`)
      }
    }
  })

  return { overview, map, topic, known }
}
