/**
 * Relevance: which topics of the other chats a message is about. Pure.
 *
 * A topic must earn its place with evidence (#23), counted per WORD of the message: a word found in
 * the topic's label or aliases counts 2, in its gist 0.5. Chinese and Japanese have no spaces, so a
 * chain of k matching character pairs counts as (k+1)/2 words, rounded down (数据库 is one word,
 * 单元测试 two), and an identifier counts once with its parts, twice when it matches exactly and
 * looks like code (id_ed25519_signing, pnpm-lock.yaml, loadViews); "tests" is "test" (#75). A
 * topic is a hit only with a label word and a score of 3 (two label words, or one plus two gist
 * words); long messages need a little more.
 * Rarity never lets a weak topic through; it only orders hits of equal evidence. Then:
 *   - copies: topics with the same label in several chats take one slot, shown as the newest (#43);
 *   - coverage: a lower hit stays only if it matches a word no higher hit matched, so one generic
 *     word ("cache") cannot drag extra topics in;
 *   - time: a named time puts topics from then first, after the slots are chosen, so it can never
 *     push an exact older match out (#24);
 *   - shown: hits already in the chat's context are dropped after the cut, never back-filled. A
 *     replacement of a shown decision is new, and so is a newer copy that says something else.
 */

import { resolveSuperseded } from './graph.js'
import { searchUnits, tokenize } from './text.js'
import { chatInRange, inRange } from './time.js'

/**
 * Weights and thresholds of the relevance gate. `inline`: label words the top hit needs before its
 * source is inlined (#39). `longAfter`/`longStep`: past `longAfter` search words, every `longStep`
 * more raise the floor by 1 (at most `longMax`), so a long pasted log does not light up every
 * topic that shares two of its words.
 */
export const SCORE = { label: 2, gist: 0.5, floor: 3, inline: 3, longAfter: 50, longStep: 50, longMax: 4 }

const nodeWords = new WeakMap()

/**
 * A topic's search words, computed once per topic object (#33). Loaded graphs are cached by file
 * stat (src/store), so the same objects come back on every message until the file changes.
 * A lowerCamel name in the label is one label word without its humps, so "a file url" does not
 * name pathToFileURL; its humps count only where the gist has them (#74).
 */
export function nodeTokens(node) {
  let words = nodeWords.get(node)
  if (!words) {
    words = {
      strong: new Set(tokenize([node.label, ...(node.aliases ?? [])].join(' '), { humps: false })),
      weak: new Set(tokenize(node.gist ?? '')),
      label: new Set(tokenize(node.label, { humps: false }))
    }
    nodeWords.set(node, words)
  }
  return words
}

/**
 * The same text, ignoring only case, width, spacing and punctuation. Digits and words such as
 * "not" stay: "retries 3" is not "retries 5", "Python 2 support" not "Python 3 support" (#43).
 */
export const sameText = (text) => String(text ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}]+/gu, ' ').trim()

/** Topics with the same label in several chats are one subject (#43). */
export const labelKey = (label) => sameText(label)

/** A view is `{ sid, cid, meta, graph, own }`; `own` is the chat the request belongs to. */
export const globalId = (view, id) => `c${view.cid}${id}`

/**
 * The evidence a topic's words give for a message, counted per word of the message. `units` come
 * plain words first, code last (see matchAcross).
 * `said`: tokens that count as already counted (the savings estimate passes the prompt's).
 * @returns { label, gist, matched } label and gist words, and the message's tokens that matched.
 */
