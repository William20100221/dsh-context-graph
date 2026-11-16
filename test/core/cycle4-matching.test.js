/**
 * Cycle 4 matching (#74, #75): lowerCamel identifiers and plural/singular forms, measured on the
 * relevance corpus with the fixture's reworded questions (REWORDED) and everyday messages (EVERYDAY).
 * Before the fix, 0.9.0 found 4 of the 37 reworded questions.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyGraph, estimateTokens, formatSource, matchAcross, mergeDelta, renderHits, searchUnits, tokenize } from '../../src/core/index.js'
import { EVERYDAY, HELD_T, HELD_U, REWORDED, TARGETED, UNRELATED, corpusViews } from '../fixtures/relevance-corpus.js'

const ids = (r) => r.hits.map((h) => h.id)
const view = (cid, label, gist, aliases = []) => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label, gist, aliases, msgs: [0] }], edges: [] }, { now: '2026-11-01T00:00:00Z' })
  return { sid: `s${cid}`, cid, meta: { cid }, graph, own: false }
}

/** The per-message decision of src/host/memory.js, as in test/core/relevance.test.js. */
function run({ views, messages }, prompts) {
  const out = { shown: 0, relevant: 0, found: 0, top1: 0, blocks: 0 }
  for (const [prompt, gold] of prompts.map((p) => (Array.isArray(p) ? p : [p, []]))) {
    const { hits, lead } = matchAcross(views, prompt, { max: 5 })
    let inline
    if (lead && hits[0] === lead) {
      const text = formatSource(lead.node.refs.map((seq) => messages[lead.view.sid][seq]).map((m) => ({ role: m.r, text: m.x })))
      if (estimateTokens(text) <= 300) inline = { id: lead.id, text }
    }
    const shown = hits.map((h) => h.id)
    out.shown += shown.length
    out.relevant += shown.filter((id) => gold.includes(id)).length
    if (shown.some((id) => gold.includes(id))) out.found++
    if (gold.includes(shown[0])) out.top1++
    if (renderHits(hits, { inline })) out.blocks++
  }
  out.precision = out.relevant / Math.max(1, out.shown)
  return out
}

test('#74 a lowerCamel identifier is code: the word counts double, its humps are its parts', () => {
  assert.deepEqual(searchUnits('loadViews'), [{ kind: 'word', tokens: ['loadview', 'load', 'view'], code: true }])
  assert.deepEqual(searchUnits('see loadViews.'), searchUnits('loadViews'), 'sentence punctuation is not part of it')
  assert.deepEqual(tokenize('isAgentLoopRequest'), ['isagentlooprequest', 'agent', 'loop', 'request'])
  assert.deepEqual(tokenize('loadViews', { humps: false }), ['loadview'])
  for (const word of ['GitHub', 'JavaScript', 'iPhone', 'eCommerce', 'macOS', 'useRef']) assert.equal(searchUnits(word)[0].code, false, `${word} is a plain word`)
  assert.equal(tokenize('LoadViews')[0], tokenize('loadViews')[0], 'case does not change the word')
})

test('#74 a question naming an identifier finds its topic, however it is cased', () => {
  assert.deepEqual(ids(matchAcross(corpusViews({ code: true }).views, 'where do we call matchAcross')), ['c7n1'])
  const v = [view(1, 'loadViews meta cache', 'every message re-reads chat metas unless the stat key matches')]
  assert.deepEqual(ids(matchAcross(v, 'loadViews?')), ['c1n1'], 'the exact identifier alone')
  for (const q of ['LoadViews meta', 'loadviews meta']) assert.deepEqual(ids(matchAcross(v, q)), ['c1n1'], q)
  // The humps of a label's name are not label words: pathToFileURL is an alias of c5n7.
  assert.deepEqual(ids(matchAcross(corpusViews().views, 'can you share a file url to my phone')), [])
})

test('#75 a plural and its singular are one search word, on both sides', () => {
  assert.deepEqual(tokenize('tests images queries caches cookies sizes classes boxes branches hashes'), tokenize('test image query cache cookie size class box branch hash'))
  assert.deepEqual(tokenize('times news status'), ['times', 'news', 'status'], 'never into a stopword; a singular ending in s stays')
  assert.deepEqual(tokenize('user_ids feature-flags'), ['user_ids', 'user', 'ids', 'feature-flags', 'feature', 'flag'], 'a compound stays exact, its parts fold')
  assert.deepEqual(tokenize('单元测试 tests'), [...tokenize('单元测试'), 'test'], 'Chinese as before')
  assert.deepEqual(ids(matchAcross(corpusViews().views, 'how do soft deletes work')), ['c2n8'])
})

test('cycle 4 corpus: every reworded question is found, everyday messages get nothing, precision holds (#74, #75)', () => {
  const plain = corpusViews()
  const code = corpusViews({ code: true })
  const r = run(code, REWORDED)
  assert.equal(r.found, REWORDED.length, `reworded found ${r.found}/${REWORDED.length}`)
  assert.equal(r.top1, REWORDED.length, `reworded top-1 ${r.top1}`)
  assert.ok(r.precision >= 0.95, `reworded precision ${r.precision}`)
  assert.equal(run(code, EVERYDAY).blocks, 0, 'no block for an everyday message')
  // Precision as measured on 0.9.0, before #74/#75; chat 7 only adds distractors.
  for (const [corpus, set, before, name] of [[plain, TARGETED, 1, 'targeted'], [plain, HELD_T, 1, 'held-out'], [code, TARGETED, 0.95, 'targeted + chat 7'], [code, HELD_T, 1, 'held-out + chat 7']]) {
    const t = run(corpus, set)
    assert.equal(t.found, set.length, name)
    assert.ok(t.precision >= before, `${name} precision ${t.precision}`)
  }
  assert.equal(run(code, UNRELATED).blocks, 0, 'unrelated + chat 7')
  assert.ok(run(code, HELD_U).blocks <= 1, 'held-out unrelated + chat 7')
})
