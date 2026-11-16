/**
 * The savings estimate (#35): its terms, what counts as used, and the card's wording.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WEIGHTS, addCounters, approx, balance, counters, emptyCounters, estimateTokens, savingsDetail, savingsLine, standIn, storedTokens, usedIn } from '../../src/core/index.js'
import { capText } from '../../src/store/messages.js'

test('the balance weighs cached input and output, and shows a loss as a loss', () => {
  const c = { ...emptyCounters(), sent: 100, recalled: 50, resent: 1000, tool: 500, indexIn: 400, indexCached: 200, indexOut: 30, stoodIn: 2000, used: 2 }
  const expected = 100 + 50 + 400 + WEIGHTS.cached * (1000 + 500 + 200) + WEIGHTS.output * 30
  assert.deepEqual(balance(c), { cost: Math.round(expected), saved: 2000, net: Math.round(2000 - expected) })
  assert.ok(balance({ ...c, stoodIn: 0 }).net < 0)
})

test('counters read safely and add up', () => {
  assert.deepEqual(counters({ sent: '12', resent: -3, tool: 'x', extra: 9 }), { ...emptyCounters(), sent: 12 })
  assert.equal(addCounters({ ...emptyCounters(), sent: 2 }, { ...emptyCounters(), sent: 3 }).sent, 5)
})

test('a stored message counts as stored: a long one by its kept head and tail, never more (second review: errs low)', () => {
  for (const long of ['The deploy key is rotated yearly. '.repeat(1000), '数据库连接池的大小设为二十。'.repeat(1500)]) {
    const stored = capText(long)
    assert.ok(storedTokens(stored) < estimateTokens(long) / 2, 'far below the original')
    assert.equal(storedTokens(stored), estimateTokens(stored.replace(/…\[\d+ chars omitted[^\]]*\]…/, '')))
  }
  assert.equal(storedTokens('short'), 2)
})

test('an answer that only repeats the question did not use the topic; one that brings its facts did (review)', () => {
  const node = { label: 'commit signing', aliases: ['gpg'], gist: 'signed with id_ed25519_signing' }
  const prompt = 'is commit signing set up?'
  assert.equal(usedIn("I don't know whether commit signing is set up here. Can you share your git config?", node, prompt), false)
  assert.equal(usedIn('Commits are signed with id_ed25519_signing.', node, prompt), true, 'an identifier from its gist')
  assert.equal(usedIn('Yes: gpg, and every commit is signed.', node, prompt), true, 'two of its words the prompt did not bring')
})

test('used counts words as matching does: one Chinese word, an abbreviation or a number is not enough (second review)', () => {
  const zh = { label: '服务器部署流程', aliases: [], gist: '' }
  assert.equal(usedIn('我不了解你们服务器的情况，你们用的是什么平台？', zh, '我们的部署流程是怎样的？'), false, '服务器 is one word')
  assert.equal(usedIn('服务器按照部署流程上线。', zh, ''), true)
  assert.equal(usedIn('See e.g. the docs.', { label: 'connection pool', aliases: [], gist: 'e.g. 2.5 connections' }, ''), false, 'e.g. alone')
})

test('a source message stands in once, however many topics cite it, and a topic for its newest three at most (review)', () => {
  const stored = { 3: { x: 'a'.repeat(350) }, 4: { x: 'b'.repeat(35) } }
  const credited = new Set()
  const both = standIn({ refs: [3, 4, 3] }, stored, 2, credited)
  assert.equal(both.tokens, storedTokens(stored[3].x) + storedTokens(stored[4].x))
  for (const key of both.keys) credited.add(key)
  assert.deepEqual(standIn({ refs: [3] }, stored, 2, credited), { tokens: 0, keys: [] })
  assert.equal(standIn({ refs: [3] }, stored, 5, credited).tokens, storedTokens(stored[3].x), 'seq 3 of another chat is another message')
  const many = Object.fromEntries(Array.from({ length: 16 }, (_, i) => [i, { x: 'x'.repeat(3500) }]))
  const bounded = standIn({ refs: Object.keys(many).map(Number) }, many, 9, new Set())
  assert.deepEqual(bounded.keys, ['9:15', '9:14', '9:13'], 'the newest three')
})

test('an answer used a topic when it repeats two of its label words, or one identifier', () => {
  const node = { label: 'PgBouncer connection pool', aliases: ['pgbouncer'], gist: 'pool size 20' }
  assert.equal(usedIn('We set the PgBouncer pool to 20 connections.', node), true)
  assert.equal(usedIn('The pool is fine.', node), false)
  assert.equal(usedIn('See pnpm-lock.yaml for it.', { label: 'pnpm-lock.yaml cache key', aliases: [], gist: '' }), true)
})

test('the card says what memory did, rounded, and never hides a loss', () => {
  const none = emptyCounters()
  assert.equal(savingsLine(none, none), 'Savings: nothing measured yet')
  const good = { ...none, sent: 120, stoodIn: 8600, used: 2 }
  assert.equal(savingsLine(good, good), 'Savings (estimate): saved about 8,500 tokens in this chat · saved about 8,500 tokens in this workspace')
  const bad = { ...none, sent: 1240, tool: 300 }
  assert.match(savingsLine(bad, good), /^Savings \(estimate\): cost about 1,300 tokens more than it saved in this chat · saved about 8,500 tokens in this workspace$/)
  assert.match(savingsLine(none, good), /nothing yet in this chat/)
  assert.equal(approx(123456), '123,000')
  assert.match(savingsDetail(good), /stood in for: 8600 \(2 topics used[\s\S]*memory cost: 120 = notes sent 120/)
})

test('used: a new Chinese word next to the prompt\'s words counts once; a source kept whole counts as cut (third review)', () => {
  const zh = { label: '服务器部署流程', aliases: [], gist: '' }
  assert.equal(usedIn('我不清楚你们的服务器部署流程。', zh, '部署流程是怎样的？'), false, 'only 服务器 is new')
  const migrated = 'The CI log line repeats. '.repeat(1600)
  assert.equal(storedTokens(migrated), storedTokens(capText(migrated)), 'a v0.4-v0.6 source kept whole')
})
