/**
 * context-graph core. Pure: no I/O, no dsh imports, so `node --test` covers it without a harness.
 *
 * One graph per chat: `{ version, nextId, nodes: { [id]: Node }, edges: [[from, to, relation], ...] }`.
 * A Node is `{ label, gist, aliases, kind, src: [{ session, turn, at }], updated, hits }`.
 * Ids inside a graph are `n12`; across chats they are prefixed by the chat's number: `c3n12`.
 * The verbatim source text of a node lives outside the graph (see store.js); `src` is provenance.
 */

export const GRAPH_VERSION = 1
export const SOURCE_KIND = 'context-graph'
export const RELATIONS = ['uses', 'part-of', 'supersedes', 'caused-by', 'relates-to']
export const KINDS = ['decision', 'fact', 'task', 'artifact', 'open-question']

const STOPWORDS = new Set((
  'a an the and or but if then so of to in on at for with by from as is are was were be been being ' +
  'do does did done have has had can could should would will shall may might must not no yes ' +
  'i me my we our you your he she it its they them this that these those there here what which who ' +
  'how when where why also just like get got make made use used using want need let please ok okay ' +
  'now new one two about into over under again more most some any all each other than too very ' +
  '的 了 是 在 我 你 他 她 它 们 这 那 个 和 与 或 吗 呢 吧 啊 把 被 给 让 就 都 也 还 很 不 没 有 要 会 能 可以 什么 怎么 这个 那个 一下 一个'
).split(/\s+/))

export function emptyGraph() {
  return { version: GRAPH_VERSION, nextId: 1, nodes: {}, edges: [] }
}

/** Rough token estimate for budget caps; CJK is close to one token per char. */
export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

/**
 * Lowercased word tokens plus CJK bigrams, stopwords removed.
 * "clear_conversation tool" -> ["clear_conversation", "clear", "conversation", "tool"]
 * "清除上下文" -> ["清除", "除上", "上下", "下文"]
 */
export function tokenize(text) {
  const out = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const run of lower.match(/[぀-ヿ㐀-鿿가-힯]+/g) ?? []) {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.add(run); continue }
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) out.add(bigram)
    }
  }
  for (const word of lower.replace(/[぀-ヿ㐀-鿿가-힯]+/g, ' ').match(/[a-z0-9_./-]{2,}/g) ?? []) {
    if (STOPWORDS.has(word)) continue
    out.add(word)
    if (/[_./-]/.test(word)) for (const part of word.split(/[_./-]+/)) if (part.length >= 2 && !STOPWORDS.has(part)) out.add(part)
  }
  return [...out]
}

function nodeTokens(node) {
  return {
    strong: new Set(tokenize([node.label, ...(node.aliases ?? [])].join(' '))),
    weak: new Set(tokenize(node.gist ?? ''))
  }
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

/** God nodes: most connected first, newest first among equals. */
export function surfaceNodes(graph, max = 40) {
  return Object.keys(graph.nodes)
    .map((id) => ({ id, d: degree(graph, id), u: graph.nodes[id].updated ?? '' }))
    .sort((a, b) => b.d - a.d || b.u.localeCompare(a.u))
    .slice(0, max)
    .map(({ id }) => id)
}

// ---------- time: the first filter when a message names a day ----------

const DAY = 86400000
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

/**
 * A from/to range (to exclusive) when the text names a time: yesterday, today, N days ago, last/this
 * week or month, 2026-11-01, 11月1日, 昨天, 上周 ... `undefined` otherwise. No model call.
 */
export function parseTimeRange(text, now = new Date()) {
  const s = String(text ?? '').toLowerCase()
  const today = dayStart(now)
  const days = (offset, label, span = 1) => ({ from: new Date(+today + offset * DAY), to: new Date(+today + (offset + span) * DAY), label })
  let m
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3])
    return { from: d, to: new Date(+d + DAY), label: m[0] }
  }
  if ((m = /(\d{1,2})月(\d{1,2})[日号]/.exec(s))) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2])
    if (d > now) d.setFullYear(d.getFullYear() - 1)
    return { from: d, to: new Date(+d + DAY), label: m[0] }
  }
  if (/day before yesterday|前天/.test(s)) return days(-2, 'the day before yesterday')
  if (/\byesterday\b|昨天|昨日/.test(s)) return days(-1, 'yesterday')
  if (/\btoday\b|this morning|今天|今早|今日/.test(s)) return days(0, 'today')
  if ((m = /\b(\d+) days? ago\b/.exec(s)) || (m = /(\d+)天前/.exec(s))) return days(-Number(m[1]), m[0])
  const monday = new Date(+today - ((today.getDay() + 6) % 7) * DAY)
  if (/\blast week\b|上周|上星期|上个星期/.test(s)) return { from: new Date(+monday - 7 * DAY), to: monday, label: 'last week' }
  if (/\bthis week\b|本周|这周|这星期|这个星期/.test(s)) return { from: monday, to: new Date(+monday + 7 * DAY), label: 'this week' }
  if (/\blast month\b|上个月|上月/.test(s)) {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1), label: 'last month' }
  }
  if (/\bthis month\b|本月|这个月/.test(s)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: 'this month' }
  }
  return undefined
}

