/**
 * Cycle 2 (v0.8.0, "lean memory tree"): the pure core. Each test is the smallest one that fails
 * without its fix; the issue number is in the name.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUILDER_RULES, asksAboutPast, builderPrompt, emptyGraph, estimateTokens, formatSource, mergeDelta, parseBuilderOutput,
  parseTimeRange, planSpan, renderChatIndex, renderChats, shownContext, tokenize, turnTranscript
} from '../../src/core/index.js'

test('#25 tokenize: full-width and accented words count; #23 particle and hiragana bigrams do not', () => {
  assert.ok(tokenize('ＡＰＩ key').includes('api'), 'NFKC')
  assert.ok(tokenize('the café menu').includes('café'))
  assert.ok(tokenize('Привет мир').includes('привет'))
  const zh = tokenize('我的会话性能')
  assert.ok(!zh.includes('我的'), 'two function characters')
  assert.ok(zh.includes('会话') && zh.includes('性能'), 'a function character next to a content one stays')
  assert.ok(!tokenize('散歩しました').some((t) => /^[぀-ゟ]+$/.test(t)), 'hiragana endings')
  assert.ok(tokenize('see pnpm-lock.yaml.').includes('pnpm-lock.yaml'), 'sentence punctuation is not part of a word')
  assert.ok(!tokenize('can you help, I got an error again').includes('help'), 'everyday words')
})

test('#25 time words: only real words, real dates, years, whole days across DST', () => {
  const now = new Date(2026, 10, 2, 15)
  assert.equal(parseTimeRange('目前天气不错', now), undefined)
  assert.equal(parseTimeRange('登上月球', now), undefined)
  assert.equal(parseTimeRange('这周期的数据', now), undefined)
  assert.equal(parseTimeRange('2026-02-31 report', now), undefined, 'no roll-over into March')
  assert.equal(parseTimeRange('2025年11月1日的会议', now).from.getFullYear(), 2025)
  assert.equal(parseTimeRange('12月25日', now).from.getFullYear(), 2025, 'a date still ahead this year means last year')
  // Each of these weeks crosses a daylight-saving change in one of the zones the suite runs in.
  for (const at of [new Date(2026, 3, 8, 12), new Date(2026, 8, 30, 12), new Date(2026, 2, 10, 12), new Date(2026, 10, 2, 12)]) {
    const week = parseTimeRange('last week', at)
    assert.deepEqual([week.from.getHours(), week.to.getHours(), week.from.getDay(), week.to.getDay()], [0, 0, 1, 1], `last week from ${at}`)
  }
})

test('#24 a day digest only for questions about the past', () => {
  assert.equal(asksAboutPast('what did we decide yesterday?'), true)
  assert.equal(asksAboutPast('昨天说的那个超时'), true)
  assert.equal(asksAboutPast('今天晚上吃什么好'), false)
  assert.equal(asksAboutPast('today I want to learn rust'), false)
})

test('#28 the indexing prompt starts with fixed rules, then topics in id order, so builds share a prefix', () => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label: 'a', msgs: [0] }, { label: 'b', msgs: [0] }], edges: [] }, { now: 'T' })
  const first = builderPrompt({ graph, messages: [{ role: 'user', text: 'one' }] })
  mergeDelta(graph, { nodes: [{ label: 'c', msgs: [0] }], edges: [] }, { now: 'T2' })
  const second = builderPrompt({ graph, summary: 'chat about a', messages: [{ role: 'user', text: 'two' }] })
  assert.ok(first.startsWith(BUILDER_RULES) && second.startsWith(BUILDER_RULES))
  const shared = `${BUILDER_RULES}\n\nExisting topics:\nn1: a\nn2: b\n`
  assert.ok(first.startsWith(shared) && second.startsWith(shared), 'the previous topic list is a prefix of the next')
  assert.ok(second.indexOf('Current summary: chat about a') > second.indexOf('n3: c'), 'what changes comes last')
})

test('#27 the summary rides in the builder JSON; the schema placeholder is not a summary', () => {
  assert.equal(parseBuilderOutput('{"summary":"Postgres tuning for the orders dashboard","nodes":[{"label":"x","msgs":[0]}],"edges":[]}').summary, 'Postgres tuning for the orders dashboard')
  assert.equal(parseBuilderOutput('{"summary":"...","nodes":[{"label":"x","msgs":[0]}],"edges":[]}').summary, undefined)
  const echoed = 'Shape {"summary":"...","nodes":[]} answer: {"summary":"Real one","nodes":[{"label":"x","msgs":[0]}],"edges":[]}'
  assert.equal(parseBuilderOutput(echoed).summary, 'Real one')
  assert.equal(parseBuilderOutput('{"summary":"Nothing new here","nodes":[],"edges":[],"skip":true}').summary, 'Nothing new here')
})

test('#46 a long span keeps every prompt; assistant text shrinks first, then whole turns wait', () => {
  const msg = (seq, role, n) => ({ seq, role, text: role[0].repeat(n), turn: Math.ceil(seq / 10) })
  // 4 turns, each a short prompt and twelve 2,000-char assistant steps: 96k chars of assistant text.
  const busy = [1, 11, 21, 31].flatMap((s) => [msg(s, 'user', 300), ...Array.from({ length: 12 }, (_, i) => msg(s + 1 + i * 0.1, 'assistant', 2000))])
  const plan = planSpan(busy, 60000)
  assert.equal(plan.messages.filter((m) => m.role === 'user').length, 4, 'every prompt is read')
  assert.equal(plan.assistantCap, 800)
  assert.equal(plan.rest, undefined, 'nothing waits')
  // Ten long turns do not fit even at 300 chars per step: the oldest whole turns are read first.
  const long = Array.from({ length: 10 }, (_, t) => [msg(t * 10 + 1, 'user', 2000), ...Array.from({ length: 12 }, (_, i) => msg(t * 10 + 2 + i * 0.1, 'assistant', 2000))]).flat()
  const part = planSpan(long, 20000)
  assert.equal(part.messages[0].seq, 1, 'from the oldest')
  assert.equal(part.rest.role, 'user', 'the next build starts at a prompt')
  assert.ok(part.messages.every((m) => m.seq < part.rest.seq))
  // One turn alone too long: its prompt and its newest steps.
  const one = planSpan([msg(1, 'user', 2000), ...Array.from({ length: 200 }, (_, i) => msg(2 + i * 0.01, 'assistant', 2000))], 10000)
  assert.equal(one.messages[0].role, 'user')
  assert.equal(one.messages.at(-1).seq, 2 + 199 * 0.01, 'the newest step is kept')
})

const ev = {
  user: (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } }),
  says: (text, tools = []) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool-call', name, arguments: '{}' }))] } } }),
  tool: (text) => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } }),
  plugin: (text, layer) => ({ type: 'user/message', data: { source: { kind: 'context-graph', ...(layer ? { layer } : {}) }, content: [{ type: 'text', text }] } })
}

test('#47 a turn is the prompt, the answers and one tools line, capped', () => {
  const log = [ev.user('fix the build'), ev.says('Looking.', ['read_file', 'read_file', 'bash']), ev.tool('x'.repeat(50000)), ev.says('Fixed: the cache key was wrong.'), ev.user('thanks')]
  const turn = turnTranscript((s) => log[s], 1)
  assert.equal(turn.text, 'user:\nfix the build\n\nassistant:\nLooking.\n\n[tools: read_file ×2, bash]\n\nassistant:\nFixed: the cache key was wrong.')
  assert.deepEqual([turn.seq, turn.endSeq], [0, 3])
  assert.equal(turnTranscript((s) => log[s], 2, { limitSeq: 3 }), undefined, 'nothing past limitSeq')
  const huge = [ev.user('p'.repeat(30000)), ...Array.from({ length: 40 }, (_, i) => ev.says(`step ${i} ${'s'.repeat(2000)}`)), ev.says(`final ${'f'.repeat(30000)}`)]
  const capped = turnTranscript((s) => huge[s], 1, { maxTokens: 2000 })
  assert.ok(estimateTokens(capped.text) <= 2100, `capped at ${estimateTokens(capped.text)} tokens`)
  assert.match(capped.text, /^user:\np+\n…\[\d+ chars cut\]…/)
  assert.match(capped.text, /earlier steps left out/)
  assert.match(capped.text, /assistant:\nfinal f+/)
})

test('#51 #31 #26 shown ids come from topic lines and recall results; the list is seen on the surface', () => {
  const log = [
    ev.plugin('[context-graph] Earlier chats ... recall("c<chat>") ... e.g. recall("c3n12")\nc3 chat three', 'surface'),
    ev.plugin('[context-graph] Notes from other chats (...):\n- c1n2 label: gist'),
    ev.tool('# c4n7 Some topic\nfact. gist\nLinked topics:\n  c4n9 Other (this uses it)'),
    ev.tool('# c5 chat\n- c5n1 a: b')
  ]
  const shown = shownContext([0, 1, 2, 3], (s) => log[s])
  assert.deepEqual([...shown.ids].sort(), ['c1n2', 'c4n7', 'c5n1'], 'not c3n12 from prose, not the linked c4n9')
  assert.equal(shown.list, true)
  assert.equal(shownContext([1], (s) => log[s]).list, false)
})

test('#38 #48 #29 only chats with topics are listed; a big chat names the rest; sources name their turns', () => {
  const g = emptyGraph()
  mergeDelta(g, { nodes: Array.from({ length: 45 }, (_, i) => ({ label: `topic ${i}`, gist: 'g', msgs: [0] })), edges: [] }, { now: 'T' })
  const big = { sid: 'a', cid: 3, meta: { title: 'big', startedAt: 'T', lastActiveAt: 'T' }, graph: g, own: false }
  const empty = { sid: 'b', cid: 4, meta: { title: 'hi' }, graph: emptyGraph(), own: false }
  const list = renderChats([big, empty])
  assert.ok(list.includes('\nc3 ') && !list.includes('c4 '), 'the chat with no topics is not listed')
  const index = renderChatIndex(big, { max: 40 })
  assert.match(index, /\n5 more topics: c3n41 topic 40; c3n42 topic 41; c3n43 topic 42; c3n44 topic 43; c3n45 topic 44$/)
  const source = formatSource([{ role: 'user', turn: 7, text: 'a'.repeat(5000) }], { maxTokens: 300, turnId: (t) => `c3t${t}` })
  assert.match(source, /^user \(c3t7\):\na+\n…\[\d+ chars cut; recall\("c3t7"\) gives the whole turn\]…\na+$/)
  assert.ok(estimateTokens(source) <= 310, `source ${estimateTokens(source)} tokens`)
  const zh = formatSource([{ role: 'user', turn: 2, text: '中'.repeat(3000) }], { maxTokens: 300 })
  assert.ok(estimateTokens(zh) <= 310, `Chinese is budgeted in tokens too: ${estimateTokens(zh)}`)
})
