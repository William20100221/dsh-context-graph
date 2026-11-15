/**
 * One chat's topic graph and the operations on it. Pure.
 *
 * Graph: `{ version, nextId, nodes: { [id]: Node }, edges: [[from, to, relation], ...] }`.
 * Node: `{ label, gist, aliases, kind, src: [{ session, turn, at }], updated, hits }`.
 * Ids inside a graph are `n12`; across chats they are prefixed by the chat's number: `c3n12`.
 * The verbatim source text of a node lives outside the graph (see src/store); `src` is provenance.
 */

export const GRAPH_VERSION = 1
export const RELATIONS = ['uses', 'part-of', 'supersedes', 'caused-by', 'relates-to']
export const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']

export function emptyGraph() {
  return { version: GRAPH_VERSION, nextId: 1, nodes: {}, edges: [] }
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
    if (a === id && graph.nodes[b]) out.push({ id: b, relation, direction: 'out' })
    else if (b === id && graph.nodes[a]) out.push({ id: a, relation, direction: 'in' })
  }
  return out
}

/** Follow `supersedes` edges forward so a stale decision resolves to its replacement. */
export function resolveSuperseded(graph, id) {
  const seen = new Set()
  let current = id
  while (!seen.has(current)) {
    seen.add(current)
    const next = graph.edges.find(([from, to, rel]) => rel === 'supersedes' && to === current && graph.nodes[from])
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
 * Apply a builder delta. New nodes get ids; existing ones are updated in place (gist replaced,
 * aliases unioned, provenance appended). Edges may name new nodes by label. Returns the ids
 * touched with the message indices they cite, so the caller can store verbatim text.
 */
export function mergeDelta(graph, delta, { session, turn, now }) {
  const byLabel = new Map()
  const touched = []
  for (const n of delta.nodes) {
    let id = typeof n.id === 'string' && graph.nodes[n.id] ? n.id : undefined
    if (!id) {
      const existing = Object.entries(graph.nodes).find(([, x]) => x.label.toLowerCase() === n.label.trim().toLowerCase())
      id = existing ? existing[0] : `n${graph.nextId++}`
    }
    const prev = graph.nodes[id]
    const aliases = [...new Set([...(prev?.aliases ?? []), ...(Array.isArray(n.aliases) ? n.aliases : [])].map((a) => String(a).trim()).filter(Boolean))]
    graph.nodes[id] = {
      label: n.label.trim(),
      gist: String(n.gist ?? prev?.gist ?? '').trim().slice(0, 200),
      aliases,
      kind: KINDS.includes(n.kind) ? n.kind : prev?.kind ?? 'fact',
      src: [...(prev?.src ?? []), { session, turn, at: now }],
      updated: now,
      hits: prev?.hits ?? 0
    }
    byLabel.set(n.label.trim().toLowerCase(), id)
    if (typeof n.id === 'string') byLabel.set(n.id, id)
    touched.push({ id, msgs: n.msgs.filter((i) => Number.isInteger(i) && i >= 0), isNew: !prev })
  }
  const resolve = (ref) => graph.nodes[ref] ? ref : byLabel.get(ref) ?? byLabel.get(String(ref).toLowerCase())
  for (const [from, to, relation] of delta.edges) {
    const a = resolve(from)
    const b = resolve(to)
    if (!a || !b || a === b || !RELATIONS.includes(relation)) continue
    if (!graph.edges.some(([x, y, r]) => x === a && y === b && r === relation)) graph.edges.push([a, b, relation])
  }
  return touched
}
