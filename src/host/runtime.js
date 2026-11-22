/**
 * Per-plugin runtime shared by the host modules: configuration, per-chat state, and the helpers
 * that map a dsh agent to its memory folder, its meta and the views of its workspace.
 */

import { createHash } from 'node:crypto'
import { basename, isAbsolute, join } from 'node:path'

import { closedAt, memoryOn, offPoint, reachable, sharedOn, walkGaps } from '../core/chat.js'
import { emptyCounters, standIn } from '../core/ledger.js'
import { collectSpan, eventText, inGap, isPrompt, mergeGaps, promptText, shownContext, titleOf } from '../core/session.js'
import { chatDir, listChats, loadGraph, loadMeta, updateMeta } from '../store/chats.js'
import { chatEntry } from '../store/ledger.js'
import { capText, keepText, loadMessages } from '../store/messages.js'

const ownParts = new WeakMap()

/**
 * A chat's first prompt, kept only as a fingerprint: forks are matched to their ancestors by it,
 * and the text, which may have been typed while memory was off, is never stored (#59, review).
 */
const firstKey = (text) => (text === undefined ? undefined : createHash('sha1').update(text).digest('hex').slice(0, 16))

/**
 * What a chat's fingerprint is made from: its first typed prompt (titleOf), or while it has none,
 * its first prompt of any kind, such as a /goal chat's objective, so that its meta too says it is
 * no 0.4-0.7 meta (forkUnknown; review of #69).
 */
const keyPrompt = (eventAt) => titleOf(eventAt) ?? firstPromptOf(eventAt)

/** A chat's first prompt of any kind (typed, a /goal round's objective, a reminder). */
function firstPromptOf(eventAt) {
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isPrompt(event)) return promptText(event.data)
  }
}

/**
 * What an ancestor's fingerprint can be made from, as a fork's log shows it (keyPrompt, when the
 * ancestor's meta was written): its first typed prompt, or its first prompt of any kind for a chat
 * begun with /goal (second review of #52).
 */
const ancestorKeys = (eventAt) => [...new Set([titleOf(eventAt), firstPromptOf(eventAt)].filter((p) => p !== undefined))]

/** Whether a chat's first prompt is `first`; metas written before 0.9.0 keep it as text, or only a title. */
const startsWith = (meta, first) => first !== undefined && (meta?.firstKey !== undefined ? meta.firstKey === firstKey(first) : (meta?.firstPrompt ?? meta?.title) === first)
/**
 * Whether a chat may be an ancestor of `session`'s chat (same first prompt). Its keys are read once
 * per session: the inherited part never changes, and a pasted first prompt is long (third check).
 */
const keyCache = new WeakMap()
function ancestorOf(meta, session) {
  let keys = keyCache.get(session)
  if (!keys) keyCache.set(session, (keys = ancestorKeys((seq) => session.eventAt(seq)).map((text) => ({ text, key: firstKey(text) }))))
  return keys.some(({ text, key }) => (meta?.firstKey !== undefined ? meta.firstKey === key : (meta?.firstPrompt ?? meta?.title) === text))
}

/**
 * Whether a chat's meta cannot say if the chat is a fork: written by 0.4-0.7 and not since (#58).
 * From 0.8.0 on, the write that stores the first prompt (firstPrompt, then its fingerprint firstKey)
 * also stores forkSeq when the chat is a fork, so a meta with either says (#72).
 */
/** How long a failed listing of dsh's sessions, or a fork point not learned, waits to be tried again. */
const RETRY_MS = 30000

