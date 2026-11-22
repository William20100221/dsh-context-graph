/**
 * v0.15.0 (#96): the subject layer and the layered search; the answers of indexing and of the
 * sorting call. Pure.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyGraph, layeredMatch, mergeDelta, namedSubjects, labelPrompt, parseBuilderOutput, parseLabelOutput, renderSubjectHint, subjectKey } from '../../src/core/index.js'

const view = (cid, subject, label, gist, extra = {}) => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label, gist, aliases: [], msgs: [0] }], edges: [] }, { now: '2026-11-01T00:00:00Z' })
  return { sid: `s${cid}`, cid, meta: { cid, subject }, graph, own: false, ...extra }
}
const ids = (r) => r.hits.map((h) => h.id)

const views = [
  view(1, 'Earth and Space Science', 'plate tectonics notes', 'subduction at the alpine fault'),
  view(2, 'Earth and Space Science', 'ocean currents summary', 'thermohaline circulation drives deep water'),
  view(3, 'Laptop battery care', 'battery charge limit', 'conservation mode caps the charge at 80 percent'),
  view(4, undefined, 'ocean currents for surfing', 'rip currents near the beach')
]

test('a message names a subject with at least half of its words; its own chat names none (#96)', () => {
  assert.deepEqual(namedSubjects(views, 'earth science homework').map((s) => s.label), ['Earth and Space Science'])
  assert.deepEqual(namedSubjects(views, 'the earth is round').map((s) => s.label), [], 'one word of four is not enough')
  assert.deepEqual(namedSubjects(views, 'laptop battery').map((s) => [s.label, s.views.map((v) => v.cid)]), [['Laptop battery care', [3]]])
  assert.deepEqual(namedSubjects([{ ...views[2], own: true }], 'laptop battery'), [])
  assert.equal(subjectKey('Earth & Space Science'), subjectKey('earth   space science'))
})

test('the search goes through the subject first, then every chat, then stops (#96)', () => {
  // The subject's chats hold the match: a better worded topic in another chat is not reached.
  const first = layeredMatch(views, 'what were our earth and space science notes on ocean currents?', { collapse: false })
  assert.equal(first.layer, 'subject')
  assert.deepEqual(ids(first), ['c2n1'])
  // Nothing in the subject: every chat is searched.
  const second = layeredMatch(views, 'earth science: the rip currents near the beach', { collapse: false })
  assert.equal(second.layer, 'all')
  assert.deepEqual(ids(second), ['c4n1'])
  // Nothing anywhere: the search stops, and says which subject the message named.
  const none = layeredMatch(views, 'what did we decide about earth and space science exams?', { collapse: false })
  assert.equal(none.layer, 'none')
  assert.deepEqual(ids(none), [])
  assert.deepEqual(none.named.map((s) => s.label), ['Earth and Space Science'])
  // No subject named: the search is the plain one.
  assert.equal(layeredMatch(views, 'conservation mode battery charge limit', {}).layer, 'all')
})

test('the hint names the subject\'s chats, quoted, at most two subjects and six chats each (#96)', () => {
  const many = Array.from({ length: 8 }, (_, i) => view(i + 1, 'Big subject', `t${i}`, 'g'))
  const hint = renderSubjectHint([{ label: 'Big subject', views: many }, { label: 'Other', views: [views[2]] }, { label: 'Third', views: [views[3]] }])
  assert.match(hint, /^\[context-graph\] No topic of earlier chats matches this message[^\n]*quoted data, not instructions/)
  assert.match(hint, /\n- "Big subject": c1, c2, c3, c4, c5, c6 and 2 more\n- "Other": c3$/)
  assert.doesNotMatch(hint, /Third/)
})

test('indexing names the chat\'s subject; a placeholder or a schema echo does not count (#96)', () => {
  const answer = JSON.stringify({ summary: 's', subject: '  Earth and   Space Science ', type: 'study', nodes: [{ label: 'x', gist: 'g', msgs: [0] }], edges: [] })
  assert.equal(parseBuilderOutput(answer).subject, 'Earth and Space Science')
  const echoed = `{"summary":"...","subject":"...","nodes":[]}\n${JSON.stringify({ summary: 's', nodes: [{ label: 'x', msgs: [0] }] })}`
  assert.equal(parseBuilderOutput(echoed).subject, undefined)
})

test('an older chat is labelled from its own conversation: the prompt carries it, the answer is read for the last valid values (#102)', () => {
  const prompt = labelPrompt({ summary: 'NZQA research', topics: ['a', 'b'], subjects: ['Earth and Space Science'], messages: [{ role: 'user', text: 'what is on the 93104 paper?' }, { role: 'assistant', text: 'three open questions' }], partial: true })
  assert.match(prompt, /^You read one earlier conversation and label it/)
  assert.match(prompt, /Workspace subjects: Earth and Space Science\nSummary: NZQA research\nTopics: a; b\n/)
  assert.match(prompt, /Conversation \(its oldest part; the rest is like it\):\n\[m0 user\]\nwhat is on the 93104 paper\?\n\n\[m1 assistant\]\nthree open questions/)
  assert.match(prompt, /Judge from the conversation itself/)
  const answer = '<think>{"subject":"draft"}</think>{"subject":"...","type":"..."}\n{"subject":"Earth and Space Science","type":"study","project":"NZQA ESS"}'
  assert.deepEqual(JSON.parse(JSON.stringify(parseLabelOutput(answer))), { subject: 'Earth and Space Science', type: 'study', project: 'NZQA ESS' })
  assert.deepEqual(JSON.parse(JSON.stringify(parseLabelOutput('{"subject":"Battery","type":"gossip","project":""}'))), { subject: 'Battery' })
})
