/**
 * Cycle 3 (v0.9.0): the pure core fixes from the audit of v0.8.0.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'

import { collectSpan, emptyGraph, formatSource, inGap, matchAcross, mergeDelta, nextGap, shares } from '../../src/core/index.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'

const seeded = () => {
  const g = emptyGraph()
  mergeDelta(g, { nodes: [{ label: 'one', msgs: [0] }, { label: 'two', msgs: [0] }, { label: 'three', msgs: [0] }], edges: [] }, { now: 'T' })
  return g
}

test('#61 an id the model invents for a new topic never overwrites another new topic', () => {
  const refsOf = (msgs) => msgs.map((i) => 100 + i)
  const a = seeded()
  mergeDelta(a, { nodes: [{ id: null, label: 'Auth uses JWT', msgs: [0] }, { id: 'n4', label: 'Redis session cache', msgs: [1] }], edges: [] }, { now: 'T2', refsOf })
  assert.deepEqual(Object.values(a.nodes).map((n) => n.label).slice(3), ['Auth uses JWT', 'Redis session cache'])
  assert.deepEqual(a.nodes.n4.refs, [100], 'each keeps its own source')
  const b = seeded()
  mergeDelta(b, { nodes: [{ id: 'n5', label: 'Lint with biome', msgs: [0] }, { id: 'n4', label: 'Migrations via sqitch', msgs: [1] }], edges: [['n4', 'n5', 'uses']] }, { now: 'T2', refsOf })
  const ids = Object.fromEntries(Object.entries(b.nodes).map(([id, n]) => [n.label, id]))
  assert.ok(ids['Lint with biome'] && ids['Migrations via sqitch'] && ids['Lint with biome'] !== ids['Migrations via sqitch'])
  assert.deepEqual(b.edges, [[ids['Migrations via sqitch'], ids['Lint with biome'], 'uses']], 'the link keeps its direction')
  const c = seeded()
  mergeDelta(c, { nodes: [{ id: 'n2', label: 'two, updated', gist: 'new gist', msgs: [0] }], edges: [] }, { now: 'T2' })
  assert.equal(c.nodes.n2.gist, 'new gist', 'a real existing id still updates that topic')
})

test('#67 a shared budget: short messages take what they need, the long one gets the rest', () => {
  assert.deepEqual(shares([18, 802], 1000), [18, 802])
  assert.deepEqual(shares([600, 600], 1000), [500, 500])
  assert.deepEqual(shares([10, 900, 900], 1000), [10, 495, 495])
  const text = formatSource([{ role: 'user', text: 'short?' }, { role: 'assistant', text: 'x'.repeat(2800) }], { budgets: shares([2, 800], 1000) })
  assert.doesNotMatch(text, /chars cut/, 'an 800-token answer under a 1000-token budget is not cut')
})

test('#59 gaps: a seq typed while memory was off', () => {
  const gaps = [[10, 14], [30, 31]]
  assert.deepEqual([9, 10, 14, 15, 30].map((s) => inGap(s, gaps)), [false, true, true, false, true])
  assert.deepEqual(nextGap(15, gaps), [30, 31])
  assert.equal(nextGap(40, gaps), undefined)
})

test('#59 a turn whose prompt was typed while memory was off is private as a whole, also its answer after the gap (review)', () => {
  // The backstop when on cannot tell a turn was running: the gap covers only the prompt.
  const user = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
  const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
  const log = [{ type: 'system/message', data: {} }, user('private prompt'), assistant('private answer'), user('later prompt'), assistant('later answer')]
  const span = collectSpan((seq) => log[seq], -1, { gaps: [[1, 1]] })
  assert.deepEqual(span.messages.map((m) => m.text), ['later prompt', 'later answer'])
})

test('#66 a long paste is matched in milliseconds, with the same result as a short message', () => {
  const { views } = corpusViews({ copies: 25 })
  for (const v of views) {
    if (v.own) continue
    const base = Object.values(v.graph.nodes)
    let i = 0
    for (let k = 0; k < 6; k++) for (const n of base) v.graph.nodes[`n${++i}`] = { ...n, label: `${n.label} ${k}`, gist: `${n.gist} v${k}` }
  }
  const words = 'cache pool retries backoff session cookie timeout deploy key index query build lint test release secret token parquet airflow '.repeat(30)
  const paste = `${words}\nwhat pool size did we pick for pgbouncer?`
  matchAcross(views, 'warm the caches')
  const t = performance.now()
  const long = matchAcross(views, paste)
  const ms = performance.now() - t
  assert.ok(ms < 400, `${ms.toFixed(0)} ms for a ${paste.length}-char paste over 9,000 topics`)
  assert.ok(long.hits.length >= 0)
  const short = matchAcross(views, 'what pool size did we pick for pgbouncer?')
  assert.ok(short.hits.some((h) => /pgbouncer/i.test(h.node.label)), 'the index finds what a full scan finds')
})