function evidence(units, { strong, weak }, said = []) {
  let label = 0
  let gist = 0
  const matched = []
  const counted = new Set(said)
  const add = (tokens, words, isLabel) => {
    for (const t of tokens) counted.add(t)
    matched.push(...tokens)
    if (isLabel) label += words
    else gist += words
  }
  const kindOf = (t) => (t === null ? undefined : strong.has(t) ? 'label' : weak.has(t) ? 'gist' : undefined)

  /**
   * One chain of consecutive matching character pairs. A run of k pairs spans k+1 characters, about
   * (k+1)/2 words. Only pairs not counted yet add words, and a run that touches a counted pair
   * shares a character with a word already counted, so "测试和单元测试" is two words in either order.
   * A katakana or Hangul run is one word, however long (データベース).
   */
  const chain = (pairs, kind, one) => {
    const fresh = pairs.filter((p) => !counted.has(p))
    if (fresh.length === 0) return
    if (one) return add(fresh, 1, kind === 'label')
    for (let i = 0; i < pairs.length;) {
      if (counted.has(pairs[i])) { i++; continue }
      let j = i
      while (j + 1 < pairs.length && !counted.has(pairs[j + 1])) j++
      const touching = (i > 0 ? 1 : 0) + (j + 1 < pairs.length ? 1 : 0)
      add(pairs.slice(i, j + 1), Math.floor((j - i + 2 - touching) / 2), kind === 'label')
      i = j + 1
    }
  }

  for (const unit of units) {
    if (unit.kind === 'word') {
      // The topic has the same compound ("opt-out", "pnpm-lock.yaml"): one word, two when it is
      // code. Otherwise its parts are separate words in the topic ("restore-tested" against
      // "restore tested"), each counted on its own; parts of code (runner.py, self._resp) count
      // only as gist words, so a pasted traceback does not light up every topic named "runner".
      const [whole, ...parts] = unit.tokens
      if (counted.has(whole)) continue
      if (strong.has(whole)) { add([whole], unit.code ? 2 : 1, true); continue }
      const wholeInGist = weak.has(whole)
      if (wholeInGist && (unit.code || !parts.some((p) => strong.has(p)))) { add([whole], 1, false); continue }
      for (const p of parts) {
        if (counted.has(p)) continue
        if (strong.has(p)) add([p], 1, !unit.code)
        else if (!wholeInGist && weak.has(p)) add([p], 1, false)
      }
      continue
    }
    const bigrams = unit.bigrams
    for (let i = 0; i < bigrams.length;) {
      const kind = kindOf(bigrams[i])
      if (!kind) { i++; continue }
      let j = i
      while (j + 1 < bigrams.length && kindOf(bigrams[j + 1]) === kind) j++
      chain(bigrams.slice(i, j + 1), kind, unit.one)
      i = j + 1
    }
  }
  return { label, gist, matched }
}

/** Plain words and CJK first, code last: see matchAcross. */
const ordered = (all) => [...all.filter((u) => !(u.kind === 'word' && u.code)), ...all.filter((u) => u.kind === 'word' && u.code)]

/**
 * How many words of `text` are among a topic's `{ strong, weak }` words, counted the way matching
 * counts them (a Chinese word once, an exact code identifier of the label twice), leaving out the
 * tokens in `said`. The savings estimate tells an answer that used a topic from one that did not
 * with it (src/core/ledger.js).
 */
export function wordsIn(text, words, said = []) {
  const { label, gist } = evidence(ordered(searchUnits(text)), words, said)
  return label + gist
}

/**
 * Match a message against every view except the own chat (its text is still in context).
 * @param skip ids already in the chat's context; dropped after the cut, their slots stay empty.
 * @param floor, cover, collapse the gate, the coverage cut and the copy collapse; `/context-graph
 *   find` lowers the floor to one label word and turns both off, since a person searching wants
 *   every match, each copy included.
 * @returns { hits: [{ id, node, view, score, raw, label, matched, via, ids }], lead, total }
 *   hits in the order to show; `ids` lists every id the hit stands for (copies, replaced topics);
 *   `lead` is the top hit when its source may be inlined: three label words, well ahead of the rest;
 *   `total` counts the hits before shown ones were dropped.
 */
