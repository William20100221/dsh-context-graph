/**
 * The memory as the tree the Memory tree page draws (#86): a workspace's chats, newest first, each
 * with its topics grouped by kind. Pure and deterministic; the page lays it out itself, because the
 * layout changes as branches open and close.
 */

import { degree } from './graph.js'

/** Kinds in the order a chat lists them, so each kind's colour forms one band. */
export const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']

const kindRank = (kind) => {
  const i = KINDS.indexOf(kind)
  return i < 0 ? KINDS.length : i
}

/**
 * @param chats [{ cid, lastActiveAt, graph }] the chats to draw
 * @param maxTopics a chat's topics listed at most (the most connected); the rest are counted
 * @returns [{ cid, total, topics: [[id, label, kind]], links: [[from, to]] }], newest chat first
 */
export function memoryTree(chats, { maxTopics = 120 } = {}) {
  const newest = [...chats].sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))
  return newest.map((chat) => {
    const { nodes, edges } = chat.graph
    const ids = Object.keys(nodes)
      .map((id) => ({ id, d: degree(chat.graph, id), u: String(nodes[id].updated ?? '') }))
      .sort((a, b) => b.d - a.d || b.u.localeCompare(a.u))
      .slice(0, maxTopics)
      .sort((a, b) => kindRank(nodes[a.id].kind) - kindRank(nodes[b.id].kind) || b.d - a.d || b.u.localeCompare(a.u))
    const kept = new Set(ids.map((t) => t.id))
    return {
      cid: chat.cid,
      total: Object.keys(nodes).length,
      topics: ids.map(({ id }) => [id, nodes[id].label, nodes[id].kind]),
      links: edges.filter(([from, to]) => kept.has(from) && kept.has(to)).map(([from, to]) => [from, to])
    }
  })
}
