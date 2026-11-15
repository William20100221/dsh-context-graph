/**
 * Per-plugin runtime shared by the host modules: configuration, per-chat state, and the helpers
 * that map a dsh agent to its memory folder, its meta and the views of its workspace.
 */

import { isAbsolute, join } from 'node:path'

import { sharedOn } from '../core/chat.js'
import { titleOf } from '../core/session.js'
import { chatDir, listChats, loadGraph, loadMeta, updateMeta } from '../store/chats.js'

export function createRuntime(cfg) {
  const sessions = new Map()

  const state = (sid) => {
    let st = sessions.get(sid)
    // retryAt: after a failed build, wait for this many new human turns before trying again.
    if (!st) { st = { building: false, announce: true, retryAt: 0 }; sessions.set(sid, st) }
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

  /**
   * What a chat's meta starts with. A fork starts its index after the inherited events, so its first
   * build does not re-index the parent's history (#16).
   */
  function initialMeta(agent) {
    const session = agent.session
    const now = new Date().toISOString()
    const forkSeq = forkSeqOf(session)
    const parent = session.header?.parentSession
    return {
      title: titleOf((seq) => session.eventAt(seq)),
      workspace: dirFor(agent),
      startedAt: now,
      lastActiveAt: now,
      turns: 0,
      ...(forkSeq ? { builtSeq: forkSeq - 1, forkSeq, ...(parent ? { parent: String(parent) } : {}) } : {})
    }
  }

  /** Locked read-modify-write of this agent's meta; creates it (with a chat number) on first use. */
  const updateFor = (agent, change) => updateMeta(dirFor(agent), sidOf(agent), change, () => initialMeta(agent))

  /** Set flags such as `memoryOff` or `private`, creating the chat's meta if needed. */
  const setFlags = (agent, flags) => updateFor(agent, (meta) => ({ ...meta, ...flags, lastActiveAt: new Date().toISOString() }))

  /** Own chat plus every shared chat of the workspace, graphs loaded in parallel. ponytail: re-read per turn; cached in cycle 2 (#33). */
  async function loadViews(agent) {
    const dir = dirFor(agent)
    const sid = sidOf(agent)
    const chats = (await listChats(dir)).filter((c) => c.sid === sid || sharedOn(c.meta))
    return Promise.all(chats.map(async ({ sid: other, meta }) => ({ sid: other, cid: meta.cid, meta, own: other === sid, graph: await loadGraph(chatDir(dir, other)) })))
  }

  function resolveTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
    const { provider, model } = agent.options ?? {}
    return provider && model ? { provider, model } : undefined
  }

  /**
   * The meta whose memory flag governs this agent: its own, or for a subagent the meta of the chat
   * that started it (a subagent works for that chat and has no memory folder of its own).
   */
  async function ownerMeta(agent) {
    if (!isSubagent(agent)) return metaFor(agent)
    const parent = agent.session.header?.parentSession
    return parent ? loadMeta(dirFor(agent), String(parent)) : undefined
  }

  return { cfg, state, sidOf, isSubagent, dirFor, metaFor, ownerMeta, updateFor, setFlags, loadViews, resolveTarget, forkSeqOf }
}
