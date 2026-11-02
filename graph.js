/**
 * context-graph core. Pure: no I/O, no dsh imports, so `node --test` covers it without a harness.
 *
 * A graph is `{ version, nextId, nodes: { [id]: Node }, edges: [[from, to, relation], ...] }`.
 * A Node is `{ label, gist, aliases, kind, src: [{ session, turn, at }], updated, hits }`.
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

/** True when every provenance entry of `node` comes from `session` (its text is still in that session's context). */
export function onlyFromSession(node, session) {
  return Boolean(session) && (node.src ?? []).length > 0 && node.src.every((s) => s.session === session)
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
 * Lexical match of a user message against node labels/aliases (weight 2) and gists (weight 1),
 * with a small boost for well-connected nodes. Nodes whose every source is the current session are
 * skipped while that session has not compacted: their text is still on the surface.
 * @returns [{ id, node, score }] best first, at most `max`, only nodes with a strong (label/alias) hit.
 */
export function matchNodes(graph, query, { max = 5, session, sessionCompacted = false } = {}) {
  const q = tokenize(query)
  if (q.length === 0) return []
  const scored = []
  for (const [rawId, node] of Object.entries(graph.nodes)) {
    if (!sessionCompacted && onlyFromSession(node, session)) continue
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

function line(id, node) {
  const date = (node.updated ?? '').slice(0, 10)
  return `- ${id} ${node.label}: ${node.gist}${date ? ` (${date})` : ''}`
}

/** The per-turn block appended to the user's message. `inline` carries one node's verbatim text when it is short. */
export function renderHits(graph, hits, { inline } = {}) {
  if (hits.length === 0) return ''
  const lines = [`[${SOURCE_KIND}] Related past context. Call recall(id) for the verbatim source.`]
  for (const { id, node, via } of hits) lines.push(line(id, node) + (via ? ` [replaces ${via}]` : ''))
  if (inline) lines.push('', `Verbatim source of ${inline.id}:`, inline.text.trim())
  return lines.join('\n')
}

/** The cross-session surface layer sent once at the start of a session. */
export function renderSurface(graph, ids) {
  if (ids.length === 0) return ''
  const lines = [
    `[${SOURCE_KIND}] Memory of earlier sessions in this project (${Object.keys(graph.nodes).length} nodes). ` +
    'Each line is one node: id, label, gist. Call recall(id) for the verbatim source and its neighbours. ' +
    'Treat this as background; do not restate it.'
  ]
  for (const id of ids) lines.push(line(id, graph.nodes[id]))
  return lines.join('\n')
}

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

/** Tolerant JSON extraction: fences, leading prose, trailing commas. `undefined` when nothing usable. */
export function parseBuilderOutput(text) {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  const body = text.slice(start, end + 1).replace(/,\s*([}\]])/g, '$1')
  let parsed
  try { parsed = JSON.parse(body) } catch { return undefined }
  if (!parsed || !Array.isArray(parsed.nodes)) return undefined
  const nodes = parsed.nodes.filter((n) => n && typeof n.label === 'string' && n.label.trim() && Array.isArray(n.msgs) && n.msgs.length > 0)
  const edges = Array.isArray(parsed.edges) ? parsed.edges.filter((e) => Array.isArray(e) && e.length === 3 && e.every((x) => typeof x === 'string')) : []
  return { nodes, edges }
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
    if (event.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textOf(event.data.content)
      if (text) { messages.push({ seq, role: 'user', text }); userTurns++ }
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text) messages.push({ seq, role: 'assistant', text })
    }
  }
  return { messages, lastSeq, userTurns }
}

function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}

// ---------- folding: replace old turns of the current chat with a table of contents ----------

/** Injected context kinds that must survive a fold (carried into the fold message verbatim). */
export const KEEP_KINDS = ['skill-catalog', 'runtime-context']

const isHuman = (event) => event?.type === 'user/message' && event.data?.source?.kind === 'user'
export const isFold = (event) => event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND && event.data.source.fold === true

