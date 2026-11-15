/**
 * The indexing call: what the model reads (transcript + rules) and how its answer is parsed. Pure.
 */

import { RELATIONS } from './graph.js'

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
    'Shape: {"nodes":[{"id":"n12"|null,"label":"...","gist":"...","aliases":["..."],"kind":"decision|fact|task|artifact|open-question","msgs":[0,2]}],"edges":[["n12","n3","uses"]],"skip":true|absent}',
    '',
    'Rules:',
    '- One node per decision, fact, task, artifact (file, tool, repo) or open question worth remembering later. Skip chit-chat and anything already obvious from the labels below unless it changed.',
    '- label: at most 6 words, the name someone would search for. gist: one line under 120 characters, what is true now and why.',
    '- aliases: other words a future message might use for this node, including the other language if the conversation mixes languages. Be precise; matching is by word overlap.',
    '- msgs: the numbers N of the [mN] messages the node is drawn from, as integers (e.g. [0, 2]). Required, never empty.',
    '- id: reuse an existing id below when the node is the same thing (update its gist); null for a new node.',
    `- edges: [from, to, relation] with relation in ${RELATIONS.join(', ')}. For a changed decision add [new, old, "supersedes"]. Use existing ids where possible; refer to new nodes by their label in place of an id.`,
    '- Keep file paths, commands, identifiers and numbers exact.',
    '- If nothing in the span is worth remembering, output {"nodes":[],"edges":[],"skip":true}.',
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
  return { nodes: best.nodes, edges, skip, raw: best.raw }
}

/** The better of two parses (answer text and reasoning text): the one with more usable nodes. */
export function betterParse(a, b) {
  if (!a) return b
  if (!b) return a
  if (b.nodes.length > a.nodes.length) return b
  return a.nodes.length === 0 && !a.skip && b.skip ? b : a
}

/** The newest messages whose builder transcript fits in `maxChars` (each message counts at most `perMessage`). */
export function tailWithin(messages, maxChars, perMessage = 2000) {
  let used = 0
  let start = messages.length
  while (start > 0) {
    const cost = Math.min(messages[start - 1].text.length, perMessage) + 20
    if (start < messages.length && used + cost > maxChars) break
    used += cost
    start--
  }
  return messages.slice(start)
}
