/**
 * Upgrades of stored memory from older versions. Non-destructive by design (#12, #17 and the
 * cycle-1 review):
 *
 * v0.4-v0.6 chat folders hold a version-1 `graph.json` whose topics each own `src/<id>.md`: a list
 * of sections "## <at> session <sid> turn <turn>" with "**user** (seq N):" / "**assistant** (seq N):"
 * messages. The upgrade writes the version-2 graph to `topics.json` and the messages, each once, to
 * `msgs.json`. It never writes `graph.json` or `src/`: they stay as a read-only backup, so an older
 * copy of the plugin still running in another dsh process keeps its own file instead of wiping the
 * new one, and topics it adds later are merged in on the next load. The backup is removed once it has
 * been quiet for BACKUP_DAYS.
 *
 * Seqs are positions in one dsh session's log, so they only identify a message within that session.
 * Messages from any other session (a v0.1-v0.3 workspace graph covered many) get their own keys from
 * FOREIGN_BASE up, remembered in msgs.json under `k` so a second run reuses them.
 */

import { readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { GRAPH_VERSION, emptyGraph, has, normalizeGraph } from '../core/graph.js'
import { locked, readJson, writeJson } from './files.js'

export const TOPICS = 'topics.json'
export const BACKUP_DAYS = 7
const FOREIGN_BASE = 1_000_000_000

const MESSAGE = /^\*\*(user|assistant)\*\* \(seq (\d+)\):\n\n/gm
const SECTION = /^## \S+ session (\S+) turn \S+$/gm
const TRAILING_SECTION = /\n*## [^\n]* session [^\n]* turn [^\n]*\s*$/

/** The messages of one v1 source file: `[{ seq, role, text, session }]`, in file order, duplicates kept. */
export function parseSourceFile(text) {
  const s = String(text ?? '')
  const sections = [...s.matchAll(SECTION)].map((m) => ({ at: m.index, session: m[1] }))
  const marks = [...s.matchAll(MESSAGE)]
  return marks.map((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].index : s.length
    const body = s.slice(mark.index + mark[0].length, end).replace(TRAILING_SECTION, '').trim()
    const section = sections.filter((x) => x.at < mark.index).at(-1)
    return { seq: Number(mark[2]), role: mark[1], text: body, session: section?.session }
  })
}

const labelKey = (label) => String(label ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
const exists = (path) => stat(path).then(() => true, () => false)

/**
 * Bring a chat folder's version-1 data into topics.json and msgs.json. Merges, so it is safe to run
 * any number of times; returns true when it changed anything.
 * @param chat the chat folder; its name is the chat's own session id (`home`).
 */
export function upgradeChat(chat, { now = new Date() } = {}) {
  return locked(chat, async () => {
    const v1File = join(chat, 'graph.json')
    let v1Stat
    try { v1Stat = await stat(v1File) } catch { return false }
    const topics = await readJson(join(chat, TOPICS))
    if (topics?.version === GRAPH_VERSION && topics.upgradedFrom >= v1Stat.mtimeMs) {
      await dropOldBackup(chat, topics, v1Stat, now)
      return false
    }
    const v1 = await readJson(v1File)
    if (!v1 || v1.version !== 1 || typeof v1.nodes !== 'object' || v1.nodes === null) return false
    const home = chat.split(/[\\/]/).at(-1)
    const graph = topics?.version === GRAPH_VERSION ? normalizeGraph(topics) : emptyGraph()
    const store = (await readJson(join(chat, 'msgs.json'))) ?? { v: 1, m: {} }
    if (typeof store.m !== 'object' || store.m === null) store.m = {}
    if (typeof store.k !== 'object' || store.k === null) store.k = {}
    let foreign = Object.keys(store.m).reduce((max, key) => Math.max(max, Number(key) || 0), FOREIGN_BASE - 1)

    const keyOf = (m) => {
      const session = m.session ?? home
      if (session === home) return m.seq
      const name = `${session}:${m.seq}`
      if (!Object.hasOwn(store.k, name)) store.k[name] = ++foreign
      return store.k[name]
    }

    let files = []
    try { files = await readdir(join(chat, 'src')) } catch { /* no sources stored */ }
    const byLabel = new Map(Object.entries(graph.nodes).map(([id, node]) => [labelKey(node.label), id]))
    const ids = new Map()
    for (const [oldId, node] of Object.entries(v1.nodes)) {
      const refs = new Set()
      if (files.includes(`${oldId}.md`)) {
        for (const m of parseSourceFile(await readFile(join(chat, 'src', `${oldId}.md`), 'utf8'))) {
          const key = keyOf(m)
          // Migrated text is kept in full: for old workspaces it can be the only copy left.
          if (!Object.hasOwn(store.m, String(key))) store.m[String(key)] = { r: m.role, x: m.text }
          refs.add(key)
        }
      }
      const at = (Array.isArray(node.src) ? node.src : []).map((s) => s?.at).filter(Boolean).sort()[0] ?? node.updated
      const same = has(graph, oldId) && labelKey(graph.nodes[oldId].label) === labelKey(node.label) ? oldId : byLabel.get(labelKey(node.label))
      if (same) {
        const target = graph.nodes[same]
        target.refs = [...new Set([...(target.refs ?? []), ...refs])].sort((a, b) => a - b)
        if (String(node.updated ?? '') > String(target.updated ?? '')) Object.assign(target, { gist: String(node.gist ?? target.gist), updated: node.updated })
        ids.set(oldId, same)
        continue
      }
      const id = has(graph, oldId) ? `n${Math.max(graph.nextId, Number(v1.nextId) || 0)}` : oldId
      graph.nodes[id] = {
        label: String(node.label ?? ''),
        gist: String(node.gist ?? ''),
        aliases: (Array.isArray(node.aliases) ? node.aliases : []).map(String),
        kind: node.kind,
        refs: [...refs].sort((a, b) => a - b),
        at,
        updated: node.updated ?? at
      }
      normalizeGraph(graph)
      byLabel.set(labelKey(node.label), id)
      ids.set(oldId, id)
    }
    for (const [a, b, relation] of Array.isArray(v1.edges) ? v1.edges : []) {
      const from = ids.get(a)
      const to = ids.get(b)
      if (from && to && from !== to && !graph.edges.some(([x, y, r]) => x === from && y === to && r === relation)) graph.edges.push([from, to, relation])
    }
    normalizeGraph(graph)
    graph.nextId = Math.max(graph.nextId, Number(v1.nextId) || 0)
    graph.upgradedFrom = v1Stat.mtimeMs
    graph.upgradedAt ??= now.toISOString()
    // Text first, then the graph that points at it. graph.json and src/ are not touched.
    await writeJson(join(chat, 'msgs.json'), store)
    await writeJson(join(chat, TOPICS), graph)
    return true
  })
}

/**
 * Remove the version-1 backup once it has been quiet for BACKUP_DAYS: counted from the later of the
 * upgrade and the last write to it, so an older copy that wrote it on day 6 keeps it a week more (#56).
 */
async function dropOldBackup(chat, topics, v1Stat, now) {
  const since = Math.max(Date.parse(topics.upgradedAt ?? ''), Number(topics.upgradedFrom) || 0, v1Stat.mtimeMs)
  if (!Number.isFinite(since) || now - since < BACKUP_DAYS * 86400000) return
  if (v1Stat.mtimeMs > topics.upgradedFrom) return
  await rm(join(chat, 'graph.json'), { force: true })
  if (await exists(join(chat, 'src'))) await rm(join(chat, 'src'), { recursive: true, force: true })
}
