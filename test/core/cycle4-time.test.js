/**
 * Cycle 4 (v0.10.0): time words in a message, pure. Each test fails without its fix; the issue
 * number is in the name. Days are built from local dates, so the suite holds in every zone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asksAboutPast, day, emptyGraph, matchAcross, mergeDelta, parseTimeRange } from '../../src/core/index.js'

const NOW = new Date(2026, 10, 17, 15) // Tuesday 2026-11-17, 15:00 local
const span = (text) => {
  const r = parseTimeRange(text, NOW)
  return r && `${day(r.from)}..${day(r.to)}`
}

test('#80 an everyday plan with a time word and "we" is not a question about the past', () => {
  for (const s of [
    'what should we do tonight?', 'should we try the new thai place today?', 'how do we use a french press? I want coffee this morning',
    'this month we pick a new car, sedan or SUV?', 'today we write the release notes', 'can we fix the bike this week?',
    'we talked to the landlord yesterday, can you draft a polite follow-up email?', 'yesterday we tried a new running route, how far is 5k?',
    '今天我们要讨论的是周末去哪玩', '今天我们想讨论的是周末去哪玩', '明天我们打算定的旅行路线', '这周我们准备讨论的话题'
  ]) assert.equal(asksAboutPast(s), false, s)
  for (const s of [
    'remind me what we decided yesterday', 'what we talked about this morning?', 'the port we picked last week?', 'how we fixed the login bug yesterday',
    "let's pick up where we left off yesterday", 'what did we do today?', 'did we fix the login bug yesterday?', 'yesterday you said to use pnpm',
    '今天我们讨论的方案是什么', '昨天我们定了哪个端口', '昨天我们主要讨论了部署', '之前我们定的端口是多少'
  ]) assert.equal(asksAboutPast(s), true, s)
})

test('#84 more ways to name a past day, in English and Chinese', () => {
  const expected = {
    'what did we decide two days ago?': '2026-11-15..2026-11-16',
    'what did we decide last night?': '2026-11-16..2026-11-17',
    'what did we do on monday?': '2026-11-16..2026-11-17',
    'what did we do on tuesday?': '2026-11-10..2026-11-11',
    'last sunday we talked about it': '2026-11-15..2026-11-16',
    'what did we decide on nov 3?': '2026-11-03..2026-11-04',
    'what did we settle on November 3rd?': '2026-11-03..2026-11-04',
    'the dec 3 release': '2025-12-03..2025-12-04',
    'Nov. 3, 2025': '2025-11-03..2025-11-04',
    // A week ago is the calendar week it falls in, like "last week".
    'what did we fix a week ago?': '2026-11-09..2026-11-16',
    'what did we change 2 weeks ago?': '2026-11-02..2026-11-09',
    'on monday last week': '2026-11-09..2026-11-16',
    三天前我们定了什么: '2026-11-14..2026-11-15',
    两天前讨论的方案: '2026-11-15..2026-11-16',
    一周前定的端口: '2026-11-09..2026-11-16',
    两个礼拜前的结论: '2026-11-02..2026-11-09',
    大前天我们聊了什么: '2026-11-14..2026-11-15',
    上上周我们决定了什么: '2026-11-02..2026-11-09',
    上上个月的账单: '2026-09-01..2026-10-01',
    // Unchanged.
    前天我们聊了什么: '2026-11-15..2026-11-16',
    '3天前我们定了什么': '2026-11-14..2026-11-15',
    上周的结论: '2026-11-09..2026-11-16',
    'what did we decide yesterday, we decided 3 options': '2026-11-16..2026-11-17'
  }
  for (const [text, want] of Object.entries(expected)) assert.equal(span(text), want, text)
  assert.equal(parseTimeRange('what did we decide two days ago?', NOW).label, '2 days ago')
  assert.equal(parseTimeRange('大前天', NOW).label, '3 days ago')
  assert.equal(parseTimeRange('上上周', NOW).label, '2 weeks ago')
  // Whole local days, also across a daylight-saving change (Los Angeles on Nov 1, Auckland on Sep 27).
  for (const text of ['three weeks ago', '上上个月']) {
    const r = parseTimeRange(text, NOW)
    assert.deepEqual([r.from.getHours(), r.to.getHours()], [0, 0], text)
  }
})

test('#84 a word that only looks like a time names no day', () => {
  for (const s of [
    'may I ask a question', 'one day I want to visit japan', 'the march of progress', 'a few more tests please', '一天到晚都在改bug',
    'we decided 3 things, which matters most?', 'the decision 2 of the list looks wrong', 'add a junior 2 role to the team page',
    'the market 5 years out looks bad', 'separate 2 concerns in this module', 'mark 3 items as done', 'novel 2 is better than the first',
    'can you summarize markdown 2 files', 'the march 2026 release', 'feb 30', 'what do we do on mondays?'
  ]) assert.equal(parseTimeRange(s, NOW), undefined, s)
  assert.notEqual(parseTimeRange('二十天前', NOW)?.label, '10 days ago', '二十天前 is not 十天前')
})

test('#84 a newly understood time still only orders hits: an exact older match is not hidden', () => {
  const old = emptyGraph()
  mergeDelta(old, { nodes: [{ label: 'tunnel timeout', gist: '524 from the free tunnel after 120s', aliases: ['524', 'cloudflare'], msgs: [0] }], edges: [] }, { now: new Date(2026, 9, 20, 9).toISOString() })
  const recent = emptyGraph()
  mergeDelta(recent, { nodes: [{ label: 'release notes draft', gist: 'changelog for 0.10', aliases: [], msgs: [0] }], edges: [] }, { now: new Date(2026, 10, 15, 9).toISOString() })
  const views = [
    { sid: 'sOld', cid: 1, own: false, meta: { cid: 1, startedAt: new Date(2026, 9, 20, 8).toISOString(), lastActiveAt: new Date(2026, 9, 20, 10).toISOString() }, graph: old },
    { sid: 'sNew', cid: 2, own: false, meta: { cid: 2, startedAt: new Date(2026, 10, 15, 8).toISOString(), lastActiveAt: new Date(2026, 10, 15, 10).toISOString() }, graph: recent }
  ]
  for (const q of ['the 524 tunnel problem from two days ago', 'the 524 tunnel problem on sunday', 'the 524 tunnel problem 大前天']) {
    const range = parseTimeRange(q, NOW)
    assert.ok(range, q)
    assert.deepEqual(matchAcross(views, q, { range }).hits.map((h) => h.id), ['c1n1'], q)
  }
})
