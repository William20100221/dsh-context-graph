import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyGraph, foldKept, mergeDelta, planFold, renderFoldIndex, turnIndex, turnTranscript } from '../graph.js'

const user = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const ctxMsg = (kind, text) => ({ type: 'user/message', data: { source: { kind }, content: [{ type: 'text', text }] } })
const say = (text, calls = 0) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }, ...Array.from({ length: calls }, (_, i) => ({ type: 'tool-call', id: `c${i}`, name: 'read', arguments: '{"path":"a.txt"}' }))] } } })
const result = (text) => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } })

// seq: 0 sys, 1 skills, 2 t1, 3 a(tool), 4 result, 5 a, 6 t2, 7 a, 8 t3, 9 a, 10 t4, 11 a
const log = [
  { type: 'system/message', data: {} }, ctxMsg('skill-catalog', 'SKILLS'),
  user('first question about pnpm'), say('checking', 1), result('X'.repeat(3000)), say('use corepack'),
  user('second question'), say('answer two'),
  user('third question'), say('answer three'),
  user('fourth question'), say('answer four')
]
const eventAt = (seq) => log[seq]
const nodes = log.map((_, i) => i)

test('planFold keeps the last turns, skips the system prompt, respects the indexed limit', () => {
  const plan = planFold(nodes, eventAt, { keepTurns: 2 })
  assert.deepEqual(plan, { startSeq: 1, endSeq: 7, shadowedSeqs: [1, 2, 3, 4, 5, 6, 7] })
  assert.equal(planFold(nodes, eventAt, { keepTurns: 2, maxSeq: 5 }).endSeq, 5, 'falls back to an earlier cut')
  assert.equal(planFold(nodes, eventAt, { keepTurns: 2, maxSeq: 1 }), undefined, 'nothing indexed')
  assert.equal(planFold(nodes, eventAt, { keepTurns: 4 }), undefined, 'too few turns')
})

test('planFold never cuts inside an open tool call', () => {
  const open = [{ type: 'system/message', data: {} }, user('a'), say('x', 1), user('b'), say('y'), user('c'), say('z')]
  assert.equal(planFold(open.map((_, i) => i), (s) => open[s], { keepTurns: 1 }), undefined)
})

test('turnIndex numbers human prompts; turnTranscript returns one turn verbatim', () => {
  assert.deepEqual(turnIndex(eventAt, 7).map((t) => `t${t.turn}:${t.text}`), ['t1:first question about pnpm', 't2:second question'])
  assert.equal(turnIndex(eventAt).length, 4)
  const t1 = turnTranscript(eventAt, 1, { maxToolChars: 10 })
  assert.match(t1, /^\*\*user:\*\*\nfirst question about pnpm/)
  assert.match(t1, /\*\*tool call\*\* read \{"path":"a.txt"\}/)
  assert.match(t1, /XXXXXXXXXX\n…\[2990 more chars\]/)
  assert.match(t1, /use corepack$/)
  assert.ok(!t1.includes('second question'))
  assert.equal(turnTranscript(eventAt, 9), undefined)
})

test('foldKept carries standing context, including through an earlier fold', () => {
  const kept = foldKept([1, 2, 3], eventAt)
  assert.deepEqual(kept.kinds, ['skill-catalog'])
  assert.equal(kept.blocks[0].text, 'SKILLS')
  const prev = { type: 'user/message', data: { source: { kind: 'context-graph', fold: true, keptKinds: ['skill-catalog'] }, content: [{ type: 'text', text: 'TOC' }, { type: 'text', text: 'SKILLS' }] } }
  const again = foldKept([0], () => prev)
  assert.deepEqual(again, { kinds: ['skill-catalog'], blocks: [{ type: 'text', text: 'SKILLS' }] })
})

test('renderFoldIndex lists this session topics and every folded turn', () => {
  const g = emptyGraph()
  mergeDelta(g, { nodes: [{ label: 'pnpm via corepack', gist: 'pnpm not on PATH', msgs: [0] }], edges: [] }, { session: 's1', turn: 1, now: 'T' })
  mergeDelta(g, { nodes: [{ label: 'other chat', gist: 'x', msgs: [0] }], edges: [] }, { session: 's2', turn: 1, now: 'T' })
  const text = renderFoldIndex(g, 's1', turnIndex(eventAt, 7))
  assert.match(text, /Turns t1-t2 of this conversation are folded/)
  assert.match(text, /- n1 pnpm via corepack: pnpm not on PATH/)
  assert.ok(!text.includes('other chat'))
  assert.match(text, /- t1: first question about pnpm\n- t2: second question$/)
  const many = renderFoldIndex(g, 's1', Array.from({ length: 70 }, (_, i) => ({ turn: i + 1, text: `q${i + 1}` })))
  assert.match(many, /- t1-t10: earlier turns, recall by id\n- t11: q11/)
})
