/**
 * v0.14.0 (#94): chat labels from the indexing answer, how a message names them, and how they order
 * topics a message already matched. Pure.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyGraph, labelCue, matchAcross, mergeDelta, mergeParts, parseBuilderOutput, tokenize } from '../../src/core/index.js'

const words = (text) => new Set(tokenize(text))
const plain = (value) => JSON.parse(JSON.stringify(value))

test('the indexing answer gives the chat\'s type, project and parts; anything invalid is left out', () => {
  const answer = JSON.stringify({
    summary: 'Plugin work and a bug',
    type: 'coding',
    project: '  dsh   context graph ',
    parts: [{ msgs: [0, 3], type: 'coding', about: 'the tree page' }, { msgs: ['m4', 'm6'], type: 'debugging', about: 'a crash on open' }, { msgs: [7], type: 'gossip', about: 'x' }, { type: 'coding' }],
    nodes: [{ id: null, label: 'tree page', gist: 'g', aliases: [], kind: 'decision', msgs: [1] }],
    edges: []
  })
  const out = parseBuilderOutput(answer)
  assert.equal(out.type, 'coding')
  assert.equal(out.project, 'dsh context graph')
  assert.deepEqual(plain(out.parts), [{ msgs: [0, 3], type: 'coding', about: 'the tree page' }, { msgs: [4, 6], type: 'debugging', about: 'a crash on open' }])
  // A schema echoed first does not count, a type written after the nodes is still read, "" is no project.
  const echoed = `{"summary":"...","type":"...","project":"...","parts":[],"nodes":[]}\n${JSON.stringify({ summary: 's', project: '', nodes: [{ label: 'x', gist: 'g', msgs: [0] }], edges: [], type: 'study' })}`
  const late = parseBuilderOutput(echoed)
  assert.equal(late.type, 'study')
  assert.equal(late.project, null)
  assert.deepEqual(plain(late.parts), [])
  assert.equal(parseBuilderOutput(JSON.stringify({ type: 'nonsense', nodes: [{ label: 'x', msgs: [0] }] })).type, undefined)
})

test('a message names a chat by all the words of its project, or a cue word of its type or of a part holding the topic (#94)', () => {
  const meta = { type: 'debugging', project: 'NZQA Earth Space', parts: [{ from: 10, to: 20, type: 'study' }] }
  assert.equal(labelCue(meta, words('the nzqa earth space notes'), []), 2)
  assert.equal(labelCue(meta, words('the earth space notes'), []), 0, 'every word of the project')
  assert.equal(labelCue(meta, words('that bug from before'), []), 1)
  assert.equal(labelCue(meta, words('那个报错怎么修的'), []), 1, 'Chinese cues too')
  assert.equal(labelCue({ parts: meta.parts }, words('the exam notes'), [15]), 1, 'a part holding one of the topic\'s sources')
  assert.equal(labelCue({ parts: meta.parts }, words('the exam notes'), [25]), 0, 'not a part that holds none')
  assert.equal(labelCue({ type: 'question' }, words('a quick question'), []), 0, 'everyday words name nothing')
  assert.equal(labelCue(undefined, words('bug'), []), 0)
})

test('parts merge: later ones follow, one that continues the last extends it, at most 12 kept (#94)', () => {
  const a = { from: 1, to: 4, turns: [1, 2], type: 'coding', about: 'tree' }
  const b = { from: 5, to: 8, turns: [3, 4], type: 'coding', about: 'tree' }
  const c = { from: 9, to: 12, turns: [5, 6], type: 'debugging', about: 'crash' }
  assert.deepEqual(mergeParts([a], [b, c]), [{ ...a, to: 8, turns: [1, 4] }, c])
  assert.deepEqual(mergeParts([a], [{ ...a }]), [a], 'a part already there is not added again')
  const many = Array.from({ length: 15 }, (_, i) => ({ from: i * 10, to: i * 10 + 5, turns: [i, i], type: i % 2 ? 'coding' : 'study', about: `p${i}` }))
  assert.equal(mergeParts([], many).length, 12)
  assert.equal(mergeParts([], many)[0].about, 'p3', 'the oldest go first')
})

test('among topics a message matches, those in a chat whose label it names come first; a label adds no topic (#94)', () => {
  const view = (cid, meta, label, gist) => {
    const graph = emptyGraph()
    mergeDelta(graph, { nodes: [{ label, gist, aliases: [], msgs: [0] }], edges: [] }, { now: '2026-11-01T00:00:00Z', refsOf: () => [5] })
    return { sid: `s${cid}`, cid, meta: { cid, ...meta }, graph, own: false }
  }
  const views = [
    view(1, { type: 'planning' }, 'cache settings for the build', 'the ci cache keeps node_modules and artifacts for a week'),
    view(2, { type: 'debugging' }, 'cache settings for the build', 'the ci cache kept stale node_modules, cleared on lockfile change'),
    view(3, { type: 'debugging' }, 'homework reminders', 'a weekly reminder for the physics homework')
  ]
  const ids = (q, max) => matchAcross(views, q, { collapse: false, ...(max ? { max } : {}) }).hits.map((h) => h.id)
  assert.equal(ids('the cache settings bug we fixed')[0], 'c2n1', 'the bug fixing chat first')
  // The planning chat's topic has more evidence (its gist holds "artifacts" too); the bug fixing one
  // still comes first, in the one slot there is and in the order of two.
  const message = 'the cache settings bug we fixed for the artifacts'
  assert.deepEqual(ids(message, 1), ['c2n1'], 'the slot goes to the chat the message names')
  assert.deepEqual(ids(message, 2), ['c2n1', 'c1n1'], 'and it comes first when both are sent')
  assert.equal(ids('the cache settings plan')[0], 'c1n1', 'the planning chat first')
  assert.ok(!ids('the cache settings bug we fixed').includes('c3n1'), 'the label alone matches nothing')
})
