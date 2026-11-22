/**
 * The indexing call: what the model reads (fixed rules, existing topics, the span) and how its
 * answer is parsed. Pure.
 */

import { RELATIONS } from './graph.js'
import { chatType } from './labels.js'
import { sliceChars } from './text.js'

/** A human prompt is read up to this many characters; assistant text is shortened further when a span is long (#46). */
export const USER_CAP = 2000
const ASSISTANT_CAPS = [2000, 800, 300]

/** `[m0 user] ...` transcript the builder reads; each message capped so one huge paste cannot eat the call. */
export function transcriptForBuilder(messages, { userCap = USER_CAP, assistantCap = USER_CAP } = {}) {
  return messages.map((m, i) => {
    const cap = m.role === 'user' ? userCap : assistantCap
    const text = m.text.length > cap ? `${sliceChars(m.text, cap)}\n…[${m.text.length - cap} more chars]` : m.text
    return `[m${i} ${m.role}]\n${text}`
  }).join('\n\n')
}

/**
 * The fixed part of every indexing prompt, byte for byte the same for every build of every chat, so
 * it is the cached prefix of the call (#28). Anything that changes comes after it.
 */
export const BUILDER_RULES = [
  'You index a conversation into a memory of topics that later chats search. Output ONE JSON object and nothing else:',
  '{"summary":"...","subject":"...","type":"...","project":"...","parts":[],"nodes":[{"id":"n12"|null,"label":"...","gist":"...","aliases":["..."],"kind":"decision|fact|task|artifact|open-question","msgs":[0,2]}],"edges":[["n12","n3","uses"]]}',
  '',
  'Rules:',
  '- summary: one line of at most 12 words saying what the whole chat is about so far; update the current summary.',
  '- subject: the broad subject the chat belongs to, at most 4 words; chats on the same subject must get the same subject word for word, so reuse one of the workspace subjects below when it fits.',
  '- type: what the whole chat is for, one of: coding, debugging (fixing a bug), research (finding things out), study (learning, homework, exams), writing, planning, setup (installing, configuring), data (analysis), creative, language (translation, grammar, idioms), question (one quick question), chat (everyday talk). Update the current type when the chat changed.',
  '- project: the project, product, course or subject the chat works on, in at most 4 words (e.g. "dsh-context-graph", "NZQA Earth and Space"), or "" when there is none.',
  '- parts: only when this conversation holds more than one separate conversation, one entry per conversation: {"msgs":[first,last],"type":"...","about":"at most 8 words"}; otherwise [].',
  '- One node per decision, fact, task, artifact (file, tool, repo) or open question worth remembering later. Skip chit-chat and anything an existing topic already says, unless it changed.',
  '- label: at most 6 words, the name someone would search for. gist: one line under 120 characters, what is true now and why.',
  '- aliases: other words a later message might use for it, including the other language when the chat mixes languages. Matching is by word overlap.',
  '- msgs: the numbers N of the [mN] messages the node comes from, as integers (e.g. [0, 2]). Required, never empty.',
  '- id: reuse an existing topic\'s id when the node is the same thing (and update its gist); null for a new node.',
  `- edges: [from, to, relation] with relation in ${RELATIONS.join(', ')}. For a changed decision add [new, old, "supersedes"]. Name new nodes by their label in place of an id.`,
  '- Keep file paths, commands, identifiers and numbers exact.',
  '- If nothing is worth remembering, output {"summary":"...","nodes":[],"edges":[],"skip":true}.'
].join('\n')

const idNumber = (id) => Number(/\d+/.exec(id)?.[0] ?? 0)

/**
 * The whole indexing prompt, ordered from most to least stable (#28): the fixed rules, then the
 * chat's existing topics in id order (new topics only ever append, so the previous build's list is a
 * prefix of this one), then the current summary and the span, which change every time.
 */
