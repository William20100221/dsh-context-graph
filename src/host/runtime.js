/**
 * Per-plugin runtime shared by the host modules: configuration, per-chat state, and the helpers
 * that map a dsh agent to its memory folder, its meta and the views of its workspace.
 */

import { createHash } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'

import { closedAt, memoryOn, offPoint, sharedOn } from '../core/chat.js'
import { emptyCounters, standIn } from '../core/ledger.js'
import { eventText, inGap, shownContext, titleOf } from '../core/session.js'
import { chatDir, listChats, loadGraph, loadMeta, updateMeta } from '../store/chats.js'
import { chatEntry } from '../store/ledger.js'
import { capText, loadMessages } from '../store/messages.js'

const ownParts = new WeakMap()

/**
 * A chat's first prompt, kept only as a fingerprint: forks are matched to their ancestors by it,
 * and the text, which may have been typed while memory was off, is never stored (#59, review).
 */
const firstKey = (text) => (text === undefined ? undefined : createHash('sha1').update(text).digest('hex').slice(0, 16))

/** Whether a chat's first prompt is `first`; metas written before 0.9.0 keep it as text, or only a title. */
const startsWith = (meta, first) => first !== undefined && (meta?.firstKey !== undefined ? meta.firstKey === firstKey(first) : (meta?.firstPrompt ?? meta?.title) === first)

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
export function createRuntime(cfg, { agentById = () => undefined, sessionQuery = () => undefined } = {}) {
  const sessions = new Map()

  /**
   * In-memory state of one chat for this app run:
   *   building       an indexing call is running
   *   announce       /context-graph on asked for the chat list again
   *   listed         the chat list was already considered in this run (see memory.js)
   *   retryAt        after a failed build, wait for this many unindexed human turns
   *   pin            after a failed build, the last seq the retry may read (#45)
   *   failedAnswers  unusable answers in a row for the pinned span
   * and for the savings estimate (#35):
   *   chat           a human turn or a build of this chat was seen in this run (meter.js charges it)
   *   delta          counters not yet written to the ledger
   *   inContext      tokens of the plugin's blocks and recall results still in the chat's context
   *   justSent       tokens added since the last request (counted as sent, not re-sent)
   *   pending        topics shown this turn, to check against the answer at turn end
   *   newlyUsed      topic ids used since the last write; usedIds: every id used (loaded once)
   *   newlyCredited  source messages counted since the last write; credited: all of them (loaded once)
   *   toCredit       topics judged used (or recalled) and not credited yet: kept until they are
   *   generation     the surface's replaceGeneration when inContext was last read from it
   */
  const state = (sid) => {
    let st = sessions.get(sid)
    if (!st) {
      st = { building: false, announce: false, listed: false, retryAt: 0, chat: false, delta: emptyCounters(), inContext: 0, justSent: 0, pending: [], newlyUsed: [], usedIds: undefined, newlyCredited: [], credited: undefined, toCredit: [], generation: undefined }
      sessions.set(sid, st)
    }
    return st
  }

  /** The state of a chat the savings estimate follows, or undefined. */
  const tracked = (sid) => {
    const st = sessions.get(sid)
    return st?.chat ? st : undefined
  }

  const sidOf = (agent) => String(agent.session.id)
  const isSubagent = (agent) => agent.options?.origin === 'subagent' || agent.session.header?.origin === 'subagent'

  /** Input the user typed that dsh holds and has not logged yet (queued turns, steering); dsh's own notices do not count. */
  const pendingInput = (agent) => [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some((m) => m?.source?.kind === 'user')

  function dirFor(agent) {
    const base = agent.options?.cwd ?? agent.session.header?.cwd ?? process.cwd()
    return isAbsolute(cfg.dir) ? cfg.dir : join(base, cfg.dir)
  }

  /**
   * This agent's meta. A fork seen for the first time gets its meta at once, so the flags it
   * inherits (private, memory off) hold from its first message, not only from its first index
   * (#60, review); other chats get a meta only when they are first indexed (#38).
   */
  async function metaFor(agent) {
    const meta = await metaOf(dirFor(agent), sidOf(agent))
    if (meta || isSubagent(agent) || !forkSeqOf(agent.session)) return meta
    return withPending(sidOf(agent), await updateFor(agent, (m) => m))
  }

  /**
   * A chat's meta as every memory check must see it: an `off` whose write still waits for the file
   * (command.js, up to ~5 s while another program holds it) already holds, for this chat and for
   * anything that asks about it (a fork made now, a subagent, a waiting `on`) (final review).
   */
  function withPending(sid, meta) {
    const from = sessions.get(sid)?.offFrom
    if (from === undefined) return meta
    return { ...(meta ?? {}), memoryOff: true, offSeq: memoryOn(meta) || !Number.isInteger(meta?.offSeq) ? from : meta.offSeq }
  }
  const metaOf = async (dir, sid) => withPending(String(sid), await loadMeta(dir, String(sid)))

  /** Memory folders used in this app run, for the plugin's page (with dsh's registered workspaces). */
  const seenDirs = new Map()
  function noteDir(agent) {
    const dir = dirFor(agent)
    if (seenDirs.has(dir)) return
    const path = agent.options?.cwd ?? agent.session.header?.cwd ?? process.cwd()
    seenDirs.set(dir, { title: basename(path) || path, path })
  }

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
   * Count a topic this chat used (#35): once per chat, standing in for its newest messages, each of
   * which also counts once per chat (review). `stored` is the topic's chat's msgs.json.
   */
  async function creditUse(agent, { id, node, cid, stored }) {
    const sid = sidOf(agent)
    const st = state(sid)
    if (!st.usedIds || !st.credited) {
      const entry = await chatEntry(dirFor(agent), sid)
      st.usedIds ??= new Set(entry.used)
      st.credited ??= new Set(entry.msgs)
    }
    if (st.usedIds.has(id)) return
    const { tokens, keys } = standIn(node, stored, cid, st.credited, cfg.sourceMaxMessages)
    st.delta.stoodIn += tokens
    st.delta.used++
    st.usedIds.add(id)
    st.newlyUsed.push(id)
    for (const key of keys) st.credited.add(key)
    st.newlyCredited.push(...keys)
  }

  /** dsh's observation of a chat's session (header, events), or undefined when it cannot be read here. */
  async function observe(sid, signal) {
    const query = sessionQuery()
    if (typeof query?.observeSession !== 'function') return undefined
    try {
      return await query.observeSession(sid, { ...(signal ? { signal } : {}), projectionMode: 'none' })
    } catch {
      return undefined
    }
  }

  /**
   * The meta of the chat a fork was made from, for the flags it carries over. dsh names the parent;
   * a named parent with no meta is an ordinary chat with no flags to carry over, unless dsh says it
   * is itself a fork (one never seen here), whose own parent is asked in turn (review of #60). Only
   * where no parent is named, or dsh cannot tell, a chat whose log this one starts with is looked
   * for (same first prompt, its stored messages word for word in this log); a candidate with
   * nothing stored to compare counts (fail closed).
   */
  async function parentMetaOf(agent, forkSeq, first) {
    const dir = dirFor(agent)
    let named = agent.session.header?.parentSession
    for (let hops = 0; named && hops < 16; hops++) {
      const meta = await metaOf(dir, named)
      if (meta) return meta
      const observation = await observe(String(named))
      if (!observation) break
      let header
      try { header = observation.header } finally { observation[Symbol.dispose]?.() }
      if (header?.isSeeded !== true) return undefined
      named = header.parentSession
    }
    const eventAt = (seq) => agent.session.eventAt(seq)
    for (const chat of await listChats(dir)) {
      if (chat.sid === sidOf(agent) || !startsWith(chat.meta, first)) continue
      if (chat.meta.private !== true && chat.meta.memoryOff !== true) continue
      const stored = await loadMessages(chatDir(dir, chat.sid))
      const inherited = Object.keys(stored).map(Number).filter((seq) => seq < forkSeq)
      const same = inherited.every((seq) => {
        const own = eventText(eventAt(seq))
        return own !== '' && (stored[String(seq)].x === own || stored[String(seq)].x === capText(own))
      })
      if (same) return chat.meta
    }
    return undefined
  }

  /**
   * What a chat's meta starts with. A fork starts its index after the inherited events, so its first
   * build does not re-index the parent's history (#16); it is titled from its own first prompt. A
   * fork of a private chat starts private (#60). A fork made where its parent's memory was off (the
   * parent was off then, or the fork point lies in one of its off stretches) starts memory-off and
   * has no title until `on`, its own prompts so far being typed while off (review). The inherited
   * first prompt is kept as `firstKey`, the fingerprint ancestors are matched by.
   */
  async function initialMeta(agent) {
    const session = agent.session
    const eventAt = (seq) => session.eventAt(seq)
    const now = new Date().toISOString()
    const forkSeq = forkSeqOf(session)
    const parent = session.header?.parentSession
    const first = titleOf(eventAt)
    const base = { title: first, firstKey: firstKey(first), workspace: dirFor(agent), startedAt: now, lastActiveAt: now }
    if (!forkSeq) return base
    const from = await parentMetaOf(agent, forkSeq, first)
    const point = forkSeq - 1
    const offAtFork = await offAt(dirFor(agent), from, point)
    return {
      ...base,
      title: offAtFork ? undefined : titleOf(eventAt, 60, forkSeq),
      builtSeq: point,
      forkSeq,
      ...(parent ? { parent: String(parent) } : {}),
      ...(from?.private === true ? { private: true } : {}),
      // Off from its first message: `on` turns all of the fork's own part so far into a gap (#59).
      ...(offAtFork ? { memoryOff: true } : {})
    }
  }

  /**
   * Whether memory was off at `point` of the chat whose meta is `meta`: the point lies in one of its
   * off stretches, or it is off now and the point is past where it went off. The log does not show
   * whether a fork made right where memory went off came before or after the `off`, and a meta
   * whose stretches were lost cannot tell up to where memory was turned on again (turnsClosed,
   * closedThrough): both count as off (fail closed). A point in the chat's own inherited part is
   * its parent's to answer, and so on up (third and fourth reviews).
   */
  async function offAt(dir, meta, point) {
    for (let hops = 0; meta && hops < 16; hops++) {
      if (closedAt(meta, point) || inGap(point, meta.gaps) || inGap(point + 1, meta.gaps) || (!memoryOn(meta) && point >= offPoint(meta))) return true
      if (!(Number.isInteger(meta.forkSeq) && point < meta.forkSeq && meta.parent)) return false
      meta = await metaOf(dir, meta.parent)
    }
    return false
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

  /**
   * A meta written before 0.9.0 (no fingerprint yet: 0.8.0 kept the first prompt as text, older
   * versions not at all) is brought up to date the next time it is written: the first prompt becomes
   * its fingerprint, and a fork drops the title it got then (often its parent's: dsh's "<title> (1)",
   * or the inherited first prompt), so its next index titles it from its own prompts (reviews).
   */
  function upToDate(agent, meta) {
    if (!meta || meta.firstKey !== undefined) return meta
    const { firstPrompt, ...rest } = meta
    const first = firstPrompt ?? titleOf((seq) => agent.session.eventAt(seq))
    return { ...rest, ...(first !== undefined ? { firstKey: firstKey(first) } : {}), ...(Number.isInteger(rest.forkSeq) ? { title: undefined } : {}) }
  }

  /**
   * Locked read-modify-write of this agent's meta; creates it (with a chat number) on first use. An
   * older meta is brought up to date before `change` sees it, so a title the change sets is kept.
   */
  const updateFor = (agent, change) => updateMeta(dirFor(agent), sidOf(agent), (meta) => withForkPoint(agent, change(upToDate(agent, withForkPoint(agent, meta)))), () => initialMeta(agent))

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
    // One chat whose topics cannot be read (a file locked by a sync tool, no permission) is
    // skipped, like a bad meta, instead of failing the whole workspace (#62).
    const views = await Promise.all(chats.map((c) => viewFrom(dir, sid, c).catch((error) => {
      console.error(`context-graph: skipping chat ${c.sid} (${error?.code ?? error?.message})`)
      return undefined
    })))
    return views.filter(Boolean)
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
    // A copy whose topics cannot be read is left out, as in loadViews (fourth review).
    const views = (await Promise.all(matches.map((c) => viewFrom(dir, sid, c).catch(() => undefined)))).filter(Boolean)
    const others = views.filter((v) => !v.own)
    // Another chat holds the number but cannot be read: never this chat in its place (final review).
    if (others.length === 0 && matches.some((c) => c.sid !== sid)) return undefined
    // A repeated number (a copied folder) goes to the chat with topics, as on the page (page.js drawn).
    return others.find((v) => Object.keys(v.graph.nodes).length > 0) ?? others[0] ?? views[0]
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
      if (parentIsChat) return metaOf(dirFor(agent), parentId)
      // An unknown parent ends the walk below: no header, no parentSession, closed.
      header = parentHeader
    }
    return CLOSED
  }

  /**
   * For a subagent forked from a chat (dsh seeds it with the chat's log, blocks included, and gives
   * it the chat's tools): the state of the chat that started it, which its requests are charged to,
   * and the block tokens it carries, read again after a compaction (review of #35). Else undefined.
   */
  const carried = new WeakMap()
  function forkedFrom(sid) {
    const agent = agentById(sid)
    if (!agent || !isSubagent(agent) || !forkSeqOf(agent.session)) return undefined
    let header = agent.session.header
    for (let hops = 0; hops < 32 && header?.parentSession; hops++) {
      const parentId = String(header.parentSession)
      const parentHeader = agentById(parentId)?.session?.header
      if (parentHeader?.origin === 'subagent') { header = parentHeader; continue }
      const st = tracked(parentId)
      if (!st) return undefined
      const generation = agent.session.surface?.replaceGeneration
      let seen = carried.get(agent)
      if (!seen || seen.generation !== generation) carried.set(agent, (seen = { generation, tokens: shownContext(agent.session.surface.nodes, (seq) => agent.session.eventAt(seq)).tokens }))
      return { st, tokens: seen.tokens }
    }
    return undefined
  }

  // toolTokens: what the recall tool's definition costs per request (set by recall.js).
  return { cfg, state, tracked, seenDirs, noteDir, sidOf, isSubagent, pendingInput, dirFor, metaFor, ownerMeta, forkedFrom, updateFor, setFlags, loadViews, viewOf, messagesOf, resolveTarget, forkSeqOf, indexStart, forkPoints, startsWith, observe, creditUse, toolTokens: 0 }
}
