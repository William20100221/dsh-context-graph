/**
 * Where to draw the memory map (#36). Pure and deterministic, computed by the host so the browser
 * module only draws: the same memory always gives the same picture.
 *
 * Chats are circles packed in rows, newest first; a chat's topics sit on rings inside its circle,
 * the most connected nearest the centre. Units are SVG user units; the client scales the view.
 */

import { degree } from './graph.js'

const RING = 16
const GAP = 24
const WIDTH = 1400

/** Positions of `count` topics on rings of growing size: ring k holds 6k topics at radius RING*k. */
function rings(count) {
  const out = []
  for (let ring = 1; out.length < count; ring++) {
    const capacity = 6 * ring
    const here = Math.min(capacity, count - out.length)
    for (let i = 0; i < here; i++) {
      const angle = (2 * Math.PI * i) / here + ring * 0.6
      out.push({ x: Math.cos(angle) * RING * ring, y: Math.sin(angle) * RING * ring })
    }
  }
  return out
}

const ringCount = (count) => {
  let n = 0
  for (let ring = 1, held = 0; held < count; ring++) { held += 6 * ring; n = ring }
  return n
}

/**
 * @param chats [{ cid, lastActiveAt, graph }] the chats to draw
 * @param maxTopics a chat's most connected topics drawn at most; the rest are counted
 * @returns { width, height, chats: [{ cid, x, y, r, shown, total }],
 *            topics: [{ cid, id, x, y, degree }], edges: [[cid, from, to, relation]] }
 */
export function layoutMap(chats, { maxTopics = 120 } = {}) {
  const ordered = [...chats].sort((a, b) => String(b.lastActiveAt ?? '').localeCompare(String(a.lastActiveAt ?? '')))
  const out = { width: WIDTH, height: 0, chats: [], topics: [], edges: [] }
  let x = 0
  let y = 0
  let rowHeight = 0
  for (const chat of ordered) {
    const ids = Object.keys(chat.graph.nodes)
      .map((id) => ({ id, d: degree(chat.graph, id), u: String(chat.graph.nodes[id].updated ?? '') }))
      .sort((a, b) => b.d - a.d || b.u.localeCompare(a.u))
    const shown = ids.slice(0, maxTopics)
    const r = RING * (ringCount(shown.length) + 1)
    if (x > 0 && x + 2 * r > WIDTH) { x = 0; y += rowHeight + GAP; rowHeight = 0 }
    const cx = x + r
    const cy = y + r + 18
    out.chats.push({ cid: chat.cid, x: Math.round(cx), y: Math.round(cy), r, shown: shown.length, total: ids.length })
    const spots = rings(shown.length)
    const drawn = new Set()
    shown.forEach(({ id, d }, i) => {
      out.topics.push({ cid: chat.cid, id, x: Math.round(cx + spots[i].x), y: Math.round(cy + spots[i].y), degree: d })
      drawn.add(id)
    })
    for (const [from, to, relation] of chat.graph.edges) if (drawn.has(from) && drawn.has(to)) out.edges.push([chat.cid, from, to, relation])
    x += 2 * r + GAP
    rowHeight = Math.max(rowHeight, 2 * r + 18)
  }
  out.height = y + rowHeight
  return out
}
