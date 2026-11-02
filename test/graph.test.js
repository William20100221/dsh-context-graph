import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  builderInstruction, collectSpan, emptyGraph, estimateTokens, matchNodes, mergeDelta, neighbors,
  parseBuilderOutput, renderHits, renderSurface, resolveSuperseded, surfaceNodes, tokenize, transcriptForBuilder
} from '../graph.js'
import { appendSource, loadGraph, readSource, saveGraph } from '../store.js'

function sampleGraph() {
  const g = emptyGraph()
  mergeDelta(g, {
    nodes: [
      { id: null, label: 'clear_conversation tool', gist: 'dsh tool; replaces surface range with a marker', aliases: ['clear context', '/clear', '清除上下文'], kind: 'artifact', msgs: [0] },
      { id: null, label: 'commit signing', gist: 'CherryHQ main requires signed commits; SSH key set up', aliases: ['gpg', 'signed commits'], kind: 'fact', msgs: [1] },
      { id: null, label: 'pnpm not on PATH', gist: 'use corepack pnpm', aliases: ['corepack'], kind: 'fact', msgs: [1] }
    ],
    edges: [['clear_conversation tool', 'pnpm not on PATH', 'uses']]
  }, { session: 'sA', turn: 1, now: '2026-11-01T10:00:00Z' })
  return g
}

test('tokenize splits words, identifiers and CJK bigrams, drops stopwords', () => {
  const t = tokenize('Please clear_conversation the tool 清除上下文')
  assert.ok(t.includes('clear_conversation'))
  assert.ok(t.includes('clear') && t.includes('conversation') && t.includes('tool'))
  assert.ok(t.includes('清除') && t.includes('上下') && t.includes('下文'))
  assert.ok(!t.includes('please') && !t.includes('the'))
  assert.deepEqual(tokenize(''), [])
})

test('matchNodes ranks label hits above gist hits and needs a strong hit', () => {
  const g = sampleGraph()
  const hits = matchNodes(g, 'how does the clear context tool work with corepack?')
  assert.equal(hits[0].id, 'n1')
  assert.ok(hits.some((h) => h.id === 'n3'))
  assert.equal(matchNodes(g, 'surface range marker').length, 0, 'gist-only overlap is not enough')
  assert.equal(matchNodes(g, '清除上下文')[0].id, 'n1', 'Chinese alias matches')
})

test('matchNodes skips same-session nodes until that session compacted', () => {
  const g = sampleGraph()
  assert.equal(matchNodes(g, 'clear context', { session: 'sA' }).length, 0)
  assert.equal(matchNodes(g, 'clear context', { session: 'sA', sessionCompacted: true }).length, 1)
  assert.equal(matchNodes(g, 'clear context', { session: 'sB' }).length, 1)
})

test('supersedes edges redirect a hit to the newer node', () => {
  const g = sampleGraph()
  mergeDelta(g, {
    nodes: [{ id: null, label: 'commit signing via SSH key', gist: 'signing uses ~/.ssh/id_ed25519_signing', aliases: ['signing'], kind: 'decision', msgs: [0] }],
    edges: [['commit signing via SSH key', 'n2', 'supersedes']]
  }, { session: 'sB', turn: 3, now: '2026-11-02T10:00:00Z' })
  assert.equal(resolveSuperseded(g, 'n2'), 'n4')
  const hits = matchNodes(g, 'gpg signed commits')
  assert.equal(hits[0].id, 'n4')
  assert.equal(hits[0].via, 'n2')
  assert.equal(hits.length, 1, 'old and new collapse to one line')
})

test('surfaceNodes puts the most connected first', () => {
  const g = sampleGraph()
  assert.deepEqual(surfaceNodes(g, 2), ['n1', 'n3'], 'degree-1 nodes before the unlinked n2')
  assert.equal(surfaceNodes(g, 10).length, 3)
  assert.deepEqual(neighbors(g, 'n1'), [{ id: 'n3', relation: 'uses', direction: 'out' }])
})

test('parseBuilderOutput tolerates fences, prose and trailing commas; rejects junk', () => {
  const out = parseBuilderOutput('Here you go:\n```json\n{"nodes":[{"id":null,"label":"x","gist":"y","msgs":[0],},{"label":"no msgs","msgs":[]}],"edges":[["a","b","uses"],["bad"]],}\n```')
  assert.equal(out.nodes.length, 1)
  assert.equal(out.edges.length, 1)
  assert.equal(parseBuilderOutput('nothing here'), undefined)
  assert.equal(parseBuilderOutput('{"nodes": "nope"}'), undefined)
})

