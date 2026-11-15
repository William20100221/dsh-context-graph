/**
 * Per-plugin runtime shared by the host modules: configuration, per-chat state, and the helpers
 * that map a dsh agent to its memory folder, flags and the views of its workspace.
 */

import { isAbsolute, join } from 'node:path'

import { sharedOn } from '../core/chat.js'
import { titleOf } from '../core/session.js'
import { chatDir, ensureMeta, listChats, loadGraph, loadMeta, saveMeta } from '../store/chats.js'

export function createRuntime(cfg) {
  const sessions = new Map()

  const state = (sid) => {
    let st = sessions.get(sid)
    // retryAt: after a failed build, wait for this many new human turns before trying again (#3).
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

  async function setFlags(agent, flags) {
    const dir = dirFor(agent)
    const session = agent.session
    const now = new Date().toISOString()
    const meta = await ensureMeta(dir, sidOf(agent), { title: titleOf((seq) => session.eventAt(seq)), workspace: dir, now })
    Object.assign(meta, flags, { lastActiveAt: now })
    await saveMeta(dir, sidOf(agent), meta)
    return meta
  }

  /** Own chat plus every shared chat of the workspace, graphs loaded. ponytail: re-read per turn; cache by mtime if a workspace grows large. */
  async function loadViews(agent) {
    const dir = dirFor(agent)
    const sid = sidOf(agent)
    const views = []
    for (const { sid: other, meta } of await listChats(dir)) {
      const own = other === sid
      if (!own && !sharedOn(meta)) continue
      views.push({ sid: other, cid: meta.cid, meta, own, graph: await loadGraph(chatDir(dir, other)) })
    }
    return views
  }

  function resolveTarget(agent) {
    if (cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
    const routed = agent.session.requestHeader()?.config
    if (routed?.provider && routed?.model) return { provider: routed.provider, model: routed.model }
    const { provider, model } = agent.options ?? {}
    return provider && model ? { provider, model } : undefined
  }

  return { cfg, state, sidOf, isSubagent, dirFor, metaFor, setFlags, loadViews, resolveTarget }
}
