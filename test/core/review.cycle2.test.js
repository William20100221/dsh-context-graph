/**
 * Regression tests for the independent review of the cycle-2 (v0.8.0) change: the pure core.
 * Each test fails on the code the review was run against.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asksAboutPast, clipTokens, emptyGraph, estimateTokens, matchAcross, mergeDelta, parseTimeRange } from '../../src/core/index.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'

const ids = (r) => r.hits.map((h) => h.id)
const view = (cid, nodes, meta = {}) => {
  const graph = emptyGraph()
  for (const [n, at] of nodes) mergeDelta(graph, { nodes: [n], edges: n.edges ?? [] }, { now: at })
  return { sid: `s${cid}`, cid, meta: { cid, ...meta }, graph, own: false }
}

test('one Chinese word is one word of evidence, as in English (review)', () => {
  const { views } = corpusViews()
  for (const [zh, en] of [['推荐一本数据库入门书', 'recommend a database book'], ['服务器的数据库备份用什么软件好', 'what software should I use for server database backup'], ['怎么给我的 Python 项目写单元测试', 'how do I write unit tests for my python project']]) {
    const a = matchAcross(views, zh)
    const b = matchAcross(views, en)
    assert.deepEqual(ids(a), ids(b), `${zh} | ${en}`)
    assert.equal(a.lead, undefined, `${zh}: one shared word does not make a lead`)
  }
  assert.deepEqual(ids(matchAcross(views, '推荐一本数据库入门书')), [], '数据库 alone is one label word: below the floor')
})

test('a compound counts once when the topic has it, its parts count when the topic has them apart (review)', () => {
  const v = [view(1, [[{ label: 'Memory opt-out switch', gist: 'opt-out keeps one chat out', aliases: [], msgs: [0] }, 'T']]),
    view(2, [[{ label: 'SSH signing key', gist: 'restore tested monthly from the backup', aliases: ['id_ed25519_signing'], msgs: [0] }, 'T']])]
  assert.deepEqual(ids(matchAcross(v, 'can I opt-out of the newsletter?')), [], '"opt-out" is one word')
  assert.deepEqual(ids(matchAcross(v, 'is id_ed25519_signing still used?')), ['c2n1'], 'an exact identifier is strong evidence')
  assert.equal(matchAcross(v, 'signing key restore-tested?').hits[0]?.raw, 5, 'restore-tested: two gist words')
  const { views } = corpusViews()
  const traceback = 'Traceback (most recent call last):\n  File "/home/me/proj/runner.py", line 41\n    runner.run(config)\n    self._resp = requests.get(self.url, timeout=5)\nrequests.exceptions.ConnectTimeout: HTTPSConnectionPool(host=\'api.example.com\', port=443)\nwhy does my scraper time out?'
  assert.deepEqual(ids(matchAcross(views, traceback)), [], 'parts of code in a paste are weak evidence')
})

test('the newest copy of a subject is the one shown; find lists every copy (review of #43)', () => {
  const old = view(1, [[{ label: 'PgBouncer pool size', gist: 'pool size 20 per app instance', aliases: ['pgbouncer'], msgs: [0] }, '2026-09-01T00:00:00Z']])
  const now = view(7, [[{ label: 'PgBouncer pool size', gist: 'raised to 40 after the load test', aliases: ['pgbouncer'], msgs: [0] }, '2026-11-10T00:00:00Z']])
  const result = matchAcross([old, now], 'what pool size per app instance did we pick for pgbouncer?')
  assert.deepEqual(ids(result), ['c7n1'], 'the newer decision speaks for the subject')
  assert.deepEqual(result.hits[0].ids.sort(), ['c1n1', 'c7n1'])
  assert.deepEqual(ids(matchAcross([old, now], 'pgbouncer pool', { floor: 2, cover: false, collapse: false })).sort(), ['c1n1', 'c7n1'], 'find shows both')
})

test('a replacement or a changed copy of a shown topic is sent; an identical copy is not (review of #23)', () => {
  const chat = view(1, [[{ label: 'commit signing with gpg key', gist: 'gpg key signs commits', aliases: ['gpg'], msgs: [0] }, '2026-11-01T00:00:00Z']])
  mergeDelta(chat.graph, { nodes: [{ label: 'commit signing with ssh key', gist: 'ssh key signs commits now', aliases: ['ssh'], msgs: [1] }], edges: [['commit signing with ssh key', 'n1', 'supersedes']] }, { now: '2026-11-05T00:00:00Z' })
  const replaced = matchAcross([chat], 'gpg commit signing: how are commits signed now?', { skip: new Set(['c1n1']) })
  assert.deepEqual(ids(replaced), ['c1n2'])
  assert.equal(replaced.hits[0].via, 'c1n1')
  const a = view(1, [[{ label: 'Deploy process', gist: 'deploys to fly.io', aliases: ['deploy'], msgs: [0] }, '2026-11-01T00:00:00Z']])
  const b = view(2, [[{ label: 'Deploy process', gist: 'moved off fly.io: kubernetes via helm upgrade', aliases: ['deploy'], msgs: [0] }, '2026-11-09T00:00:00Z']])
  const same = view(3, [[{ label: 'Deploy process', gist: 'deploys to fly.io', aliases: ['deploy'], msgs: [0] }, '2026-11-09T00:00:00Z']])
  assert.deepEqual(ids(matchAcross([a, b], 'how does the deploy process work?', { skip: new Set(['c1n1']) })), ['c2n1'], 'it says something new')
  assert.deepEqual(ids(matchAcross([a, same], 'how does the deploy process work?', { skip: new Set(['c1n1']) })), [], 'it says the same thing')
})

test('a named time reorders the chosen hits; it never drops an exact older match (review of #24)', () => {
  const now = new Date(2026, 10, 16, 12)
  // raw 4 (two label words) against raw 3 + 1 for yesterday: a tie the recent topic wins on rarity.
  const old = view(1, [[{ label: 'PgBouncer pool', gist: '20 connections per app instance', aliases: [], msgs: [0] }, '2026-09-01T00:00:00Z']])
  const recent = view(2, [[{ label: 'PgBouncer metrics dashboard', gist: 'Grafana panel graphs pool size and waiting clients', aliases: [], msgs: [0] }, new Date(2026, 10, 15, 10).toISOString()]])
  const plain = ids(matchAcross([old, recent], 'what pool size did we set for pgbouncer?'))
  const dated = ids(matchAcross([old, recent], 'what pool size did we set for pgbouncer yesterday?', { range: parseTimeRange('yesterday', now) }))
  assert.ok(plain.includes('c1n1') && dated.includes('c1n1'), `${plain} / ${dated}`)
})

test('a shown hit leaves its slot empty even when a weaker topic would pass the floor (review of #23)', () => {
  const { views } = corpusViews()
  const prompt = 'which node versions does our test matrix run on?'
  assert.ok(matchAcross(views, prompt, { max: 9, cover: false }).hits.length > 1, 'a weaker topic exists')
  assert.deepEqual(ids(matchAcross(views, prompt, { skip: new Set(['c1n2']) })), [])
})

test('clipTokens keeps to its budget whatever the mix of scripts (review)', () => {
  for (const text of ['中'.repeat(3000) + 'x'.repeat(60000), 'x'.repeat(60000) + '中'.repeat(3000), '中'.repeat(9000), 'x'.repeat(9000)]) {
    const out = clipTokens(text, 700, 'more')
    assert.ok(estimateTokens(out) <= 710, `${estimateTokens(out)} tokens`)
    assert.match(out, /…\[\d+ chars cut; more\]…/)
  }
})

test('only questions about shared earlier work get a day digest (review of #24)', () => {
  for (const s of ['what did we do today?', '昨天说的那个超时', '上次聊了什么', 'where were we last week?', '之前我们定的端口是多少']) assert.equal(asksAboutPast(s), true, s)
  for (const s of ['今天做了红烧肉，剩菜怎么保存', '帮我总结一下今天的新闻', 'I woke up earlier than usual today', 'before lunch today I want to learn rust', 'remind me to buy milk tomorrow', "what was the score of yesterday's game?", '我昨天决定去学游泳', '昨天看的电影里提到的歌叫什么']) assert.equal(asksAboutPast(s), false, s)
})