export function builderPrompt({ graph, summary, labels = {}, subjects = [], messages, assistantCap = USER_CAP }) {
  const existing = Object.entries(graph.nodes)
    .sort(([a], [b]) => idNumber(a) - idNumber(b))
    .map(([id, n]) => `${id}: ${n.label}`)
    .join('\n')
  return [
    BUILDER_RULES,
    '',
    existing ? `Existing topics:\n${existing}` : 'Existing topics: (none)',
    '',
    `Current summary: ${summary || '(none yet)'}`,
    `Current subject: ${labels.subject || '(none yet)'} · type: ${labels.type || '(none yet)'} · project: ${labels.project || '(none)'}`,
    `Workspace subjects: ${subjects.length ? subjects.join('; ') : '(none yet)'}`,
    '',
    'Conversation to index:',
    transcriptForBuilder(messages, { assistantCap }),
    '',
    'Output the JSON object now.'
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
 * Message citations as integers: models write `[0, 2]`, but also `["m0", "m2"]` (the transcript
 * labels messages `[m0 user]`) or `["1"]`. Anything else is dropped (#14).
 */
const citations = (msgs) => (Array.isArray(msgs) ? msgs : [])
  .map((i) => (typeof i === 'number' ? i : Number(String(i).trim().replace(/^m/i, ''))))
  .filter((i) => Number.isInteger(i) && i >= 0)

/**
 * One `"nodes": [` array: how many objects it holds (`raw`) and which are usable (complete, with a
 * label and at least one citation).
 */
function nodesAt(clean, open) {
  const nodes = []
  const objects = objectsInArray(clean, open)
  for (const raw of objects) {
    let node
    try { node = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')) } catch { continue }
    if (!node || typeof node.label !== 'string' || !node.label.trim()) continue
    const msgs = citations(node.msgs)
    if (msgs.length > 0) nodes.push({ ...node, msgs })
  }
  return { nodes, raw: objects.length }
}

/**
 * Tolerant extraction of the builder's JSON. Handles code fences, prose around it, `<think>` blocks,
 * trailing commas, and output cut off mid-way (every complete node object is kept). When the text
 * holds several `"nodes"` arrays (a schema echoed back, a draft before the answer), the one with the
 * most usable nodes wins, the later one on a tie (#14).
 * `skip` means "nothing worth remembering": `"skip": true`, or every `"nodes"` array is empty. An
 * array that holds objects none of which is usable (bad citations) is NOT a skip: that span is
 * retried instead of being marked as indexed. `undefined` when there is no `"nodes"` array at all.
 */
export function parseBuilderOutput(text) {
  const clean = String(text ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
  let best
  let objects = 0
  for (const match of clean.matchAll(/"nodes"\s*:\s*\[/g)) {
    const open = match.index + match[0].length - 1
    const found = nodesAt(clean, open)
    objects += found.raw
    if (!best || found.nodes.length >= best.nodes.length) best = { ...found, open }
  }
  if (!best) return undefined
  const after = clean.slice(best.open)
  // Edges normally follow the chosen nodes; a model that writes them first is still read.
  const scope = after.search(/"edges"\s*:/) >= 0 ? after : clean
  const edgesAt = scope.search(/"edges"\s*:/)
  const edges = edgesAt < 0 ? [] : [...scope.slice(edgesAt).matchAll(/\[\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\]/g)].map((m) => [m[1], m[2], m[3]])
  const skip = best.nodes.length === 0 && (/"skip"\s*:\s*true/.test(after) || objects === 0)
  return { nodes: best.nodes, edges, skip, raw: best.raw, summary: summaryNear(clean, best.open), ...labelsNear(clean, best.open) }
}

/**
 * The chat's labels in the chosen answer (#94): its type, project and parts. They are read from that
 * answer's own head (from its last "summary" key to its nodes, parts aside), else from what follows
 * its nodes, so a schema echoed before it never counts. Parts are `{ msgs: [first, last], type,
 * about }`, cited as nodes are. Anything invalid (a type not in the list, a placeholder) is left out.
 */
function labelsNear(clean, open) {
  const head = clean.slice(0, open)
  const own = head.slice([...head.matchAll(/"summary"\s*:/g)].at(-1)?.index ?? 0)
  const tail = clean.slice(open)
  const partsIn = (text) => [...text.matchAll(/"parts"\s*:\s*\[/g)][0]
  const ownParts = partsIn(own)
  const region = ownParts ? own.slice(0, ownParts.index) : own
  const typeIn = (text) => [...text.matchAll(/"type"\s*:\s*"([a-z-]+)"/g)].map((m) => chatType(m[1])).filter(Boolean)
  const type = typeIn(region).at(-1) ?? typeIn(tail)[0]
  const projectIn = (text) => [...text.matchAll(/"project"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => {
    try { return String(JSON.parse(m[1])).replace(/\s+/g, ' ').trim().slice(0, 60) } catch { return undefined }
  }).filter((v) => v !== undefined && !/^\.+$/.test(v))
  const project = projectIn(region).at(-1) ?? projectIn(tail)[0]
  const parts = []
  const partsAt = ownParts ? { text: own, match: ownParts } : partsIn(tail) ? { text: tail, match: partsIn(tail) } : undefined
  if (partsAt) {
    for (const raw of objectsInArray(partsAt.text, partsAt.match.index + partsAt.match[0].length - 1)) {
      let part
      try { part = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')) } catch { continue }
      const msgs = citations(part?.msgs)
      const about = typeof part?.about === 'string' ? part.about.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
      if (msgs.length > 0 && chatType(part.type)) parts.push({ msgs: [Math.min(...msgs), Math.max(...msgs)], type: part.type, about })
    }
  }
  const subjectIn = (text) => [...text.matchAll(/"subject"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => {
    try { return String(JSON.parse(m[1])).replace(/\s+/g, ' ').trim().slice(0, 60) } catch { return undefined }
  }).filter((v) => v && !/^\.+$/.test(v))
  const subject = subjectIn(region).at(-1) ?? subjectIn(tail)[0]
  return { subject, type, project: project === '' ? null : project, parts }
}

/** The fixed part of the call that sorts already indexed chats into subjects (#96). */
export const SORT_RULES = [
  'You sort the chats of one workspace into broad subjects and say what each chat is for. Output ONE JSON object and nothing else:',
  '{"chats":[{"cid":3,"subject":"...","type":"...","project":"..."}]}',
  '',
  'Rules:',
  '- One entry per chat listed below, with its cid.',
  '- subject: the broad subject, at most 4 words; chats on the same subject get the same subject word for word; reuse one of the existing subjects when it fits.',
  '- type: one of coding, debugging, research, study, writing, planning, setup, data, creative, language, question, chat.',
  '- project: the project, product, course or subject worked on, at most 4 words, or "" when there is none.'
].join('\n')

/** The prompt that sorts `chats` ([{ cid, summary, labels: [topic labels] }]) given the workspace's subjects. */
export function sortPrompt({ chats, subjects = [] }) {
  return [
    SORT_RULES,
    '',
    `Existing subjects: ${subjects.length ? subjects.join('; ') : '(none yet)'}`,
    '',
    'Chats:',
    ...chats.map((c) => `c${c.cid} | ${c.summary || '(no summary)'} | topics: ${c.labels.slice(0, 8).join('; ')}`),
    '',
    'Output the JSON object now.'
  ].join('\n')
}

/** The sorting answer: `{ [cid]: { subject?, type?, project? } }` for the cids asked about; anything invalid left out. */
export function parseSortOutput(text, cids) {
  const clean = String(text ?? '').replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '')
  const out = {}
  for (const match of clean.matchAll(/"chats"\s*:\s*\[/g)) {
    for (const raw of objectsInArray(clean, match.index + match[0].length - 1)) {
      let entry
      try { entry = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')) } catch { continue }
      const cid = Number(String(entry?.cid ?? '').replace(/^c/i, ''))
      if (!cids.includes(cid)) continue
      const text = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 60) : '')
      const subject = text(entry.subject)
      const project = text(entry.project)
      out[cid] = {
        ...(subject && !/^\.+$/.test(subject) ? { subject } : {}),
        ...(chatType(entry.type) ? { type: entry.type } : {}),
        ...(project && !/^\.+$/.test(project) ? { project } : {})
      }
    }
  }
  return out
}

/**
 * The chat summary of the chosen answer (#27): the last `"summary"` before its nodes (the shape puts
 * it first), else the first one after them. The schema's own "..." placeholder does not count.
 */
function summaryNear(clean, open) {
  const all = [...clean.matchAll(/"summary"\s*:\s*("(?:[^"\\]|\\.)*")/g)]
  const pick = all.filter((m) => m.index < open).at(-1) ?? all.find((m) => m.index > open)
  if (!pick) return undefined
  let text
  try { text = JSON.parse(pick[1]) } catch { return undefined }
  text = String(text).replace(/\s+/g, ' ').trim()
  return text && !/^\.+$/.test(text) ? text.slice(0, 160) : undefined
}

/** The better of two parses (answer text and reasoning text): the one with more usable nodes. */
export function betterParse(a, b) {
  if (!a) return b
  if (!b) return a
  if (b.nodes.length > a.nodes.length) return b
  return a.nodes.length === 0 && !a.skip && b.skip ? b : a
}

/**
 * What one build reads (#46). Every human prompt is read (up to USER_CAP characters); assistant
 * text is shortened 2,000 -> 800 -> 300 characters until the span fits `maxChars`. A span that
 * still does not fit is read in whole turns from the oldest, and the rest waits for the next build,
 * so nothing is skipped; only a single turn too long on its own loses its oldest assistant steps.
 * @returns { messages, assistantCap, rest } `rest` is the first message left for a later build, if any.
 */
export function planSpan(messages, maxChars) {
  const cost = (m, cap) => Math.min(m.text.length, m.role === 'user' ? USER_CAP : cap) + 20
  const sum = (list, cap) => list.reduce((n, m) => n + cost(m, cap), 0)
  for (const cap of ASSISTANT_CAPS) if (sum(messages, cap) <= maxChars) return { messages, assistantCap: cap, rest: undefined }
  const cap = ASSISTANT_CAPS.at(-1)
  const turns = []
  for (const m of messages) {
    if (turns.length === 0 || m.role === 'user') turns.push([])
    turns.at(-1).push(m)
  }
  const picked = []
  let used = 0
  let next = 0
  for (; next < turns.length; next++) {
    const turn = turns[next]
    const c = sum(turn, cap)
    if (picked.length > 0 && used + c > maxChars) break
    if (picked.length === 0 && c > maxChars) {
      // One turn alone is too long: its prompts, then its newest assistant steps that fit.
      const prompts = turn.filter((m) => m.role === 'user')
      let room = maxChars - sum(prompts, cap)
      const steps = []
      for (const m of turn.filter((x) => x.role !== 'user').reverse()) {
        if (cost(m, cap) > room) break
        room -= cost(m, cap)
        steps.unshift(m)
      }
      const keep = new Set([...prompts, ...steps])
      picked.push(...turn.filter((m) => keep.has(m)))
      next++
      break
    }
    picked.push(...turn)
    used += c
  }
  return { messages: picked, assistantCap: cap, rest: turns[next]?.[0] }
}