function toolDelta(event) {
  if (event?.type === 'assistant/message') return (event.data?.message?.content ?? []).filter((b) => b.type === 'tool-call').length
  return event?.type === 'tool/result' ? -1 : 0
}

/**
 * Choose the surface range to fold: everything after the system prompt up to (not including) the
 * human prompt that starts the last `keepTurns` turns. Only content already indexed (seq <= maxSeq)
 * is folded, and the cut never splits a tool call from its result.
 * @returns {{ startSeq, endSeq, shadowedSeqs } | undefined}
 */
export function planFold(nodes, eventAt, { keepTurns = 2, maxSeq = Infinity } = {}) {
  const first = eventAt(nodes[0])?.type === 'system/message' ? 1 : 0
  const humans = []
  for (let i = first; i < nodes.length; i++) if (isHuman(eventAt(nodes[i]))) humans.push(i)
  for (let h = humans.length - keepTurns; h >= 1; h--) {
    const cut = humans[h]
    const range = nodes.slice(first, cut)
    if (!range.some((seq) => isHuman(eventAt(seq)))) return undefined
    if (range.some((seq) => seq > maxSeq && !isFold(eventAt(seq)))) continue
    let open = 0
    for (const seq of nodes.slice(0, cut)) open += toolDelta(eventAt(seq))
    if (open !== 0) continue
    return { startSeq: range[0], endSeq: range.at(-1), shadowedSeqs: range }
  }
  return undefined
}

/** Every human prompt in the session log up to `endSeq`, numbered t1, t2, ... in log order. */
export function turnIndex(eventAt, endSeq = Infinity) {
  const turns = []
  for (let seq = 0; seq <= endSeq; seq++) {
    const event = eventAt(seq)
    if (!event) break
    if (isHuman(event)) turns.push({ turn: turns.length + 1, seq, text: textOf(event.data.content) })
  }
  return turns
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

/** Content blocks the fold message must carry: latest standing context of each KEEP_KINDS kind. */
export function foldKept(shadowedSeqs, eventAt) {
  const kept = new Map()
  for (const seq of shadowedSeqs) {
    const event = eventAt(seq)
    if (isFold(event)) {
      const kinds = event.data.source.keptKinds ?? []
      kinds.forEach((kind, i) => kept.set(kind, event.data.content[i + 1]))
    } else if (event?.type === 'user/message' && KEEP_KINDS.includes(event.data?.source?.kind)) {
      kept.set(event.data.source.kind, { type: 'text', text: textOf(event.data.content) })
    }
  }
  return { kinds: [...kept.keys()], blocks: [...kept.values()].filter(Boolean) }
}

/** The table of contents that replaces the folded turns. */
export function renderFoldIndex(graph, session, turns, { maxNodes = 40, maxTurns = 60, width = 90 } = {}) {
  const lines = [
    `[${SOURCE_KIND}] Turns t1-t${turns.length} of this conversation are folded to save tokens. They are not lost.`,
    'Below is their table of contents. Before answering anything that depends on their details, call recall with a topic id (n12) for the facts, or a turn id (t7) for the exact messages of that turn. Do not guess folded details.'
  ]
  const ids = surfaceNodes(graph, Infinity).filter((id) => (graph.nodes[id].src ?? []).some((s) => s.session === session)).slice(0, maxNodes)
  if (ids.length > 0) {
    lines.push('', 'Topics:')
    for (const id of ids) lines.push(`- ${id} ${graph.nodes[id].label}: ${graph.nodes[id].gist}`)
  }
  lines.push('', 'Turns (what the user asked):')
  const shown = turns.slice(-maxTurns)
  if (shown.length < turns.length) lines.push(`- t1-t${turns.length - shown.length}: earlier turns, recall by id`)
  for (const t of shown) {
    const first = t.text.replace(/\s+/g, ' ').trim()
    lines.push(`- t${t.turn}: ${first.length > width ? `${first.slice(0, width - 1)}…` : first}`)
  }
  return lines.join('\n')
}
