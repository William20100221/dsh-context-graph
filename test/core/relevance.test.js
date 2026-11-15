/**
 * The relevance gate on the fixed audit corpus (#23, #39, #43). These numbers are the contract:
 * v0.7.0 scored 40% precision, sent a block for 7 of 20 unrelated prompts and injected 8,235
 * tokens over the 40 prompts. A later change that loosens the gate fails here.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { estimateTokens, formatSource, matchAcross, renderChats, renderHits } from '../../src/core/index.js'
import { HELD_T, HELD_U, TARGETED, UNRELATED, corpusViews } from '../fixtures/relevance-corpus.js'

/** The per-message decision of src/host/memory.js: hits, and an inline source only for a clear lead. */
function run(views, messages, prompts, gold) {
  const sourceOf = (view, node) => node.refs.map((seq) => messages[view.sid][seq]).map((m) => ({ role: m.r, text: m.x }))
  const out = { shown: 0, relevant: 0, found: 0, top1: 0, blocks: 0, tokens: 0 }
  for (const [prompt, ids] of prompts.map((p) => (Array.isArray(p) ? p : [p, []]))) {
    const { hits, lead } = matchAcross(views, prompt, { max: 5 })
    let inline
    if (lead && hits[0] === lead) {
      const text = formatSource(sourceOf(lead.view, lead.node))
      if (estimateTokens(text) <= 300) inline = { id: lead.id, text }
    }
    const block = renderHits(hits, { inline })
    const base = hits.map((h) => h.id.replace(/^c(\d+)n/, (_, n) => `c${Number(n) % 10}n`))
    out.shown += hits.length
    out.relevant += base.filter((id) => ids.includes(id)).length
    if (base.some((id) => ids.includes(id))) out.found++
    if (ids.includes(base[0])) out.top1++
    if (block) out.blocks++
    out.tokens += estimateTokens(block)
  }
  out.precision = out.relevant / Math.max(1, out.shown)
  return out
}

test('corpus: every targeted prompt finds its topic, unrelated prompts get nothing (#23)', () => {
  const { views, messages } = corpusViews()
  const t = run(views, messages, TARGETED)
  assert.equal(t.found, 20, 'recall')
  assert.ok(t.top1 >= 19, `top-1 ${t.top1}/20`)
  assert.ok(t.precision >= 0.9, `precision ${t.precision}`)
  assert.ok(t.tokens <= 4000, `targeted tokens ${t.tokens} (v0.7.0: 8,235 for the 40 prompts)`)
  const u = run(views, messages, UNRELATED)
  assert.equal(u.blocks, 0, 'no block for an unrelated prompt')
})

test('corpus: the held-out prompts, never used for tuning, hold up', () => {
  const { views, messages } = corpusViews()
  const t = run(views, messages, HELD_T)
  assert.equal(t.found, HELD_T.length)
  assert.ok(t.precision >= 0.85, `precision ${t.precision}`)
  assert.ok(run(views, messages, HELD_U).blocks <= 1, 'at most one borderline block for unrelated held-out prompts')
})

test('corpus: the same subject in five chats takes one slot (#43)', () => {
  const { views, messages } = corpusViews({ copies: 5 })
  const t = run(views, messages, TARGETED)
  assert.equal(t.found, 20)
  assert.ok(t.precision >= 0.9, `precision ${t.precision} with copies`)
  const { hits } = matchAcross(views, '给 recall 工具传什么 id', { max: 5 })
  assert.equal(new Set(hits.map((h) => h.node.label)).size, hits.length, 'no label twice')
  assert.equal(hits[0].ids.length, 5, 'the kept hit stands for all five copies')
})

test('a topic already shown is dropped and its slot stays empty: no back-fill (#23)', () => {
  const { views } = corpusViews()
  const first = matchAcross(views, 'what pool size did we pick for pgbouncer?')
  assert.deepEqual(first.hits.map((h) => h.id), ['c2n3'])
  const again = matchAcross(views, 'what pool size did we pick for pgbouncer?', { skip: new Set(['c2n3']) })
  assert.deepEqual(again.hits, [], 'no weaker topic takes its place')
  assert.equal(again.total, 1)
  assert.equal(again.lead, undefined, 'nothing to inline')
})

test('only a clearly leading strong hit is inlined, and Chinese counts in tokens (#39)', () => {
  const { views } = corpusViews()
  assert.equal(matchAcross(views, 'how does refresh token rotation work?').lead?.id, 'c4n1', 'three label words, alone: inlined')
  assert.equal(matchAcross(views, 'how do we handle refresh token reuse?').lead, undefined, 'two label words: listed, not inlined')
  assert.equal(matchAcross(views, '家里的路由器信号不好怎么办').hits.length, 0, 'the router question gets nothing at all')
  assert.equal(matchAcross(views, 'how is the parquet output partitioned').lead?.id, 'c6n6')
})

test('the first-message list stays within its budget at 50 chats and leads with the relevant chat (#27)', () => {
  const { views } = corpusViews({ copies: 9 })
  const list = renderChats(views, { prompt: '我们的 React 前端性能怎么优化', maxTokens: 200 })
  assert.ok(estimateTokens(list) <= 200, `list ${estimateTokens(list)} tokens`)
  assert.match(list.split('\n')[1], /^c\d*3 React 前端性能优化/, 'the chat sharing words with the prompt comes first')
  assert.match(list, /… \d+ more; recall\("YYYY-MM-DD"\)/, 'what does not fit is counted')
})
