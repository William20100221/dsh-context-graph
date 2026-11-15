/**
 * Per-plugin runtime shared by the host modules: configuration, per-chat state, and the helpers
 * that map a dsh agent to its memory folder, its meta and the views of its workspace.
 */

import { isAbsolute, join } from 'node:path'

import { sharedOn } from '../core/chat.js'
import { titleOf } from '../core/session.js'
import { chatDir, listChats, loadGraph, loadMeta, updateMeta } from '../store/chats.js'
import { loadMessages } from '../store/messages.js'

const ownParts = new WeakMap()

/**
 * A fork's graph without the topics it inherited: topics whose every cited message lies before the
 * fork point are dropped, mixed ones keep only their own sources. Memoized per loaded graph, so the
 * same objects come back while the file is unchanged (the token memo in match.js relies on it).
 */
function ownPart(graph, forkSeq) {
  if (!forkSeq) return graph
  const cached = ownParts.get(graph)
  if (cached?.forkSeq === forkSeq) return cached.graph
  const nodes = {}
  let changed = false
  for (const [id, node] of Object.entries(graph.nodes)) {
    const refs = node.refs ?? []
    const own = refs.filter((seq) => seq >= forkSeq)
    if (refs.length > 0 && own.length === 0) { changed = true; continue }
    if (own.length !== refs.length) { changed = true; nodes[id] = { ...node, refs: own } } else nodes[id] = node
  }
  const result = changed ? { ...graph, nodes, edges: graph.edges.filter(([a, b]) => Object.hasOwn(nodes, a) && Object.hasOwn(nodes, b)) } : graph
  ownParts.set(graph, { forkSeq, graph: result })
  return result
}

/** What an unresolvable owner reads as: nothing shared, memory off. */
const CLOSED = Object.freeze({ private: true, memoryOff: true })

/**
 * @param agentById the live agent of a session id (dsh's `agents` service), used to find the chat
 *   behind a nested subagent.
 */
