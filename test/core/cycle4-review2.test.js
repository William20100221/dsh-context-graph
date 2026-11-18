/**
 * Second review of cycle 4 (v0.10.0): time words and matching, pure. Each test fails without its
 * fix; the finding is in the name.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asksAboutPast, emptyGraph, matchAcross, mergeDelta, parseTimeRange, searchUnits } from '../../src/core/index.js'

const NOW = new Date(2026, 10, 17, 15) // Tuesday 2026-11-17, 15:00 local
const label = (text) => parseTimeRange(text, NOW)?.label
const ids = (r) => r.hits.map((h) => h.id)
const view = (cid, name, gist) => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label: name, gist, aliases: [], msgs: [0] }], edges: [] }, { now: '2026-11-01T00:00:00Z' })
  return { sid: `s${cid}`, cid, meta: { cid }, graph, own: false }
}

test('second review: "the X we did" asks about earlier work unless the clause says how it went', () => {
  for (const q of [
    'the bug we fixed yesterday is back',
    'the timeout we settled on yesterday was 60s, right?',
    'the port we picked last week was 8080 or 8081?',
    'the approach we tried yesterday looks wrong, why did it fail?',
    'the endpoint we decided on last week is returning 500s, why?',
    'the config we changed yesterday, show it to me',
    'the port we picked last week, what was it',
    'the fix we did yesterday is broken',
    'the migration we wrote yesterday is failing on prod, can you look?',
    'what we decided yesterday is wrong, can you recap it?'
  ]) assert.equal(asksAboutPast(q), true, q)
  for (const q of [
    'the restaurant we tried last night was amazing, find me a similar one',
    'the hotel we picked two days ago cancelled',
    'the hike we did on saturday was steep',
    'the gift we chose on monday arrived broken, write a return request'
  ]) assert.equal(asksAboutPast(q), false, q)
})

test('second review: a pasted transcript with no punctuation is read in linear time', () => {
  // Clauses all the way, and a story phrase only at the end: an unbounded look ahead would scan to it from every clause.
  const transcript = `${'what we did there was the approach we tried and then the thing we used '.repeat(1000)}and it was amazing`
  const started = performance.now()
  asksAboutPast(transcript)
  assert.ok(performance.now() - started < 60, `${Math.round(performance.now() - started)} ms for ${transcript.length} characters`)
})

test('second review: N天前 followed by 端口, 后端 or 后台 is still N days ago; 前端 and 前后 are not', () => {
  assert.equal(label('3天前端口我们定的是多少？'), '3 days ago')
  assert.equal(label('3天前后端改了什么，我们讨论过吗'), '3 days ago')
  assert.equal(label('2天前后台权限我们定的方案是什么'), '2 days ago')
  for (const q of ['这两天前端一直报错，之前我们说的方案是什么？', '我学了三天前端', '三天前后会到']) assert.equal(label(q), undefined, q)
})

test('second review: "on <month> <day>" is the day asked about, whatever else the message names', () => {
  assert.equal(label("what did we decide on nov 10? I need it for today's standup"), '2026-11-10')
  assert.equal(label('what did we decide on nov 3? yesterday the build broke again'), '2026-11-03')
  assert.equal(label('what did we decide about the may 1 launch last week?'), 'last week')
})

test('second review: long lowerCamel identifiers up to 10 humps are code and find their topic', () => {
  assert.equal(searchUnits('shouldThrowExceptionWhenUserIsNull')[0].code, true)
  assert.equal(searchUnits('findAllByCustomerIdAndCreatedAtBetween')[0].code, true)
  const v = [view(1, 'Flaky shouldThrowExceptionWhenUserIsNull', 'the test races the user cache warm-up')]
  assert.deepEqual(ids(matchAcross(v, 'shouldThrowExceptionWhenUserIsNull is failing again on CI')), ['c1n1'])
})

test('third check: the plural of a product name stays whole in a message too, so "github actions" or "microsoft teams" meets no unrelated topic', () => {
  const views = [
    view(1, 'Undo action history', 'every edit is an action the history can undo'),
    view(2, 'Team notification settings', 'each team picks which notifications it gets'),
    view(3, 'Docs page layout', 'the sidebar and the page header'),
    view(4, 'Window resize handler', 'the layout reflows on resize, debounced')
  ]
  for (const q of ['github actions history only keeps 90 days of logs', 'send the build failures to microsoft teams as notifications', 'publish the docs to github pages', 'the layout breaks when I resize on windows']) {
    assert.deepEqual(ids(matchAcross(views, q)), [], q)
  }
})

test('third check: an upcoming "on <date>" gives way to the day asked about; a past one still wins', () => {
  const now = new Date(2026, 10, 19, 15)
  assert.equal(parseTimeRange('what did we decide yesterday about the launch on dec 3?', now)?.label, 'yesterday')
  assert.equal(parseTimeRange('remind me what we decided last week for the migration on nov 30', now)?.label, 'last week')
  assert.equal(parseTimeRange("what did we decide on nov 10? I need it for today's standup", now)?.label, '2026-11-10')
})

test('third check: a request that points back at earlier work asks about it; what developers say of their work is no story', () => {
  for (const q of ['the plan we agreed on yesterday, write it up as a spec', 'the migration we wrote yesterday, apply it to staging', 'the function we wrote yesterday needs tests, add them', 'the approach we picked yesterday was bad, what were the alternatives']) assert.equal(asksAboutPast(q), true, q)
  for (const q of ['the hotel we picked two days ago cancelled again', 'the hike we did on saturday still hurts my knees']) assert.equal(asksAboutPast(q), false, q)
})

test('third check: 这两天 or 连续两天 before 前后端 is a duration, not days ago', () => {
  for (const q of ['这两天前后端联调一直有问题，之前我们定的接口格式是什么？', '连续两天前后端都报错，我们之前讨论过吗', '花了三天前后端联调，上次说的方案是什么']) assert.equal(label(q), undefined, q)
  assert.equal(label('3天前后端改了什么，我们讨论过吗'), '3 days ago')
})

test('third check: a mixed-case random id with a digit is one plain word, a long identifier without one is code', () => {
  assert.equal(searchUnits('k3JdLx9QpRtVwYz2mNb')[0].code, false)
  assert.equal(searchUnits('findAllByCustomerIdAndCreatedAtBetween')[0].code, true)
})
