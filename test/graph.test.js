import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  builderInstruction, chatInRange, collectSpan, emptyGraph, estimateTokens, matchAcross, matchNodes, mergeDelta, neighbors,
  parseBuilderOutput, parseTimeRange, renderChatIndex, renderChats, renderHits, renderMap, renderRange, resolveSuperseded,
  surfaceNodes, titleOf, tokenize, transcriptForBuilder
} from '../graph.js'
import { appendSource, chatDir, ensureMeta, listChats, loadGraph, loadMeta, readSource, saveGraph, saveMeta } from '../store.js'

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

const NOW = new Date(2026, 10, 2, 15, 0, 0) // Monday 2026-11-02 15:00 local
const meta = (cid, startedAt, lastActiveAt, extra = {}) => ({ cid, title: `chat ${cid}`, startedAt, lastActiveAt, memory: true, shared: true, ...extra })

/** Two shared chats (c1 yesterday, c2 last week) and the own chat c3. */
function sampleViews() {
  const old = emptyGraph()
  mergeDelta(old, { nodes: [{ id: null, label: 'tunnel timeout', gist: '524 from the free tunnel after 120s', aliases: ['524', 'cloudflare'], kind: 'fact', msgs: [0] }], edges: [] },
    { session: 'sOld', turn: 1, now: '2026-10-27T09:00:00' })
  const own = emptyGraph()
  mergeDelta(own, { nodes: [{ id: null, label: 'commit signing', gist: 'own copy, still in context', aliases: ['gpg'], kind: 'fact', msgs: [0] }], edges: [] },
    { session: 'sOwn', turn: 1, now: '2026-11-02T14:00:00' })
  return [
    { sid: 'sA', cid: 1, meta: meta(1, '2026-11-01T09:00:00', '2026-11-01T12:00:00'), graph: sampleGraph(), own: false },
    { sid: 'sOld', cid: 2, meta: meta(2, '2026-10-27T08:00:00', '2026-10-27T10:00:00'), graph: old, own: false },
    { sid: 'sOwn', cid: 3, meta: meta(3, '2026-11-02T14:00:00', '2026-11-02T15:00:00', { shared: false }), graph: own, own: true }
  ]
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

test('parseTimeRange understands days, weeks and months in English and Chinese', () => {
  const day = (r) => [r.from.toISOString().slice(0, 10), r.to.toISOString().slice(0, 10)]
  const y = parseTimeRange('what did we decide yesterday?', NOW)
  assert.equal(y.label, 'yesterday')
  assert.ok(y.from < new Date(2026, 10, 1, 12) && y.to > new Date(2026, 10, 1, 12) && y.to <= new Date(2026, 10, 2))
  assert.equal(parseTimeRange('昨天说的那个超时', NOW).label, 'yesterday')
  assert.equal(parseTimeRange('today we continue', NOW).label, 'today')
  assert.equal(parseTimeRange('3 days ago', NOW).from.getDate(), 30)
  const lw = parseTimeRange('the plan from last week', NOW)
  assert.equal(lw.from.getDay(), 1, 'weeks start on Monday')
  assert.equal(lw.to.getTime(), new Date(2026, 10, 2).getTime())
  assert.equal(parseTimeRange('上周的结论', NOW).label, 'last week')
  assert.equal(parseTimeRange('on 2026-10-27 we said', NOW).from.getDate(), 27)
  assert.equal(parseTimeRange('11月1日的对话', NOW).from.getMonth(), 10)
  assert.equal(parseTimeRange('last month', NOW).from.getMonth(), 9)
  assert.equal(parseTimeRange('no time words here', NOW), undefined)
  assert.ok(day(y)[0] <= day(y)[1])
  assert.equal(chatInRange(meta(1, '2026-11-01T09:00:00', '2026-11-01T12:00:00'), y), true)
  assert.equal(chatInRange(meta(1, '2026-10-27T08:00:00', '2026-10-27T10:00:00'), y), false)
})

test('matchAcross skips the own chat, prefixes ids, and searches a named day first', () => {
  const views = sampleViews()
  const plain = matchAcross(views, 'gpg signed commits')
  assert.deepEqual(plain.hits.map((h) => h.id), ['c1n2'], 'own-chat copy is not repeated')
  assert.equal(plain.slice, undefined)
  const byChat = matchAcross(views, 'the 524 tunnel problem from last week', { range: parseTimeRange('last week', NOW) })
  assert.deepEqual(byChat.hits.map((h) => h.id), ['c2n1'])
  assert.equal(byChat.slice, 'last week (by chat)')
  const widened = matchAcross(views, 'the 524 tunnel problem from yesterday', { range: parseTimeRange('yesterday', NOW) })
  assert.deepEqual(widened.hits.map((h) => h.id), ['c2n1'], 'no hit in that day: widened to everything')
  assert.equal(widened.slice, undefined)
  assert.equal(matchAcross(views, 'what happened yesterday', { range: parseTimeRange('yesterday', NOW) }).hits.length, 0)
})

test('render: hits, chat list, chat index, day range and map stay small and name ids the model can recall', () => {
  const views = sampleViews()
  const { hits } = matchAcross(views, 'clear context corepack signed commits 524')
  const block = renderHits(hits)
  assert.ok(block.startsWith('[context-graph]'))
  assert.ok(block.includes('- c1n1 clear_conversation tool:') && block.includes('- c2n1 tunnel timeout:'))
  assert.ok(estimateTokens(block) < 200, `block too big: ${estimateTokens(block)}`)
  assert.equal(renderHits([]), '')
  const inline = renderHits(hits.slice(0, 1), { inline: { id: 'c1n1', text: 'verbatim' }, slice: 'yesterday (by chat)' })
  assert.ok(inline.includes('from yesterday (by chat)') && inline.endsWith('Verbatim source of c1n1:\nverbatim'))
  const chats = renderChats(views)
  assert.match(chats, /Memory is on[\s\S]*- c1 2026-11-01 chat 1 \(3 topics\)\n- c2 2026-10-27 chat 2 \(1 topics\)$/)
  assert.equal(renderChats([views[2]]), '', 'nothing to list without shared chats')
  assert.match(renderChatIndex(views[0]), /^# c1 chat 1 \(2026-11-01 → 2026-11-01\)\n- c1n1 /)
  const day = renderRange(views, parseTimeRange('yesterday', NOW))
  assert.match(day, /^\[context-graph\] Chats from yesterday:\n- c1 2026-11-01 chat 1 \(3 topics\)\n  - c1n1 /)
  assert.ok(!day.includes('c2 '), 'other days stay out')
  assert.match(renderRange(views, parseTimeRange('2020-01-01', NOW)), /No chats from 2020-01-01/)
  const map = renderMap(views)
  assert.match(map, /^c3 2026-11-02 chat 3 · 1 topics · this chat, memory on, private\n  - c3n1 [\s\S]*\nc1 2026-11-01 chat 1 · 3 topics · memory on, shared\n/)
  assert.match(renderMap([]), /No chats indexed/)
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
  assert.equal(titleOf((seq) => events[seq]), 'first ask')
  assert.equal(titleOf(() => undefined), undefined)
})

test('store: one folder per chat, meta with chat numbers, graph and source round-trip', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-graph-'))
  try {
    assert.deepEqual(await listChats(dir), [], 'no chats folder yet')
    const a = await ensureMeta(dir, 'sA', { title: 'first', workspace: dir, now: '2026-11-01T09:00:00Z' })
    const b = await ensureMeta(dir, 'sB', { title: 'second', workspace: dir, now: '2026-11-02T09:00:00Z' })
    assert.equal(a.cid, 1)
    assert.equal(b.cid, 2)
    assert.deepEqual(await ensureMeta(dir, 'sA', { now: 'later' }), a, 'existing meta is kept')
    await saveMeta(dir, 'sA', { ...a, shared: true })
    assert.equal((await loadMeta(dir, 'sA')).shared, true)
    assert.deepEqual((await listChats(dir)).map((c) => c.sid), ['sB', 'sA'], 'newest activity first')
    const chat = chatDir(dir, 'sA')
    assert.equal(Object.keys((await loadGraph(chat)).nodes).length, 0, 'missing file is an empty graph')
    const g = sampleGraph()
    await saveGraph(chat, g)
    assert.deepEqual(await loadGraph(chat), g)
    await appendSource(chat, 'n1', { session: 'sA', turn: 1, at: 'T', messages: [{ seq: 1, role: 'user', text: 'hello' }] })
    await appendSource(chat, 'n1', { session: 'sA', turn: 2, at: 'U', messages: [{ seq: 5, role: 'assistant', text: 'again' }] })
    const text = await readSource(chat, 'n1')
    assert.ok(text.includes('## T session sA turn 1') && text.includes('hello') && text.includes('## U session sA turn 2'))
    assert.equal(await readSource(chat, 'n404'), undefined)
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
