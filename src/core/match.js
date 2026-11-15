/**
 * Lexical matching of a prompt against topic graphs, within one chat and across the chats of a
 * workspace. Pure.
 */

import { degree, resolveSuperseded } from './graph.js'
import { chatInRange, inRange } from './time.js'
import { tokenize } from './text.js'

function nodeTokens(node) {
  return {
    strong: new Set(tokenize([node.label, ...(node.aliases ?? [])].join(' '))),
    weak: new Set(tokenize(node.gist ?? ''))
  }
}

/**
 * Lexical match of a user message against one graph: labels/aliases weigh 2, gists 1, plus a small
 * boost for well-connected nodes. Only nodes with a strong (label/alias) hit count.
 * @returns [{ id, node, score, via }] best first, at most `max`.
 */
export function matchNodes(graph, query, { max = 5 } = {}) {
  const q = tokenize(query)
  if (q.length === 0) return []
  const scored = []
  for (const [rawId, node] of Object.entries(graph.nodes)) {
    const { strong, weak } = nodeTokens(node)
    let strongHits = 0
    let weakHits = 0
    for (const t of q) {
      if (strong.has(t)) strongHits++
      else if (weak.has(t)) weakHits++
    }
    if (strongHits === 0) continue
    const score = strongHits * 2 + weakHits + 0.25 * Math.log1p(degree(graph, rawId))
    const id = resolveSuperseded(graph, rawId)
    scored.push({ id, node: graph.nodes[id], score, via: id === rawId ? undefined : rawId })
  }
  scored.sort((a, b) => b.score - a.score || (b.node.updated ?? '').localeCompare(a.node.updated ?? ''))
  const seen = new Set()
  return scored.filter(({ id }) => !seen.has(id) && seen.add(id)).slice(0, max)
}

/** A view is `{ sid, cid, meta, graph, own }`; `own` is the chat the request belongs to. */
export const globalId = (view, id) => `c${view.cid}${id}`

/**
 * Match across every view except the own chat (its text is still in context). With a time range,
 * try chats active in that range first, then topics updated in it, then everything.
 * @returns { hits: [{ id, node, score, via, view }], slice }
 */
export function matchAcross(views, query, { max = 5, range, skip } = {}) {
  const others = views.filter((v) => !v.own)
  const run = (vs, keep = () => true) => vs
    .flatMap((view) => matchNodes(view.graph, query, { max: max + (skip?.size ?? 0) }).map((h) => ({ ...h, id: globalId(view, h.id), via: h.via && globalId(view, h.via), view })))
    .filter((h) => keep(h) && !skip?.has(h.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
  if (range) {
    const byChat = run(others.filter((v) => chatInRange(v.meta, range)))
    if (byChat.length > 0) return { hits: byChat, slice: `${range.label} (by chat)` }
    const byTopic = run(others, (h) => inRange(h.node.updated, range))
    if (byTopic.length > 0) return { hits: byTopic, slice: `${range.label} (by topic)` }
  }
  return { hits: run(others), slice: undefined }
}
