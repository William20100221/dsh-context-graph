/**
 * Read-only routes for the client module: the savings on the plugin's page in Plugins (#35) and
 * the Memory tree page (#85, #86).
 *   GET api/context-graph.overview                 workspaces with memory: chats, topics, savings
 *   GET api/context-graph.tree?w=<key>             one workspace as a tree: chats, their topics, links (#86)
 *   GET api/context-graph.topic?w=<key>&id=c3n12   one topic: gist, aliases, links, its sources
 *   GET api/context-graph.chat?sid=<session>       one chat's memory number and flags, for its header (#92)
 *   GET api/context-graph.turn?w=<key>&cid=3&t=7   one whole turn, from the chat's stored messages (#93)
 *   POST api/context-graph.hide?w=<key>&cid=3&on=1  hide a chat from memory, or (on=0) use it again (#91)
 *   POST api/context-graph.forget?w=<key>&cid=3     delete the memory of a chat dsh archived or deleted
 *   POST api/context-graph.forget?sid=<session>     the same, for the session menu's Archive & forget (#92)
 *
 * Nested plugin with `inject: ['connection']`: it starts only where dsh's connection exists, and
 * dsh answers 403 to every principal but the owner on these routes. A workspace is named by a key
 * the overview handed out, never by a path in the request, so nothing outside the known memory
 * folders can be read; a chat is named by its number in that workspace or by its dsh session, and
 * the sid used on disk is always one read from the chats folder. This is the owner's own view:
 * private, hidden and memory-off chats are included and marked. The GETs write nothing; the two
 * POSTs change one chat's memory and ask for a header no other web page can send (`x-context-graph`),
 * and `forget` refuses a chat whose session dsh still has outside its archive. Nothing here reaches
 * a chat's context.
 */