export function matchAcross(views, query, { max = 5, range, skip, floor, cover = true, collapse = true } = {}) {
  // Plain words and CJK first, code last: a word met first inside a path (src/auth/session.ts)
  // must not lower the weight of the same word written plainly ("the session cookie").
  const units = ordered(searchUnits(query))
  const q = tokenize(query)
  if (q.length === 0) return { hits: [], total: 0 }
  const gate = floor ?? SCORE.floor + Math.min(SCORE.longMax, Math.floor(Math.max(0, units.length - SCORE.longAfter) / SCORE.longStep))
  // An exact code identifier is the only token worth two words.
  const codeWholes = new Set(units.filter((u) => u.kind === 'word' && u.code).map((u) => u.tokens[0]))
  // Which units of the message hold each word: a topic's evidence is counted only over the units
  // holding one of its words (the others add nothing), so a long paste costs only what it matches.
  const unitsOf = new Map()
  units.forEach((unit, k) => {
    for (const t of unit.kind === 'cjk' ? unit.bigrams : unit.tokens) {
      if (!t) continue
      if (!unitsOf.has(t)) unitsOf.set(t, [])
      const list = unitsOf.get(t)
      if (list.at(-1) !== k) list.push(k)
    }
  })
  const df = new Map()
  let total = 0
  const found = []
  for (const view of views) {
    if (view.own) continue
    const index = wordIndex(view.graph)
    total += index.entries.length
    // Only topics that share a word with the message, with the most each could score (#66).
    const candidates = new Map()
    const reach = (i) => {
      let c = candidates.get(i)
      if (!c) candidates.set(i, (c = { bound: 0, label: false, words: [] }))
      return c
    }
    for (const t of q) {
      const strong = index.strong.get(t)
      const weak = index.weak.get(t)
      const count = (strong?.length ?? 0) + (weak?.length ?? 0)
      if (count === 0) continue
      df.set(t, (df.get(t) ?? 0) + count)
      for (const i of strong ?? []) {
        const c = reach(i)
        c.bound += SCORE.label * (codeWholes.has(t) ? 2 : 1)
        c.label = true
        c.words.push(t)
      }
      for (const i of weak ?? []) {
        const c = reach(i)
        c.bound += SCORE.gist
        c.words.push(t)
      }
    }
    for (const i of [...candidates.keys()].sort((a, b) => a - b)) {
      const c = candidates.get(i)
      if (!c.label || c.bound < gate) continue
      const [rawId, node] = index.entries[i]
      const words = nodeTokens(node)
      const held = [...new Set(c.words.flatMap((t) => unitsOf.get(t) ?? []))].sort((a, b) => a - b)
      const e = evidence(held.map((k) => units[k]), words)
      const raw = e.label * SCORE.label + e.gist * SCORE.gist
      // How much of its own label the message covers: on equal evidence, the topic the message names
      // exactly ("Redis session store") comes before a longer one ("... load test").
      const fit = words.label.size === 0 ? 0 : e.matched.filter((t) => words.label.has(t)).length / words.label.size
      if (e.label > 0 && raw >= gate) found.push({ view, rawId, node, raw, fit, label: e.label, matched: e.matched })
    }
  }
  const rarity = (t) => Math.log((total + 1) / (df.get(t) ?? 1))
  for (const f of found) {
    f.rare = f.matched.reduce((n, t) => n + rarity(t), 0)
    f.bonus = range && (inRange(f.node.updated, range) || chatInRange(f.view.meta, range)) ? 1 : 0
  }
  // Which topics get a slot is decided on evidence; the time bonus only breaks ties here.
  found.sort((a, b) => b.raw - a.raw || b.bonus - a.bonus || b.fit - a.fit || b.rare - a.rare || String(b.node.updated ?? '').localeCompare(String(a.node.updated ?? '')))

  // One slot per subject: a replaced decision resolves to its replacement, copies collapse.
  const bySubject = new Map()
  const ranked = []
  for (const f of found) {
    const id = resolveSuperseded(f.view.graph, f.rawId)
    const node = f.view.graph.nodes[id]
    const gid = globalId(f.view, id)
    const via = id === f.rawId ? undefined : globalId(f.view, f.rawId)
    const key = labelKey(node.label)
    const same = bySubject.get(gid) ?? (collapse ? bySubject.get(key) : undefined)
    if (same) {
      if (!same.copies.some((c) => c.id === gid)) same.copies.push({ id: gid, node })
      if (via && !same.vias.includes(via)) same.vias.push(via)
      bySubject.set(gid, same)
      continue
    }
    const hit = { id: gid, node, view: f.view, via, raw: f.raw, label: f.label, matched: f.matched, rare: f.rare, bonus: f.bonus, copies: [{ id: gid, node }], vias: via ? [via] : [] }
    bySubject.set(gid, hit)
    if (collapse) bySubject.set(key, hit)
    ranked.push(hit)
  }

  // A lower hit stays only if it matches a word no higher hit matched; a hit with equal evidence
  // is never cut by its equal (the message may name either).
  const explainedBy = new Map()
  const kept = []
  for (const hit of ranked) {
    if (kept.length >= max) break
    if (cover && kept.length > 0 && hit.matched.every((t) => (explainedBy.get(t) ?? -1) > hit.raw)) continue
    kept.push(hit)
    for (const t of hit.matched) if (!explainedBy.has(t)) explainedBy.set(t, hit.raw)
  }
  // The newest copy speaks for its subject, looked up among ALL topics with that label, not only
  // those that passed the gate: a later chat may have changed the decision in other words (#43).
  if (collapse) {
    for (const hit of kept) {
      const key = labelKey(hit.node.label)
      for (const view of views) {
        if (view.own) continue
        for (const id of subjects(view.graph).get(key) ?? []) {
          if (resolveSuperseded(view.graph, id) !== id) continue
          const gid = globalId(view, id)
          const node = view.graph.nodes[id]
          if (!hit.copies.some((c) => c.id === gid)) hit.copies.push({ id: gid, node })
          if (String(node.updated ?? '') > String(hit.node.updated ?? '')) Object.assign(hit, { id: gid, node, view, via: undefined })
        }
      }
    }
  }
  for (const hit of kept) {
    hit.score = hit.raw + hit.bonus
    hit.ids = [...hit.copies.map((c) => c.id), ...hit.vias]
  }
  // Then the named time orders what was chosen (stable, so equal scores keep the evidence order).
  kept.sort((a, b) => b.score - a.score)

  // Already in the chat: the hit itself, or a copy that says the same thing. A shown decision's
  // replacement, or a newer copy with a different gist, is new information and is sent.
  const sameGist = (a, b) => sameText(a.gist) === sameText(b.gist)
  const shown = (hit) => Boolean(skip) && (skip.has(hit.id) || hit.copies.some((c) => c.id !== hit.id && skip.has(c.id) && sameGist(c.node, hit.node)))
  const top = kept[0]
  // "Clearly ahead" of every other candidate, including any the coverage cut or the slot cap left out.
  const rest = Math.max(0, ...ranked.filter((h) => h !== top).map((h) => h.raw))
  const lead = top && !shown(top) && top.label >= SCORE.inline && top.raw >= 2 * rest ? top : undefined
  return { hits: kept.filter((hit) => !shown(hit)), lead, total: kept.length }
}