const forkUnknown = (meta) => !Number.isInteger(meta?.forkSeq) && meta?.firstKey === undefined && meta?.firstPrompt === undefined

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
   *   listed         the chat list was already sent in this run (see memory.js)
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

  /**
   * Input the user typed that dsh holds and has not logged yet (queued turns, steering, a late
   * answer to a question, #70); dsh's own notices do not count.
   */
  const pendingInput = (agent) => [...(agent.inbox?.nextTurn ?? []), ...(agent.inbox?.nextStep ?? [])].some((m) => m?.source?.kind === 'user' || m?.source?.kind === 'user-question-reply')

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
   * @param session a live session, or dsh's observation of one (the same two fields).
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
   * Whether `stored`, a message an ancestor stored at `seq`, is word for word this fork's own event
   * there. Compared with what the builder read at that seq (a goal round's objective, an approved
   * plan, the user's answers), not with the raw event, as that is what was stored (second review of
   * #52); a fork's inherited part never changes, so it is read once per session.
   */
  const readCache = new WeakMap()
  function sameText(stored, agent, forkSeq, seq) {
    const session = agent.session
    let read = readCache.get(session)
    if (!read) {
      read = new Map()
      for (const m of collectSpan((s) => session.eventAt(s)).messages) if (m.seq < forkSeq) read.set(m.seq, m.text)
      readCache.set(session, read)
    }
    // Stored whole since 0.13.0 (#93), cut to head and tail before.
    return [read.get(seq), eventText(session.eventAt(seq))].some((own) => own && (stored === own || stored === keepText(own) || stored === capText(own)))
  }

  /**
   * The meta of the chat a fork was made from, for the flags it carries over. dsh names the parent;
   * a named parent with no meta is an ordinary chat with no flags to carry over, unless dsh says it
   * is itself a fork (one never seen here), whose own parent is asked in turn (review of #60). Only
   * where no parent is named, or dsh cannot tell, a chat whose log this one starts with is looked
   * for (same first prompt, its stored messages word for word in this log); a candidate with
   * nothing stored to compare counts (fail closed).
   */
  async function parentMetaOf(agent, forkSeq) {
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
      if (chat.sid === sidOf(agent) || !ancestorOf(chat.meta, agent.session)) continue
      if (chat.meta.private !== true && chat.meta.memoryOff !== true) continue
      const stored = await loadMessages(chatDir(dir, chat.sid))
      const inherited = Object.keys(stored).map(Number).filter((seq) => seq < forkSeq)
      const same = inherited.every((seq) => sameText(stored[String(seq)].x, agent, forkSeq, seq))
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
   * first prompt is kept as `firstKey`, the fingerprint ancestors are matched by. Its ancestors'
   * off stretches become its first gaps: a goal set in one and resumed in the fork stays private
   * (#69, review); the fork never indexes or serves its inherited part anyway.
   */
  async function initialMeta(agent) {
    const session = agent.session
    const eventAt = (seq) => session.eventAt(seq)
    const now = new Date().toISOString()
    const forkSeq = forkSeqOf(session)
    const parent = session.header?.parentSession
    const first = titleOf(eventAt)
    const base = { title: first, firstKey: firstKey(first), startedAt: now, lastActiveAt: now }
    if (!forkSeq) return base
    const from = await parentMetaOf(agent, forkSeq)
    const point = forkSeq - 1
    const offAtFork = await offAt(dirFor(agent), from, point)
    const inherited = await offUpTo(dirFor(agent), from, point)
    return {
      ...base,
      title: offAtFork ? undefined : titleOf(eventAt, 60, forkSeq),
      builtSeq: point,
      forkSeq,
      ...(parent ? { parent: String(parent) } : {}),
      ...(from?.private === true ? { private: true } : {}),
      ...(inherited.length > 0 ? { gaps: inherited } : {}),
      offsInherited: true,
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
   * The off stretches up to `point` of the chat whose meta is `meta` and of its ancestors, as gaps,
   * by the same rules as offAt: its gaps; while it is off, all after where it went off; for a meta
   * whose stretches were lost, all up to where memory was turned on again (review of #69).
   */
  async function offUpTo(dir, meta, point) {
    const out = []
    for (let hops = 0; meta && point >= 0 && hops < 16; hops++) {
      for (const g of Array.isArray(meta.gaps) ? meta.gaps : []) if (Array.isArray(g) && g[0] <= point) out.push([g[0], Math.min(g[1], point)])
      if (!memoryOn(meta) && offPoint(meta) < point) out.push([offPoint(meta) + 1, point])
      if (meta.turnsClosed === true) out.push([0, Number.isInteger(meta.closedThrough) ? Math.min(meta.closedThrough, point) : point])
      if (!(Number.isInteger(meta.forkSeq) && meta.parent)) break
      point = Math.min(point, meta.forkSeq - 1)
      meta = await metaOf(dir, meta.parent)
    }
    return mergeGaps([], out)
  }

  /**
   * The off stretches another chat's log is judged by (turn recall): its gaps, and for a fork whose
   * meta came before forks took their ancestors' (offsInherited), theirs too, read-only (second
   * review of #69).
   */
  async function offsOf(dir, meta) {
    const own = walkGaps(meta)
    if (!Number.isInteger(meta?.forkSeq) || !meta.parent || meta.offsInherited === true) return own
    return mergeGaps(own, await offUpTo(dir, await metaOf(dir, meta.parent), meta.forkSeq - 1))
  }

  /**
   * A fork whose meta was written before forks took their ancestors' off stretches (up to 0.9.0, or
   * a meta repaired after damage) gets them once, before it is next indexed: a goal set in one of
   * them and resumed in the fork stays private there too (second review of #69). Fails closed: a
   * write that cannot land stops the build.
   */
  async function inheritOffs(agent, meta) {
    const forkSeq = forkSeqOf(agent.session)
    if (!meta || !forkSeq || meta.offsInherited === true) return meta
    const from = await parentMetaOf(agent, forkSeq)
    const inherited = await offUpTo(dirFor(agent), from, forkSeq - 1)
    const updated = await updateFor(agent, (m) => {
      const gaps = mergeGaps(Array.isArray(m.gaps) ? m.gaps : [], inherited)
      return { ...m, ...(gaps.length > 0 ? { gaps } : {}), offsInherited: true }
    })
    return withPending(sidOf(agent), updated)
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
   * A new meta passes here too: one of a chat with no typed prompt gets its fingerprint here.
   */
  function upToDate(agent, meta) {
    if (!meta) return meta
    const eventAt = (seq) => agent.session.eventAt(seq)
    // An absolute local path that nothing reads, in a folder users may sync: dropped (#78).
    const { workspace, ...current } = meta
    // Kept once made: forks are matched by either key a chat can have (ancestorKeys), and a fork
    // made before a /goal chat's first typed prompt has only its objective (second review of #69).
    if (current.firstKey !== undefined) return current
    const { firstPrompt, ...rest } = current
    const first = firstPrompt ?? keyPrompt(eventAt)
    return { ...rest, ...(first !== undefined ? { firstKey: firstKey(first) } : {}), ...(Number.isInteger(rest.forkSeq) ? { title: undefined } : {}) }
  }

  /**
   * Locked read-modify-write of this agent's meta; creates it (with a chat number) on first use. An
   * older meta is brought up to date before `change` sees it, so a title the change sets is kept.
   */
  const updateFor = (agent, change) => updateMeta(dirFor(agent), sidOf(agent), (meta) => withForkPoint(agent, change(upToDate(agent, withForkPoint(agent, meta)))), () => initialMeta(agent))

  /** Set flags such as `memoryOff` or `private`, creating the chat's meta if needed. */
  const setFlags = (agent, flags) => updateFor(agent, (meta) => ({ ...meta, ...flags, lastActiveAt: new Date().toISOString() }))

  /** Fork points learned from dsh for chats whose meta has none, for this app run (0: not a fork). */
  const forkPoints = new Map()
  const forkPointOf = (sid, meta) => Math.max(Number(meta?.forkSeq) || 0, forkPoints.get(sid) ?? 0)

  /**
   * Learn from dsh where a chat's own history starts when its meta cannot say (forkUnknown): one
   * read of its log, remembered for this app run. Resolves to whether the chat is a fork.
   */
  async function learnForkPoint(sid, meta, signal) {
    if (!forkUnknown(meta) || forkPoints.has(sid)) return false
    const observation = await observe(sid, signal)
    if (!observation) return false
    try {
      forkPoints.set(sid, forkSeqOf(observation) ?? 0)
    } finally {
      observation[Symbol.dispose]?.()
    }
    return forkPoints.get(sid) > 0
  }

  /**
   * Ids of the dsh sessions that are forks (header.isSeeded), from one listing of session headers
   * per app run (#58); undefined while dsh cannot list them here, null when the listing failed. A
   * listing that failed is not tried again in this run: every message would wait for it (review of #58).
   */
  let seeded
  function seededIds() {
    const query = sessionQuery()
    if (typeof query?.listSessions !== 'function') return undefined
    seeded ??= Promise.resolve()
      .then(() => query.listSessions())
      .then((records) => new Set(records.filter((r) => r?.header?.isSeeded === true).map((r) => String(r.header.id))))
      .catch(() => {
        // Tried again later (third check): until then the unsure chats stay held back.
        setTimeout(() => { seeded = undefined }, RETRY_MS).unref?.()
        return null
      })
    return seeded
  }
  const learning = new Map()

  /**
   * A fork indexed by 0.4-0.6 records no fork point, so its inherited topics would be matched as its
   * own until it is opened or recalled (#58). dsh's listing, which the first message of a run that
   * meets such a meta waits for, names the forks: one whose fork point is not known yet is left out
   * (fail closed) while it is learned in the background, once per run (a log that cannot be read
   * keeps it out); a chat dsh does not list as a fork is not one.
   */
  async function withoutUnknownForks(sid, chats) {
    const unsure = chats.filter((c) => c.sid !== sid && forkUnknown(c.meta) && !forkPoints.has(c.sid))
    const forks = unsure.length > 0 ? await seededIds() : undefined
    if (forks === undefined) return chats
    const waiting = new Set()
    for (const c of unsure) {
      // A listing that failed tells nothing: each such chat is learned from its own log and held
      // back meanwhile (fail closed, second review of #58).
      if (forks && !forks.has(c.sid)) { forkPoints.set(c.sid, 0); continue }
      waiting.add(c.sid)
      if (!learning.has(c.sid)) learning.set(c.sid, learnForkPoint(c.sid, c.meta).catch(() => false).then((learned) => {
        if (!forkPoints.has(c.sid)) setTimeout(() => learning.delete(c.sid), RETRY_MS).unref?.()
        return learned
      }))
    }
    return chats.filter((c) => !waiting.has(c.sid))
  }

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
    // A hidden chat's topics are not even read (#91): only `all` (the user's own map) lists it.
    const listed = (await listChats(dir)).filter((c) => all || c.sid === sid || reachable(c.meta))
    // The map (all) is the user's own view of every chat; nothing in it reaches a model.
    const chats = all ? listed : await withoutUnknownForks(sid, listed)
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
    const matches = (await listChats(dir)).filter((c) => String(c.meta.cid) === String(cid) && (c.sid === sid || reachable(c.meta)))
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
  return { cfg, state, tracked, seenDirs, noteDir, sidOf, isSubagent, pendingInput, dirFor, metaFor, inheritOffs, offsOf, ancestorOf, sameText, ownerMeta, forkedFrom, updateFor, setFlags, loadViews, viewOf, messagesOf, resolveTarget, forkSeqOf, indexStart, forkPoints, learnForkPoint, observe, creditUse, toolTokens: 0 }
}
