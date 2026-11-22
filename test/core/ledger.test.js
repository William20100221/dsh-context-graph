/**
 * The savings estimate (#35, #104): its terms, what counts as used, and the card's wording.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { WEIGHTS, addCounters, approx, balance, counters, emptyCounters, estimateTokens, historyTokens, savingsDetail, savingsLine, standInChat, usedIn } from '../../src/core/index.js'

test('saved = old total - memory making - searching, cached input and output weighed, a loss shown as a loss (#104)', () => {
  const c = { ...emptyCounters(), sent: 100, recalled: 50, resent: 1000, tool: 500, indexIn: 400, indexCached: 200, indexOut: 30, history: 20000, used: 2 }
  const making = 400 + WEIGHTS.cached * 200 + WEIGHTS.output * 30
  const searching = 100 + 50 + WEIGHTS.cached * (1000 + 500)
  assert.deepEqual(balance(c), { history: 20000, making: Math.round(making), searching: Math.round(searching), cost: Math.round(making + searching), saved: 20000, net: Math.round(20000 - making - searching) })
  assert.ok(balance({ ...c, history: 0 }).net < 0)
  assert.equal(counters({ stoodIn: 500 }).history, 0, 'the stand-in of 0.16 and before is not an old total')
})

test('counters read safely and add up', () => {
  assert.deepEqual(counters({ sent: '12', resent: -3, tool: 'x', extra: 9 }), { ...emptyCounters(), sent: 12 })
  assert.equal(addCounters({ ...emptyCounters(), sent: 2 }, { ...emptyCounters(), sent: 3 }).sent, 5)
})

test('the old total of a chat is its whole kept conversation (#104)', () => {
  const long = 'The deploy key is rotated yearly. '.repeat(1000)
  assert.equal(historyTokens({ 1: { x: long }, 2: { x: '数据库连接池的大小设为二十。' }, 3: { r: 'user' } }), estimateTokens(long) + estimateTokens('数据库连接池的大小设为二十。'), 'every message whole')
  assert.equal(historyTokens({}), 0)
  assert.equal(historyTokens(undefined), 0)
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

test('an earlier chat stands in once per chat that used it, however many of its topics were used (#104)', () => {
  const stored = { 3: { x: 'a'.repeat(350) }, 4: { x: 'b'.repeat(35) } }
  const credited = new Set()
  const first = standInChat(stored, 2, credited)
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { tokens: historyTokens(stored), keys: ['c2'] })
  for (const key of first.keys) credited.add(key)
  assert.deepEqual(JSON.parse(JSON.stringify(standInChat(stored, 2, credited))), { tokens: 0, keys: [] }, 'chat 2 counted already')
  assert.equal(standInChat(stored, 5, credited).tokens, historyTokens(stored), 'another chat is another history')
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
  const good = { ...none, sent: 120, history: 8600, used: 2 }
  assert.equal(savingsLine(good, good), 'Savings (estimate): saved about 8,500 tokens in this chat · saved about 8,500 tokens in this workspace')
  const bad = { ...none, sent: 1240, tool: 300 }
  assert.match(savingsLine(bad, good), /^Savings \(estimate\): cost about 1,300 tokens more than it saved in this chat · saved about 8,500 tokens in this workspace$/)
  assert.match(savingsLine(none, good), /nothing yet in this chat/)
  assert.equal(approx(123456), '123,000')
  assert.match(savingsDetail(good), /saved = old total - making - searching = 8480\n- old total: 8600 \([^)]*2 topics used\)\n- memory making: 0 = indexing[^\n]*\n- searching: 120 = notes sent 120/)
})

test('used: a new Chinese word next to the prompt\'s words counts once (third review)', () => {
  const zh = { label: '服务器部署流程', aliases: [], gist: '' }
  assert.equal(usedIn('我不清楚你们的服务器部署流程。', zh, '部署流程是怎样的？'), false, 'only 服务器 is new')
})
