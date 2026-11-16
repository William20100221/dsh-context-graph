/**
 * Cycle 4 (v0.10.0): a day's chats, pure. Each test fails without its fix; the issue number is in
 * the name. Times are built from local dates, so a day is the same day in every zone.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { estimateTokens, parseTimeRange, renderRange } from '../../src/core/index.js'

const at = (d, h) => new Date(2026, 10, d, h).toISOString()
const node = (label, updated) => ({ label, gist: `${label}, as decided that day`, aliases: [], kind: 'decision', refs: [1], at: updated, updated })
const view = (cid, startedAt, lastActiveAt, nodes) => ({ sid: `s${cid}`, cid, own: false, meta: { cid, summary: `chat ${cid}`, startedAt, lastActiveAt }, graph: { version: 2, nextId: 50, nodes, edges: [] } })
const topics = (n, label, d) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`n${i + 1}`, node(`${label} ${i + 1}`, at(d, 9 + (i % 10)))]))
const DAY = parseTimeRange('2026-11-05')
const RECALL = { maxTopics: Infinity, maxTokens: 1000 }

test('#81 a day lists the chats worked on that day before chats that merely span it', () => {
  const worked = view(40, at(5, 9), at(5, 18), { n1: node('failover runbook', at(5, 11)), n2: node('replica lag alert', at(5, 12)), n3: node('promote with pg_ctl', at(5, 13)) })
  // Long-running chats: started before Nov 5, last active after it, no topic from Nov 5.
  const spanning = Array.from({ length: 25 }, (_, i) => view(i + 1, at(1, 9), at(16, 9 + (i % 12)), { n1: node(`old ${i}`, at(1, 10)), n2: node(`new ${i}`, at(16, 10)) }))
  for (const opts of [{ maxChats: 3, maxTopics: 3 }, {}, RECALL]) {
    const text = renderRange([...spanning, worked], DAY, opts)
    assert.match(text, /^\[context-graph\] Chats from 2026-11-05 [^\n]*\n- c40 2026-11-05 chat 40 \(3 topics\)\n {2}- c40n3 promote with pg_ctl: [^\n]*\n {2}- c40n2 [^\n]*\n {2}- c40n1 /, JSON.stringify(opts))
    assert.match(text, /more chats \(c\d+/, 'the spanning chats are still named')
  }
  // More topics from then come first; on equal counts the newest chat does.
  const one = view(51, at(5, 8), at(5, 22), topics(1, 'one', 5))
  const two = view(52, at(5, 8), at(5, 10), topics(2, 'two', 5))
  const late = view(53, at(5, 8), at(5, 23), topics(1, 'late', 5))
  assert.deepEqual([...renderRange([one, two, late], DAY).matchAll(/^- c(\d+) /gm)].map((m) => m[1]), ['52', '53', '51'])
})

test('#77 a day recall shares one token budget fairly and names everything it leaves out', () => {
  // Twelve chats, ten topics each, all from Nov 5: 3,600 tokens before #77.
  const busy = Array.from({ length: 12 }, (_, i) => view(i + 1, at(5, 8), at(5, 20 - (i % 3)), topics(10, `chat ${i + 1} release checklist step`, 5)))
  const text = renderRange(busy, DAY, RECALL)
  assert.ok(estimateTokens(text) <= 1000, `${estimateTokens(text)} tokens`)
  for (let c = 1; c <= 12; c++) assert.match(text, new RegExp(`\\bc${c}\\b`), `c${c} is named`)
  const listed = text.split('\n- c').slice(1)
  assert.ok(listed.length >= 6, `${listed.length} chats listed`)
  for (const block of listed) {
    const cid = block.match(/^\d+/)[0]
    const shown = (block.match(/^ {2}- c\d+n\d+ /gm) ?? []).length
    const more = Number(block.match(/- … (\d+) more from then: recall\("c\d+"\)/)?.[1] ?? 0)
    assert.ok(shown >= 1, `c${cid} shows a topic`)
    assert.equal(shown + more, 10, `c${cid}: every topic from then is shown or counted`)
  }
  // A small chat next to a big one shows all of its topics; the big one takes the rest.
  const big = view(7, at(5, 8), at(5, 20), topics(40, 'big topic about deploys', 5))
  const small = view(8, at(5, 8), at(5, 21), topics(3, 'small topic', 5))
  const pair = renderRange([big, small], DAY, RECALL)
  assert.ok(estimateTokens(pair) <= 1000, `${estimateTokens(pair)} tokens`)
  assert.equal((pair.match(/^ {2}- c8n\d+ /gm) ?? []).length, 3, 'the small chat is whole')
  assert.doesNotMatch(pair, /recall\("c8"\)/)
  const bigShown = (pair.match(/^ {2}- c7n\d+ /gm) ?? []).length
  assert.ok(bigShown >= 20, `the big chat shows ${bigShown}`)
  assert.match(pair, new RegExp(`- … ${40 - bigShown} more from then: recall\\("c7"\\)`))
  // Without a budget nothing changes: the digest's caps alone.
  assert.equal((renderRange(busy, DAY, { maxChats: 3, maxTopics: 3 }).match(/^ {2}- c\d+n\d+ /gm) ?? []).length, 9)
})