test('mergeDelta assigns ids, updates by id or label, unions aliases, dedupes edges', () => {
  const g = sampleGraph()
  const touched = mergeDelta(g, {
    nodes: [
      { id: 'n1', label: 'clear_conversation tool', gist: 'now also has a /clear command', aliases: ['/clear', 'clear cmd'], kind: 'artifact', msgs: [2] },
      { id: null, label: 'PNPM not on path', gist: 'same fact, different case', aliases: [], kind: 'fact', msgs: [0] },
      { id: 'n999', label: 'ghost id', gist: 'unknown id becomes new', aliases: [], kind: 'bogus', msgs: [1] }
    ],
    edges: [['n1', 'n3', 'uses'], ['ghost id', 'n1', 'relates-to'], ['n1', 'n1', 'uses'], ['n1', 'n2', 'invented']]
  }, { session: 'sB', turn: 2, now: '2026-11-02T00:00:00Z' })
  assert.deepEqual(touched.map((t) => [t.id, t.isNew]), [['n1', false], ['n3', false], ['n4', true]])
  assert.equal(g.nodes.n1.gist, 'now also has a /clear command')
  assert.deepEqual(g.nodes.n1.aliases, ['clear context', '/clear', '清除上下文', 'clear cmd'])
  assert.equal(g.nodes.n1.src.length, 2)
  assert.equal(g.nodes.n4.kind, 'fact', 'unknown kind falls back')
  assert.deepEqual(g.edges, [['n1', 'n3', 'uses'], ['n4', 'n1', 'relates-to']])
  assert.equal(g.nextId, 5)
})

test('renderHits stays small and renderSurface lists god nodes', () => {
  const g = sampleGraph()
  const hits = matchNodes(g, 'clear context corepack signed commits')
  const block = renderHits(g, hits)
  assert.ok(block.startsWith('[context-graph]'))
  assert.ok(estimateTokens(block) < 150, `block too big: ${estimateTokens(block)}`)
  assert.equal(renderHits(g, []), '')
  const inline = renderHits(g, hits.slice(0, 1), { inline: { id: 'n1', text: 'verbatim' } })
  assert.ok(inline.endsWith('Verbatim source of n1:\nverbatim'))
  const surface = renderSurface(g, surfaceNodes(g))
  assert.ok(surface.includes('3 nodes') && surface.includes('- n2 commit signing'))
})

test('collectSpan reads human and assistant text after a seq, ignoring tools and injected context', () => {
  const events = {
    0: { type: 'system/message', data: {} },
    1: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first ask' }] } },
    2: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }, { type: 'tool-call' }] } } },
    3: { type: 'tool/result', data: { message: { content: [{ type: 'text', text: 'huge output' }] } } },
    4: { type: 'user/message', data: { source: { kind: 'context-graph' }, content: [{ type: 'text', text: 'injected' }] } },
    5: { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second ask' }] } }
  }
  const span = collectSpan([0, 1, 2, 3, 4, 5], (seq) => events[seq])
  assert.deepEqual(span.messages.map((m) => m.text), ['first ask', 'reply', 'second ask'])
  assert.equal(span.userTurns, 2)
  assert.equal(span.lastSeq, 5)
  const later = collectSpan([0, 1, 2, 3, 4, 5], (seq) => events[seq], 2)
  assert.deepEqual(later.messages.map((m) => m.text), ['second ask'])
  assert.ok(transcriptForBuilder(span.messages, 5).includes('[m0 user]\nfirst\n…[4 more chars]'))
  assert.ok(builderInstruction(sampleGraph()).includes('n1: clear_conversation tool'))
})

test('store round-trips graph and source text', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-graph-'))
  try {
    assert.equal(Object.keys((await loadGraph(dir)).nodes).length, 0, 'missing file is an empty graph')
    const g = sampleGraph()
    await saveGraph(dir, g)
    assert.deepEqual(await loadGraph(dir), g)
    await appendSource(dir, 'n1', { session: 'sA', turn: 1, at: 'T', messages: [{ seq: 1, role: 'user', text: 'hello' }] })
    await appendSource(dir, 'n1', { session: 'sA', turn: 2, at: 'U', messages: [{ seq: 5, role: 'assistant', text: 'again' }] })
    const text = await readSource(dir, 'n1')
    assert.ok(text.includes('## T session sA turn 1') && text.includes('hello') && text.includes('## U session sA turn 2'))
    assert.equal(await readSource(dir, 'n404'), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseBuilderOutput survives thinking text and output cut off mid-way', () => {
  const thinking = '<think>Maybe {"nodes": [] } ... let me think {about} it</think>\n{"nodes":[{"id":null,"label":"a","gist":"g","msgs":[0]}],"edges":[]}'
  assert.deepEqual(parseBuilderOutput(thinking).nodes.map((n) => n.label), ['a'])
  const unclosed = '<think>still thinking {"nodes": [{"label":"fake","msgs":[0]}]'
  assert.equal(parseBuilderOutput(unclosed), undefined, 'an unfinished think block is not the answer')
  const truncated = '```json\n{"nodes":[{"id":null,"label":"one","gist":"has } and \\" inside","msgs":[0]},{"id":null,"label":"two","msgs":[1]},{"id":null,"label":"thr'
  assert.deepEqual(parseBuilderOutput(truncated).nodes.map((n) => n.label), ['one', 'two'], 'complete nodes are kept')
  const withEdges = '{"nodes":[{"label":"x","msgs":[0]}],"edges":[["x","n1","uses"],["bad"],["y", "x", "relates-to"]]}'
  assert.deepEqual(parseBuilderOutput(withEdges).edges, [['x', 'n1', 'uses'], ['y', 'x', 'relates-to']])
})