const indexMemo = new WeakMap()

/**
 * A loaded graph's topics by word, once per graph object (#66): label/alias words, and gist-only
 * words, each to the topics' positions. A message then visits only the topics it shares a word with.
 */
function wordIndex(graph) {
  let index = indexMemo.get(graph)
  if (!index) {
    const entries = Object.entries(graph.nodes)
    const strong = new Map()
    const weak = new Map()
    const add = (map, t, i) => {
      if (!map.has(t)) map.set(t, [])
      map.get(t).push(i)
    }
    entries.forEach(([, node], i) => {
      const words = nodeTokens(node)
      for (const t of words.strong) add(strong, t, i)
      for (const t of words.weak) if (!words.strong.has(t)) add(weak, t, i)
    })
    index = { entries, strong, weak }
    indexMemo.set(graph, index)
  }
  return index
}

const subjectsMemo = new WeakMap()

/** A chat's topic ids by subject (labelKey), once per loaded graph. */
function subjects(graph) {
  let map = subjectsMemo.get(graph)
  if (!map) {
    map = new Map()
    for (const [id, node] of Object.entries(graph.nodes)) {
      const key = labelKey(node.label)
      if (!map.has(key)) map.set(key, [])
      map.get(key).push(id)
    }
    subjectsMemo.set(graph, map)
  }
  return map
}

const chatWordsMemo = new WeakMap()

/** Every label and alias word of a chat's topics, once per loaded graph. */
function chatWords(graph) {
  let words = chatWordsMemo.get(graph)
  if (!words) {
    words = new Set()
    for (const node of Object.values(graph.nodes)) for (const t of nodeTokens(node).strong) words.add(t)
    chatWordsMemo.set(graph, words)
  }
  return words
}

/**
 * Chats in the order a new chat should see them (#27): most words of its first message in their
 * summary, title or topic labels first, then the most recently active.
 */
export function rankChats(views, query) {
  const q = tokenize(query)
  return views
    .map((view) => {
      const head = new Set(tokenize(`${view.meta.summary ?? ''} ${view.meta.title ?? ''}`))
      const words = chatWords(view.graph)
      return { view, overlap: q.filter((t) => head.has(t) || words.has(t)).length }
    })
    .sort((a, b) => b.overlap - a.overlap || String(b.view.meta.lastActiveAt ?? '').localeCompare(String(a.view.meta.lastActiveAt ?? '')))
    .map(({ view }) => view)
}
