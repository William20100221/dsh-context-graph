/**
 * Review of cycle 4 (v0.10.0): time words in a message, pure. Each test fails without its fix; the
 * review's finding (K4, K5, K8) is in the name. Days are built from local dates, so the suite holds
 * in every zone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { asksAboutPast, day, parseTimeRange } from '../../src/core/index.js'

const NOW = new Date(2026, 10, 17, 15) // Tuesday 2026-11-17, 15:00 local
const span = (text) => {
  const r = parseTimeRange(text, NOW)
  return r && `${day(r.from)}..${day(r.to)}`
}

test('review K4: a story about something we did names a day but asks nothing of this memory', () => {
  for (const s of [
    'the restaurant we tried last night was amazing, find me a similar one', 'the gift we chose on monday arrived broken, write a return request',
    'the route we used on sunday was too steep, suggest an easier hike', 'the hotel we picked two days ago cancelled', 'the hotel we picked two days ago cancelled, draft a complaint',
    'the tent we used two weeks ago is torn, how do I patch it?', 'the wine we tried on nov 3 was great, what grape is it?',
    'what we did last night was crazy, write a funny poem about it', 'the cake we made on friday was too dry, what did I do wrong?',
    'the movie we picked on saturday was boring, recommend a better one', 'the restaurant we tried yesterday was amazing, find me a similar one'
  ]) {
    assert.ok(parseTimeRange(s, NOW), `${s}: names a day`)
    assert.equal(asksAboutPast(s), false, s)
  }
  // A question or a request about earlier work still counts, also when it reads like a story.
  // Known limit: "how we fixed the sink last night" reads like "how we fixed the login bug yesterday".
  for (const s of [
    'the port we picked last week?', 'the port we picked last week, what was it?', 'the approach we tried yesterday, did it work?',
    'show me the config we changed last night', 'summarize what we decided on monday', 'tell me what we did yesterday', 'list the options we discussed yesterday',
    'the fix we tried last night did not work, any other idea?', 'what did I do yesterday?'
  ]) assert.equal(asksAboutPast(s), true, s)
})

test('review K5: 会话, 会议, 开会 and 想法 between 我们 and the verb are no plan, so the question counts', () => {
  for (const s of [
    '昨天我们在另一个会话里聊的内容是什么', '我们昨天在那个会话里说的方案是哪个', '前天我们在会话中谈的结论', '我们这周在会话里定了哪些事',
    '昨天我们开会讨论的上线时间是几点', '我们昨天在会议上说的', '上周我们在上一个会话里决定的缓存方案', '昨天我们的想法讨论了吗'
  ]) assert.equal(asksAboutPast(s), true, s)
  // A plan still is no question about the past (#80).
  for (const s of ['今天我们要讨论的是周末去哪玩', '今天我们想讨论的是周末去哪玩', '明天我们打算定的旅行路线', '我们明天会讨论的事']) assert.equal(asksAboutPast(s), false, s)
})

test('review K8: 两天前端, 三天前后 and 1.5 weeks ago name no day; a day named from today beats a month date', () => {
  for (const s of ['这两天前端一直报错，之前我们说的方案是什么？', '我学了三天前端', '一周前端开发计划', '三天前后会到', 'what did we change 1.5 weeks ago?', 'what did we decide 2.5 days ago?']) {
    assert.equal(parseTimeRange(s, NOW), undefined, s)
  }
  assert.equal(span('what did we decide about the may 1 launch last week?'), '2026-11-09..2026-11-16')
  assert.equal(span('what did we decide yesterday about the nov 30 deadline?'), '2026-11-16..2026-11-17')
  assert.equal(span('the nov 30 deadline we discussed on friday'), '2026-11-13..2026-11-14')
  // Unchanged: the plain forms, and a month date on its own.
  assert.equal(span('两天前我们讨论的方案'), '2026-11-15..2026-11-16')
  assert.equal(span('what did we change 2 weeks ago?'), '2026-11-02..2026-11-09')
  assert.equal(span('what did we decide on nov 3?'), '2026-11-03..2026-11-04')
})