export function createRuntime(cfg, { agentById = () => undefined } = {}) {
  const sessions = new Map()

  /**
   * In-memory state of one chat for this app run:
   *   building       an indexing call is running
   *   announce       /context-graph on asked for the chat list again
   *   listed         the chat list was already considered in this run (see memory.js)
   *   retryAt        after a failed build, wait for this many unindexed human turns
   *   pin            after a failed build, the last seq the retry may read (#45)
   *   failedAnswers  unusable answers in a row for the pinned span
   */
  const state = (sid) => {
    let st = sessions.get(sid)
    if (!st) { st = { building: false, announce: false, listed: false, retryAt: 0 }; sessions.set(sid, st) }
    return st
  }

  const sidOf = (agent) => String(agent.session.id)
  const isSubagent = (agent) => agent.options?.origin === 'subagent' || agent.session.header?.origin === 'subagent'

  function dirFor(agent) {
    const base = agent.options?.cwd ?? agent.session.header?.cwd ?? process.cwd()
    return isAbsolute(cfg.dir) ? cfg.dir : join(base, cfg.dir)
  }

  const metaFor = (agent) => loadMeta(dirFor(agent), sidOf(agent))

  /**
   * Where a forked chat's own history starts. dsh copies the parent's events into the fork with the
   * same seqs and reports how many in `inheritedEventCount`; `header.isSeeded` marks the copy. The
   * parent's id (`header.parentSession`) is optional: some dsh builds omit it for ordinary forks.
   * @returns the first seq that is the fork's own, or undefined for a chat that is not a fork.
   */
  function forkSeqOf(session) {
    const inherited = session.inheritedEventCount
    return session.header?.isSeeded === true && Number.isInteger(inherited) && inherited > 0 ? inherited : undefined
  }

  /** The last seq already indexed: from the meta, else just before a fork's own history (#16, #55). */
  const indexStart = (agent, meta) => (Number.isInteger(meta?.builtSeq) ? meta.builtSeq : (forkSeqOf(agent.session) ?? 0) - 1)

  /**
   * What a chat's meta starts with. A fork starts its index after the inherited events, so its first
   * build does not re-index the parent's history (#16).
   */
  function initialMeta(agent) {
    const session = agent.session
    const now = new Date().toISOString()
    const forkSeq = forkSeqOf(session)
    const parent = session.header?.parentSession
    const first = titleOf((seq) => session.eventAt(seq))
    return {
      title: first,
      firstPrompt: first,
      workspace: dirFor(agent),
      startedAt: now,
      lastActiveAt: now,
      ...(forkSeq ? { builtSeq: forkSeq - 1, forkSeq, ...(parent ? { parent: String(parent) } : {}) } : {})
    }
  }

  /**
   * A fork whose meta was written before forks had a fork point (v0.4-v0.6) gets one the next time
   * it is written, from dsh's own count, so its inherited topics can be held back (second review).
   */
  function withForkPoint(agent, meta) {
    const forkSeq = forkSeqOf(agent.session)
    if (!meta || !forkSeq || Number.isInteger(meta.forkSeq)) return meta
    const parent = agent.session.header?.parentSession
    return { ...meta, forkSeq, ...(parent && !meta.parent ? { parent: String(parent) } : {}) }
  }

  /** Locked read-modify-write of this agent's meta; creates it (with a chat number) on first use. */
  const updateFor = (agent, change) => updateMeta(dirFor(agent), sidOf(agent), (meta) => withForkPoint(agent, change(meta)), () => initialMeta(agent))

  /** Set flags such as `memoryOff` or `private`, creating the chat's meta if needed. */
  const setFlags = (agent, flags) => updateFor(agent, (meta) => ({ ...meta, ...flags, lastActiveAt: new Date().toISOString() }))

  /** Fork points learned from dsh for chats whose meta has none (see recall.js), for this app run. */
  const forkPoints = new Map()
  const forkPointOf = (sid, meta) => Math.max(Number(meta?.forkSeq) || 0, forkPoints.get(sid) ?? 0)

  const viewFrom = (dir, sid, { sid: other, meta }) => loadGraph(chatDir(dir, other)).then((graph) => ({
    sid: other,
    cid: meta.cid,
    meta,
    own: other === sid,
    // Another chat that is a fork shows only what is its own: topics drawn only from inherited
    // messages (which only v0.4-v0.6 indexed) belong to the chat it was forked from.
    graph: other === sid ? graph : ownPart(graph, forkPointOf(other, meta))
  }))

  /**
   * Own chat plus every shared chat of the workspace (`all`: private ones too, for the map). Reads
   * go through the stat-keyed cache, so an unchanged workspace costs a few stats per message (#33).
   */
  async function loadViews(agent, { all = false } = {}) {
    const dir = dirFor(agent)
    const sid = sidOf(agent)
    const chats = (await listChats(dir)).filter((c) => all || c.sid === sid || sharedOn(c.meta))
    return Promise.all(chats.map((c) => viewFrom(dir, sid, c)))
  }

  /**
   * One chat by its number, loading only that chat's topics (#49); undefined unless it is this chat
   * or shared. Without a number: this chat (its meta may not exist yet).
   */
  async function viewOf(agent, cid) {
    const dir = dirFor(agent)
    const sid = sidOf(agent)
    if (cid === undefined) {
      const meta = (await metaFor(agent)) ?? {}
      return { sid, cid: meta.cid, meta, own: true, graph: await loadGraph(chatDir(dir, sid)) }
    }
    // Visible chats only: a private chat that shares a number with a shared one (possible in data
    // from before v0.7) must not hide it. Blocks never name this chat, so another chat comes first.
    const matches = (await listChats(dir)).filter((c) => String(c.meta.cid) === String(cid) && (c.sid === sid || sharedOn(c.meta)))
    const chat = matches.find((c) => c.sid !== sid) ?? matches[0]
    return chat ? viewFrom(dir, sid, chat) : undefined
  }

  /** The stored source messages of a view's chat (read-only, cached). */
  const messagesOf = (agent, view) => loadMessages(chatDir(dirFor(agent), view.sid))

  function resolveTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
    const { provider, model } = agent.options ?? {}
    return provider && model ? { provider, model } : undefined
  }

  /**
   * The meta whose memory flag governs this agent: its own, or for a subagent the meta of the chat
   * that started the task (a subagent works for that chat and has no memory folder of its own).
   * dsh records only a subagent's direct parent, which for a nested subagent is another subagent,
   * so the chain is walked up through the live agents. A chain that cannot be followed fails
   * closed: memory off for the chat that started it must hold at every depth.
   */
  async function ownerMeta(agent) {
    if (!isSubagent(agent)) return metaFor(agent)
    let header = agent.session.header
    for (let hops = 0; hops < 32; hops++) {
      const parentId = header?.parentSession
      if (!parentId) return CLOSED
      const parentHeader = agentById(String(parentId))?.session?.header
      const parentIsChat = parentHeader ? parentHeader.origin !== 'subagent' : (Number(header.delegationDepth) || 1) <= 1
      if (parentIsChat) return loadMeta(dirFor(agent), String(parentId))
      // An unknown parent ends the walk below: no header, no parentSession, closed.
      header = parentHeader
    }
    return CLOSED
  }

  return { cfg, state, sidOf, isSubagent, dirFor, metaFor, ownerMeta, updateFor, setFlags, loadViews, viewOf, messagesOf, resolveTarget, forkSeqOf, indexStart, forkPoints }
}
