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
  const transcript = 'what we did there was the approach we tried and then the thing we used '.repeat(3000)
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

test('second review: a message\'s plural product word still finds a singular topic; a topic named Windows still meets no window', () => {
  const views = [
    view(1, 'Page title templates', 'every route sets its document title from one template'),
    view(2, 'Redux action naming', 'domain/eventName in past tense'),
    view(3, 'Team invite flow', 'owners send an email link that expires after 7 days'),
    view(4, 'Sheet export to CSV', 'one CSV per sheet, zipped'),
    view(5, 'Windows line endings', 'core.autocrlf false plus .gitattributes eol=lf')
  ]
  for (const [q, want] of [['where do we set titles for the pages?', 'c1n1'], ['how should we name redux actions?', 'c2n1'], ['how do teams invite people?', 'c3n1'], ['can we export all sheets at once to csv?', 'c4n1']]) {
    assert.deepEqual(ids(matchAcross(views, q)), [want], q)
  }
  assert.deepEqual(ids(matchAcross(views, 'the modal window closes on escape, is that a bug in the line of code?')), [], 'window is not Windows')
})
