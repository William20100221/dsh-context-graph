/**
 * Regression tests for the second, focused review of the cycle-2 (v0.8.0) fixes: the pure core.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asksAboutPast, chatSummary, clipTokens, emptyGraph, matchAcross, mergeDelta, searchUnits } from '../../src/core/index.js'
import { capText } from '../../src/store/messages.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'

const summary = (r) => r.hits.map((h) => `${h.id}:${h.raw}`).join(' ') + (r.lead ? ` lead ${r.lead.id}` : '')
const view = (cid, label, gist, aliases = [], at = '2026-11-01T00:00:00Z') => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label, gist, aliases, msgs: [0] }], edges: [] }, { now: at })
  return { sid: `s${cid}`, cid, meta: { cid }, graph, own: false }
}

test('a word counted once does not count again inside a longer word, in either order (second review)', () => {
  const { views } = corpusViews()
  for (const [a, b] of [['测试和单元测试的区别是什么', '单元测试和测试的区别是什么'], ['缓存和前缀缓存有什么不同', '前缀缓存和缓存有什么不同'], ['数据仓库和数据库的区别', '数据库和数据仓库的区别']]) {
    assert.equal(summary(matchAcross(views, a)), summary(matchAcross(views, b)), `${a} | ${b}`)
  }
  assert.equal(matchAcross(views, '测试和单元测试的区别是什么').lead, undefined, 'two words, like "tests and unit tests"')
  assert.deepEqual(matchAcross(views, '数据和数据库有什么区别').hits, [], '数据 inside 数据库 is not a second word')
})

test('a katakana or Hangul word is one word, however long (second review)', () => {
  const v = [view(1, 'データベース移行', 'PostgreSQLへの移行手順'), view(2, '데이터베이스 이전', 'PostgreSQL로 이전')]
  assert.deepEqual(matchAcross(v, 'データベースのおすすめは？').hits, [])
  assert.deepEqual(matchAcross(v, '데이터베이스 추천해 줘').hits, [])
  assert.equal(searchUnits('データベース移行').length, 2, 'the katakana word and the kanji word are separate')
})

test('a path or identifier before the question does not weaken the question\'s words; a/b words are plain (second review)', () => {
  const { views } = corpusViews()
  const pairs = [
    ['src/auth/session.ts sets the session cookie wrong', 'the session cookie set in src/auth/session.ts is wrong'],
    ['pgbouncer/pgbouncer.ini says pool_mode=transaction; what pool size did we pick?', 'what pool size did we pick? pgbouncer/pgbouncer.ini says pool_mode=transaction']
  ]
  for (const [a, b] of pairs) assert.equal(summary(matchAcross(views, a)), summary(matchAcross(views, b)), a)
  assert.ok(matchAcross(views, 'src/auth/session.ts sets the session cookie wrong').hits.length > 0)
  assert.equal(summary(matchAcross(views, 'the CI/CD cache keeps missing')), summary(matchAcross(views, 'the ci cache keeps missing')))
  assert.deepEqual(searchUnits('read/write').map((u) => u.code), [false])
  assert.deepEqual(searchUnits('src/core/match.js api/v1').map((u) => u.code), [true, true])
})

test('the newest copy speaks for a subject even when it would not pass the gate alone; digits and "not" make text differ (second review)', () => {
  const old = view(1, 'PgBouncer pool size', 'pool size 20 per app instance', ['pgbouncer'], '2026-09-01T00:00:00Z')
  const newer = view(7, 'PgBouncer pool size', 'raised to 40 after the load test', ['pgbouncer'], '2026-11-10T00:00:00Z')
  assert.equal(matchAcross([old, newer], 'is pgbouncer still at 20 per app instance?').hits[0]?.id, 'c7n1')
  const r3 = view(1, 'Task retries', 'retries 3 with backoff', ['retries'], '2026-09-01T00:00:00Z')
  const r5 = view(2, 'Task retries', 'retries 5 with backoff', ['retries'], '2026-11-01T00:00:00Z')
  assert.equal(matchAcross([r3, r5], 'how many task retries with backoff?', { skip: new Set(['c1n1']) }).hits[0]?.id, 'c2n1', '5 is not 3')
  const off = view(1, 'Prepared statements', 'prepared statements are disabled', [], '2026-09-01T00:00:00Z')
  const on = view(2, 'Prepared statements', 'prepared statements are not disabled', [], '2026-11-01T00:00:00Z')
  assert.equal(matchAcross([off, on], 'are prepared statements disabled?', { skip: new Set(['c1n1']) }).hits[0]?.id, 'c2n1', '"not" counts')
  const py = [view(1, 'Python 2 support', 'kept until 4.x', [], '2026-09-01T00:00:00Z'), view(2, 'Python 3 support', 'required from 5.0', [], '2026-11-01T00:00:00Z')]
  assert.deepEqual(matchAcross(py, 'do we still have python 2 support?').hits.map((h) => h.id).sort(), ['c1n1', 'c2n1'], 'two subjects')
})

test('on equal evidence the topic the message names exactly comes first, and neither is a lead (second review)', () => {
  const v = [view(1, 'Redis session store', 'sessions live in redis db 2', [], '2026-10-01T00:00:00Z'), view(2, 'Redis session store load test', 'held 5k rps', [], '2026-11-01T00:00:00Z')]
  const r = matchAcross(v, 'how does the redis session store work?')
  assert.deepEqual(r.hits.map((h) => h.id), ['c1n1', 'c2n1'])
  assert.equal(r.lead, undefined)
})

test('when slots run out, evidence decides who gets one; a named time and the label fit only order (second review)', () => {
  // raw 4 with half its label matched, against raw 3 (+1 for yesterday) with all of its label matched.
  const old = view(1, 'PgBouncer pool sizing guide', '20 connections per app instance', [], '2026-09-01T00:00:00Z')
  const recent = view(2, 'PgBouncer', 'Grafana panel graphs pool size', [], new Date(2026, 10, 15, 10).toISOString())
  const yesterday = { from: new Date(2026, 10, 15), to: new Date(2026, 10, 16), label: 'yesterday' }
  const both = matchAcross([old, recent], 'what pool size did we set for pgbouncer yesterday?', { range: yesterday }).hits
  assert.deepEqual(both.map((h) => [h.id, h.raw]).sort(), [['c1n1', 4], ['c2n1', 3]])
  const one = matchAcross([old, recent], 'what pool size did we set for pgbouncer yesterday?', { max: 1, range: yesterday })
  assert.equal(one.hits[0]?.id, 'c1n1', 'the stronger evidence keeps the only slot')
})

test('a lead must be ahead of every candidate, also one the slot cap left out (second review)', () => {
  const v = [view(1, 'Redis session store', 'sessions in redis', [], '2026-10-01T00:00:00Z'), view(2, 'Redis session store failover', 'sentinel failover', [], '2026-11-01T00:00:00Z')]
  const r = matchAcross(v, 'how does the redis session store work?', { max: 1 })
  assert.equal(r.hits.length, 1)
  assert.equal(r.lead, undefined, 'an equal candidate exists')
})

test('a day digest needs "we" or "you": everyday sentences with past words do not get one (second review)', () => {
  for (const s of ['today was the last time I smoked', '今天和朋友聊过一部电影，叫什么来着', "did we win yesterday's game?", 'recap the news from today']) assert.equal(asksAboutPast(s), false, s)
  for (const s of ['did we fix the login bug yesterday?', 'last time we talked about the deploy', 'yesterday you said to use pnpm', '上次聊了什么']) assert.equal(asksAboutPast(s), true, s)
})

test('no cut leaves half of an emoji or rare character (second review)', () => {
  const emoji = '😀'.repeat(3000)
  assert.ok(clipTokens(emoji, 100).isWellFormed())
  assert.ok(clipTokens(`a${emoji}`, 101).isWellFormed())
  assert.ok(capText(`x${emoji}`).isWellFormed())
  assert.ok(chatSummary({ meta: { summary: `x${'𠮷'.repeat(100)}` }, graph: { nodes: {} } }).isWellFormed())
  const g = emptyGraph()
  mergeDelta(g, { nodes: [{ label: `a${'😀'.repeat(60)}`, msgs: [0] }], edges: [] }, { now: 'T' })
  assert.ok(g.nodes.n1.label.isWellFormed())
})
