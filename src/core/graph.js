/**
 * One chat's topic graph and the operations on it. Pure.
 *
 * Graph (version 2): `{ version, nextId, nodes: { [id]: Node }, edges: [[from, to, relation], ...] }`.
 * Node: `{ label, gist, aliases, kind, refs, at, updated }`:
 *   refs     seqs of the chat's messages the topic was drawn from; their text is stored once per
 *            chat in msgs.json (src/store), never copied into the topic
 *   at       when the topic was first written; `updated` when it last changed
 * Ids inside a graph are `n12`; across chats they are prefixed by the chat's number: `c3n12`.
 * Version 1 graphs (v0.1-v0.6) carried `src` provenance and per-topic source files; src/store
 * upgrades them on first load.
 */

import { sliceChars } from './text.js'

export const GRAPH_VERSION = 2
export const RELATIONS = ['uses', 'part-of', 'supersedes', 'caused-by', 'relates-to']
export const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']

/** Caps on what the builder model may write, so one oversized answer cannot bloat every later block (#15). */
export const LIMITS = { label: 80, gist: 200, alias: 40, aliases: 12, refs: 16 }

/** Own-key check: graph.nodes is a plain object, so `nodes.constructor` must not count as a topic (#15). */
export const has = (graph, id) => typeof id === 'string' && Object.hasOwn(graph.nodes, id)

const clip = (value, max) => sliceChars(String(value ?? '').replace(/\s+/g, ' ').trim(), max)
const labelKey = (label) => clip(label, LIMITS.label).toLowerCase()

export function emptyGraph() {
  return { version: GRAPH_VERSION, nextId: 1, nodes: {}, edges: [] }
}

/**
 * Repair what an older version or a hand edit can leave behind: a missing or stale `nextId` (which
 * would hand out an id already in use) and edges whose ends no longer exist.
 */
export function normalizeGraph(graph) {
  if (!graph || typeof graph.nodes !== 'object' || graph.nodes === null || Array.isArray(graph.nodes)) return emptyGraph()
  let max = 0
  for (const id of Object.keys(graph.nodes)) {
    const n = /^n(\d+)$/.exec(id)
    if (n) max = Math.max(max, Number(n[1]))
  }
  if (!Number.isInteger(graph.nextId) || graph.nextId <= max) graph.nextId = max + 1
  graph.edges = (Array.isArray(graph.edges) ? graph.edges : [])
    .filter((e) => Array.isArray(e) && e.length === 3 && has(graph, e[0]) && has(graph, e[1]) && RELATIONS.includes(e[2]))
  return graph
}

export function degree(graph, id) {
  let n = 0
  for (const [a, b] of graph.edges) if (a === id || b === id) n++
  return n
}

/** Edges touching `id`, oriented from its point of view. */
export function neighbors(graph, id) {
  const out = []
  for (const [a, b, relation] of graph.edges) {
    if (a === id && has(graph, b)) out.push({ id: b, relation, direction: 'out' })
    else if (b === id && has(graph, a)) out.push({ id: a, relation, direction: 'in' })
  }
  return out
}

/** Follow `supersedes` edges forward so a stale decision resolves to its replacement. */
export function resolveSuperseded(graph, id) {
  const seen = new Set()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const next = graph.edges.find(([from, to, rel]) => rel === 'supersedes' && to === current && has(graph, from))
    if (!next) return current
    current = next[0]
  }
  return current
}

/** God nodes: most connected first, newest first among equals. */
export function surfaceNodes(graph, max = 40) {
  return Object.keys(graph.nodes)
    .map((id) => ({ id, d: degree(graph, id), u: graph.nodes[id].updated ?? '' }))
    .sort((a, b) => b.d - a.d || b.u.localeCompare(a.u))
    .slice(0, max)
    .map(({ id }) => id)
}

/**
 * Apply a builder delta. A topic is matched to an existing one by its id (only real `nN` ids of this
 * graph) or by its label anywhere in the graph, else it gets the next id. The gist is replaced,
 * aliases keep the newest ones first, and `refs` gains the seqs of the messages it cites
 * (`refsOf(msgs)` maps the builder's message indices to seqs). Edges may name topics by id or by
 * label, including labels of topics written by earlier builds (#15).
 * @returns [{ id, isNew }] for every topic written.
 */
export function mergeDelta(graph, delta, { now, refsOf = () => [] }) {
  const byLabel = new Map()
  for (const [id, node] of Object.entries(graph.nodes)) byLabel.set(labelKey(node.label), id)
  // Only ids that existed before this answer are existing topics. An id the model invented to
  // name a new topic (to link it) may equal one allocated a moment ago for another new topic,
  // which would then be overwritten and given the wrong source (#61).
  const before = new Set(Object.keys(graph.nodes))
  const named = new Map()
  const touched = []
  for (const n of delta.nodes) {
    const label = clip(n.label, LIMITS.label)
    if (!label) continue
    const given = typeof n.id === 'string' && /^n\d+$/.test(n.id) && before.has(n.id) ? n.id : undefined
    const id = given ?? byLabel.get(labelKey(label)) ?? `n${graph.nextId++}`
    const prev = has(graph, id) ? graph.nodes[id] : undefined
    const aliases = [...new Set([...(Array.isArray(n.aliases) ? n.aliases : []), ...(prev?.aliases ?? [])].map((a) => clip(a, LIMITS.alias)).filter(Boolean))].slice(0, LIMITS.aliases)
    const refs = [...new Set([...(prev?.refs ?? []), ...refsOf(n.msgs ?? [])])].filter(Number.isInteger).sort((a, b) => a - b).slice(-LIMITS.refs)
    graph.nodes[id] = {
      label,
      gist: clip(n.gist ?? prev?.gist ?? '', LIMITS.gist),
      aliases,
      kind: KINDS.includes(n.kind) ? n.kind : prev?.kind ?? 'fact',
      refs,
      at: prev?.at ?? now,
      updated: now
    }
    byLabel.set(labelKey(label), id)
    if (typeof n.id === 'string' && n.id.trim()) named.set(n.id.trim(), id)
    touched.push({ id, isNew: !prev })
  }
  const resolve = (ref) => named.get(String(ref).trim()) ?? (has(graph, ref) ? ref : byLabel.get(labelKey(ref)))
  for (const [from, to, relation] of delta.edges) {
    const a = resolve(from)
    const b = resolve(to)
    if (!a || !b || a === b || !RELATIONS.includes(relation)) continue
    if (!graph.edges.some(([x, y, r]) => x === a && y === b && r === relation)) graph.edges.push([a, b, relation])
  }
  return touched
}