import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { hiddenOn, memoryOn, sharedOn } from '../core/chat.js'
import { has, neighbors } from '../core/graph.js'
import { memoryTree } from '../core/tree.js'
import { addCounters, balance, counters, emptyCounters } from '../core/ledger.js'
import { chatSummary } from '../core/render.js'
import { chatDir, listChats, loadGraph, removeChat, updateMeta } from '../store/chats.js'
import { loadLedger } from '../store/ledger.js'
import { loadMessages, oldTurns, sourceOf, storeComplete } from '../store/messages.js'

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

  /** The ledger, or none for this answer while it cannot be read (a sync tool holding it): chats and the tree still load. */
  const ledgerOf = (dir) => loadLedger(dir).catch((error) => {
    console.error(`context-graph: page reads no savings for ${dir} (${error?.code ?? error?.message})`)
    return { v: 1, chats: {}, unreadable: true }
  })

  /** `savings: false`: the topic route needs no ledger, which is one file per chat (#83). */
  async function chatsOf(dir, { savings = true } = {}) {
    const ledger = savings ? await ledgerOf(dir) : { v: 1, chats: {} }
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
   * The chats the tree draws, which are the chats the topic route opens: each needs topics and its
   * own number (a meta that could not be read has none until it is written again, and a copied
   * folder can repeat one: the first chat with topics keeps it).
   */
  async function drawn(dir, options) {
    const seen = new Set()
    return (await chatsOf(dir, options)).filter((c) => Number.isInteger(c.cid) && Object.keys(c.graph.nodes).length > 0 && !seen.has(c.cid) && seen.add(c.cid))
  }

  /**
   * What dsh says of each session: `listed`, the sessions it still has (null while it cannot list
   * them here, so nothing is taken for deleted), and `archived`, the ones in its archive.
   */
  async function sessionStates() {
    let listed = null
    try {
      const query = ctx.get('sessionQuery')
      if (typeof query?.listSessions === 'function') listed = new Set((await query.listSessions()).map((r) => String(r?.header?.id)))
    } catch (error) {
      console.error('context-graph: dsh could not list its sessions; no chat counts as deleted for now', error?.message ?? error)
    }
    let archived = new Set()
    try { archived = new Set((ctx.get('workspaceRegistry')?.archivedSessionIds ?? []).map(String)) } catch { /* not mounted here */ }
    return { listed, archived }
  }

  /** Whether dsh archived or deleted a chat's session: only then may its memory be deleted (#91). */
  const removable = (states, sid) => states.archived.has(sid) || (states.listed !== null && !states.listed.has(sid))

  async function tree(w) {
    const [chats, states] = await Promise.all([drawn(w.dir), sessionStates()])
    const byCid = new Map(chats.map((c) => [c.cid, c]))
    return {
      key: w.key,
      title: w.title,
      // Labels only: gists and sources are fetched when a topic is opened.
      chats: memoryTree(chats.map((c) => ({ cid: c.cid, lastActiveAt: c.meta.lastActiveAt, graph: c.graph }))).map((branch) => {
        const c = byCid.get(branch.cid)
        return {
          ...branch,
          title: c.meta.title ?? '',
          summary: chatSummary({ meta: c.meta, graph: c.graph }),
          shared: sharedOn(c.meta),
          memory: memoryOn(c.meta),
          hidden: hiddenOn(c.meta),
          // The chat's dsh session: archived, deleted (gone), or neither (#91).
          archived: states.archived.has(c.sid),
          gone: states.listed !== null && !states.listed.has(c.sid),
          startedAt: c.meta.startedAt,
          lastActiveAt: c.meta.lastActiveAt,
          savings: c.unreadable ? null : balance(c.c),
          used: c.c.used
        }
      })
    }
  }

  async function topic(w, id) {
    const m = /^c(\d+)(n\d+)$/.exec(String(id ?? ''))
    if (!m) return undefined
    const chat = (await drawn(w.dir, { savings: false })).find((c) => String(c.cid) === m[1])
    if (!chat) return undefined
    const graph = chat.graph
    if (!has(graph, m[2])) return undefined
    const node = graph.nodes[m[2]]
    // Sources that cannot be read leave the topic itself readable (review).
    const stored = await loadMessages(chatDir(w.dir, chat.sid)).catch(() => ({}))
    // Turn numbers stored by 0.9.0 counted typed prompts, not dsh's turns: not shown until a
    // recall or a build of that chat converts them; the page never writes (second review of #71).
    const named = !(await oldTurns(chatDir(w.dir, chat.sid)))
    // Whole (#93): the page shows a long one folded; what the model is sent keeps its own budget.
    const sources = sourceOf(stored, node).slice(-3).map((s) => ({ role: s.role, turn: named ? s.turn : undefined, text: String(s.text ?? '') }))
    return {
      id,
      label: node.label,
      gist: node.gist,
      kind: node.kind,
      aliases: node.aliases ?? [],
      updated: node.updated,
      chat: { cid: chat.meta.cid, title: chat.meta.title ?? '', summary: chatSummary({ meta: chat.meta, graph }) },
      links: neighbors(graph, m[2]).map((l) => ({ id: `c${chat.meta.cid}${l.id}`, label: graph.nodes[l.id].label, relation: l.relation, direction: l.direction })),
      sources,
      // Whether the chat keeps its whole indexed span, so a source's turn can be read in full (#93).
      complete: await storeComplete(chatDir(w.dir, chat.sid))
    }
  }

  /**
   * One whole turn of a chat (#93), from its stored messages: what indexing read, kept whole, never
   * what was typed while memory was off. Also for a chat whose dsh session was deleted.
   */
  async function turn(w, query) {
    const chat = await chatByCid(w, query.get('cid'))
    const n = Number(query.get('t'))
    if (!chat || !Number.isInteger(n) || n < 1) return undefined
    const folder = chatDir(w.dir, chat.sid)
    // Turn ids stored by 0.9.0 are not dsh's until relabelled (second review of #71).
    if (await oldTurns(folder)) return undefined
    const stored = await loadMessages(folder).catch(() => ({}))
    const messages = Object.entries(stored)
      .filter(([, m]) => m?.t === n)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([, m]) => ({ role: m.r, text: String(m.x ?? '') }))
    if (messages.length === 0) return undefined
    return { cid: chat.cid, turn: n, messages, complete: await storeComplete(folder) }
  }

  /** The workspace a request names by its key; undefined for any other value. */
  const workspaceOf = async (query) => (await known()).find((k) => k.key === query.get('w'))

  /** A chat of `w` by its number: the one the tree draws for it (drawn), so both name the same chat. */
  async function chatByCid(w, cid) {
    return (await drawn(w.dir, { savings: false })).find((c) => String(c.cid) === String(cid ?? ''))
  }

  /** A chat by its dsh session, in whichever known workspace holds it: { w, chat } or undefined. */
  async function chatBySid(sid) {
    if (!sid) return undefined
    for (const w of await known()) {
      const chat = (await listChats(w.dir)).find((c) => c.sid === sid)
      if (chat) return { w, chat }
    }
    return undefined
  }

  /** The header chip of a chat (#92): its number and flags, or 404 while it has no memory yet. */
  async function chatInfo(query) {
    const found = await chatBySid(query.get('sid'))
    if (!found || !Number.isInteger(found.chat.meta.cid)) return undefined
    const { w, chat } = found
    const graph = await loadGraph(chatDir(w.dir, chat.sid)).catch(() => undefined)
    return { w: w.key, cid: chat.meta.cid, topics: graph ? Object.keys(graph.nodes).length : null, shared: sharedOn(chat.meta), memory: memoryOn(chat.meta), hidden: hiddenOn(chat.meta) }
  }

  /** Hide a chat from memory, or use it again (#91). */
  async function hide(query) {
    const w = await workspaceOf(query)
    const chat = w && (await chatByCid(w, query.get('cid')))
    if (!chat) return undefined
    const on = query.get('on') !== '0'
    const meta = await updateMeta(w.dir, chat.sid, (m) => {
      const { hidden, ...rest } = m
      return on ? { ...rest, hidden: true } : rest
    })
    return { cid: meta.cid, hidden: hiddenOn(meta) }
  }

  /**
   * Delete a chat's memory for good (#91, #92): only when dsh archived or deleted its session, which
   * the host checks itself; the page asks the user to confirm first.
   */
  async function forget(query) {
    let w
    let sid
    if (query.get('sid')) {
      const found = await chatBySid(query.get('sid'))
      if (!found) return undefined
      w = found.w
      sid = found.chat.sid
    } else {
      w = await workspaceOf(query)
      sid = w && (await chatByCid(w, query.get('cid')))?.sid
    }
    if (!w || !sid) return undefined
    if (!removable(await sessionStates(), sid)) return { status: 409, error: 'this chat still exists: hide it, or archive it first' }
    await removeChat(w.dir, sid)
    return { forgotten: true }
  }

  const route = (name, handle, { write = false } = {}) => ({
    path: `/api/context-graph.${name}`,
    methods: [write ? 'POST' : 'GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        // A plain cross-site form or image cannot send this header: changes come from this page only.
        if (write && request.headers.get('x-context-graph') !== '1') return json({ error: 'missing x-context-graph header' }, 403)
        const query = new URL(request.url).searchParams
        const value = await handle(query)
        if (value === undefined) return json({ error: 'not found' }, 404)
        if (value?.status) return json({ error: value.error }, value.status)
        return json(value)
      } catch (error) {
        console.error('context-graph: page request failed (non-fatal)', error)
        return json({ error: 'failed' }, 500)
      }
    }
  })

  /** A read route that names a workspace: 404 for a key the overview did not hand out. */
  const inWorkspace = (handle) => async (query) => {
    const w = await workspaceOf(query)
    if (!w) return { status: 404, error: 'unknown workspace' }
    return handle(w, query)
  }

  ctx.plugin({
    name: 'context-graph-page',
    inject: ['connection'],
    apply(pageCtx) {
      const routes = [
        route('overview', () => overview()),
        route('tree', inWorkspace((w) => tree(w))),
        route('topic', inWorkspace((w, q) => topic(w, q.get('id')))),
        route('chat', chatInfo),
        route('turn', inWorkspace((w, q) => turn(w, q))),
        route('hide', hide, { write: true }),
        route('forget', forget, { write: true })
      ]
      for (const r of routes) {
        pageCtx.effect(function* () {
          yield pageCtx.connection.fetch.register(r)
        }, `context-graph page: ${r.path}`)
      }
    }
  })

  return { overview, tree, topic, turn, known, hide, forget, chatInfo }
}