const inRange = (iso, range) => Boolean(iso) && new Date(iso) >= range.from && new Date(iso) < range.to
/** A chat overlaps the range when it was active at any point inside it. */
export const chatInRange = (meta, range) => Boolean(meta?.startedAt) && new Date(meta.startedAt) < range.to && new Date(meta.lastActiveAt ?? meta.startedAt) >= range.from

// ---------- views: one chat's graph seen from another chat ----------

/** A view is `{ sid, cid, meta, graph, own }`; `own` is the chat the request belongs to. */
export const globalId = (view, id) => `c${view.cid}${id}`

/**
 * Match across every view except the own chat (its text is still in context). With a time range,
 * try chats active in that range first, then topics updated in it, then everything.
 * @returns { hits: [{ id, node, score, via, view }], slice }
 */
export function matchAcross(views, query, { max = 5, range } = {}) {
  const others = views.filter((v) => !v.own)
  const run = (vs, keep = () => true) => vs
    .flatMap((view) => matchNodes(view.graph, query, { max }).map((h) => ({ ...h, id: globalId(view, h.id), via: h.via && globalId(view, h.via), view })))
    .filter(keep)
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

/** Local calendar day (YYYY-MM-DD) of a timestamp, the same day recall("YYYY-MM-DD") and "today" search. */
export function day(iso) {
  const d = new Date(iso ?? NaN)
  if (Number.isNaN(+d)) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const topicLine = (id, node) => `- ${id} ${node.label}: ${node.gist}${node.updated ? ` (${day(node.updated)})` : ''}`
const chatLine = (view) => `- c${view.cid} ${day(view.meta.lastActiveAt ?? view.meta.startedAt)} ${view.meta.title ?? '(untitled)'} (${Object.keys(view.graph.nodes).length} topics${view.own ? ', this chat' : ''})`
const newestFirst = (views) => [...views].sort((a, b) => String(b.meta.lastActiveAt ?? '').localeCompare(String(a.meta.lastActiveAt ?? '')))

/** The per-turn block appended to the user's message. `inline` carries one node's verbatim text when it is short. */
export function renderHits(hits, { inline, slice } = {}) {
  if (hits.length === 0) return ''
  const lines = [`[${SOURCE_KIND}] Related past context${slice ? ` from ${slice}` : ''}. Call recall(id) for the verbatim source.`]
  for (const { id, node, via } of hits) lines.push(topicLine(id, node) + (via ? ` [replaces ${via}]` : ''))
  if (inline) lines.push('', `Verbatim source of ${inline.id}:`, inline.text.trim())
  return lines.join('\n')
}

/** Sent once after memory is switched on: the chats this chat can draw on, newest first. */
export function renderChats(views, { max = 20 } = {}) {
  const shared = newestFirst(views.filter((v) => !v.own))
  if (shared.length === 0) return ''
  const lines = [
    `[${SOURCE_KIND}] Memory is on. Earlier chats in this workspace, newest first. ` +
    'Call recall("c3") for a chat\'s topics, recall("2026-11-01") for everything from a day, recall("c3n12") for one topic\'s exact text. ' +
    'Treat this as background; do not restate it.'
  ]
  for (const view of shared.slice(0, max)) lines.push(chatLine(view))
  if (shared.length > max) lines.push(`- ... ${shared.length - max} older chats; name a day to see them`)
  return lines.join('\n')
}

/** One chat's topics, most connected first. */
export function renderChatIndex(view, { max = 40 } = {}) {
  const lines = [`# c${view.cid} ${view.meta.title ?? '(untitled)'} (${day(view.meta.startedAt)} → ${day(view.meta.lastActiveAt)})`]
  const ids = surfaceNodes(view.graph, max)
  if (ids.length === 0) lines.push('(no topics indexed yet)')
  for (const id of ids) lines.push(topicLine(globalId(view, id), view.graph.nodes[id]))
  return lines.join('\n')
}

/** Everything that happened in a time range: each chat active then, with its topics from that range first. */
export function renderRange(views, range, { maxChats = 10, maxTopics = 10 } = {}) {
  const chats = newestFirst(views.filter((v) => chatInRange(v.meta, range)))
  if (chats.length === 0) return `[${SOURCE_KIND}] No chats from ${range.label}.`
  const lines = [`[${SOURCE_KIND}] Chats from ${range.label}:`]
  for (const view of chats.slice(0, maxChats)) {
    lines.push(chatLine(view))
    const ids = Object.keys(view.graph.nodes).sort((a, b) => Number(inRange(view.graph.nodes[b].updated, range)) - Number(inRange(view.graph.nodes[a].updated, range)))
    for (const id of ids.slice(0, maxTopics)) lines.push('  ' + topicLine(globalId(view, id), view.graph.nodes[id]))
  }
  return lines.join('\n')
}

/** Memory is on in every chat unless `/context-graph off` was run there; the Plugins page switch turns the whole plugin off. */
export const memoryOn = (meta) => meta?.memoryOff !== true

/** The /context-graph map: workspace → chats (newest first) → topics. */
export function renderMap(views, { maxTopics = 8 } = {}) {
  if (views.length === 0) return 'No chats indexed in this workspace yet. Chats index themselves every few turns; /context-graph build indexes this one now.'
  const lines = []
  for (const view of newestFirst(views)) {
    const meta = view.meta
    const flags = [view.own ? 'this chat' : undefined, memoryOn(meta) ? 'memory on' : 'memory off', meta.shared ? 'shared' : 'private'].filter(Boolean).join(', ')
    lines.push(`c${view.cid} ${day(meta.startedAt)} ${meta.title ?? '(untitled)'} · ${Object.keys(view.graph.nodes).length} topics · ${flags}`)
    for (const id of surfaceNodes(view.graph, maxTopics)) lines.push('  ' + topicLine(globalId(view, id), view.graph.nodes[id]))
  }
  return lines.join('\n')
}

// ---------- builder ----------

/** `[m0 user] ...` transcript the builder reads; each message capped so one huge paste cannot eat the call. */
export function transcriptForBuilder(messages, maxChars = 2000) {
  return messages.map((m, i) => {
    const text = m.text.length > maxChars ? `${m.text.slice(0, maxChars)}\n…[${m.text.length - maxChars} more chars]` : m.text
    return `[m${i} ${m.role}]\n${text}`
  }).join('\n\n')
}

export function builderInstruction(graph) {
  const existing = Object.entries(graph.nodes).map(([id, n]) => `${id}: ${n.label}`).join('\n')
  return [
    'You are indexing the conversation span above into a memory graph for later sessions. Output ONE JSON object and nothing else.',
    '',
    'Shape: {"nodes":[{"id":"n12"|null,"label":"...","gist":"...","aliases":["..."],"kind":"decision|fact|task|artifact|open-question","msgs":[0,2]}],"edges":[["n12","n3","uses"]]}',
    '',
    'Rules:',
    '- One node per decision, fact, task, artifact (file, tool, repo) or open question worth remembering later. Skip chit-chat and anything already obvious from the labels below unless it changed.',
    '- label: at most 6 words, the name someone would search for. gist: one line under 120 characters, what is true now and why.',
    '- aliases: other words a future message might use for this node, including the other language if the conversation mixes languages. Be precise; matching is by word overlap.',
    '- msgs: indices of the [mN] messages the node is drawn from. Required, never empty.',
    '- id: reuse an existing id below when the node is the same thing (update its gist); null for a new node.',
    `- edges: [from, to, relation] with relation in ${RELATIONS.join(', ')}. For a changed decision add [new, old, "supersedes"]. Use existing ids where possible; refer to new nodes by their label in place of an id.`,
    '- Keep file paths, commands, identifiers and numbers exact.',
    '',
    existing ? `Existing nodes:\n${existing}` : 'Existing nodes: (none)'
  ].join('\n')
}

/** Complete top-level `{...}` objects inside the array that opens at `open`; an unfinished last one is dropped. */
function objectsInArray(text, open) {
  const out = []
  let depth = 0
  let start = -1
  let inString = false
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{' || ch === '[') { if (depth++ === 0 && ch === '{') start = i }
    else if (ch === '}' || ch === ']') {
      if (depth === 0) break
      if (--depth === 0 && ch === '}' && start >= 0) { out.push(text.slice(start, i + 1)); start = -1 }
    }
  }
  return out
}

/**
 * Tolerant extraction of the builder's JSON. Handles code fences, prose around it, `<think>` blocks,
 * trailing commas, and output cut off mid-way (every complete node object is kept).
 * `undefined` when there is no `"nodes"` array at all.
 */
export function parseBuilderOutput(text) {
  const clean = String(text ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
  const at = clean.search(/"nodes"\s*:\s*\[/)
  if (at < 0) return undefined
  const nodes = []
  for (const raw of objectsInArray(clean, clean.indexOf('[', at))) {
    try { nodes.push(JSON.parse(raw.replace(/,\s*([}\]])/g, '$1'))) } catch { /* skip a malformed node */ }
  }
  const edgesAt = clean.search(/"edges"\s*:/)
  const edges = edgesAt < 0 ? [] : [...clean.slice(edgesAt).matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => [m[1], m[2], m[3]])
  return {
    nodes: nodes.filter((n) => n && typeof n.label === 'string' && n.label.trim() && Array.isArray(n.msgs) && n.msgs.length > 0),
    edges
  }
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

// ---------- session events ----------

const isHuman = (event) => event?.type === 'user/message' && event.data?.source?.kind === 'user'

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

/**
 * Pull the human/assistant exchange out of dsh session events in surface order.
 * @param nodes surface seqs; @param eventAt session lookup; @param afterSeq only events past this seq.
 * @returns { messages: [{ seq, role, text }], lastSeq, userTurns }
 */
export function collectSpan(nodes, eventAt, afterSeq = -1) {
  const messages = []
  let lastSeq = afterSeq
  let userTurns = 0
  for (const seq of nodes) {
    if (seq <= afterSeq) continue
    const event = eventAt(seq)
    if (!event) continue
    lastSeq = Math.max(lastSeq, seq)
    if (isHuman(event)) {
      const text = textOf(event.data.content)
      if (text) { messages.push({ seq, role: 'user', text }); userTurns++ }
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) messages.push({ seq, role: 'assistant', text })
    }
  }
  return { messages, lastSeq, userTurns }
}

/** First human prompt of the log, shortened: the chat's title until dsh gives us a better one. */
export function titleOf(eventAt, width = 60) {
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event)) {
      const text = textOf(event.data.content).replace(/\s+/g, ' ')
      return text.length > width ? `${text.slice(0, width - 1)}…` : text
    }
  }
}

/** Verbatim text of turn `n` (its prompt through the step before the next human prompt). */
export function turnTranscript(eventAt, n, { maxToolChars = 2000 } = {}) {
  let count = 0
  let seq = 0
  for (; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event) && ++count === n) break
  }
  const out = []
  for (let s = seq; ; s++) {
    const event = eventAt(s)
    if (!event || (s > seq && isHuman(event))) break
    if (isHuman(event)) out.push(`**user:**\n${textOf(event.data.content)}`)
    else if (event.type === 'assistant/message') {
      const blocks = event.data?.message?.content ?? []
      const text = textOf(blocks)
      if (text) out.push(`**assistant:**\n${text}`)
      for (const b of blocks) if (b.type === 'tool-call') out.push(`**tool call** ${b.name} ${String(b.arguments ?? '').slice(0, 300)}`)
    } else if (event.type === 'tool/result') {
      const text = textOf(event.data?.message?.content)
      out.push(`**tool result:**\n${text.length > maxToolChars ? `${text.slice(0, maxToolChars)}\n…[${text.length - maxToolChars} more chars]` : text}`)
    }
  }
  return out.join('\n\n')
}
