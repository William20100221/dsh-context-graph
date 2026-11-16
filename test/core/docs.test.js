/**
 * The README's cost figures, measured (#37): if the code changes what a block or a recall costs,
 * this test fails until the README says the new number.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { estimateTokens, formatSource, renderChats, renderHits, turnTranscript } from '../../src/core/index.js'
import { DEFAULTS } from '../../src/host/config.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const said = (pattern) => assert.match(readme, pattern, `README should say ${pattern}`)

test('the first-message list: about 200 tokens in all', () => {
  const { views } = corpusViews({ copies: 9 })
  assert.ok(estimateTokens(renderChats(views, { maxTokens: DEFAULTS.listMaxTokens })) <= 200)
  said(/one line per earlier chat with topics, about 200 tokens in all/)
})

test('a topic line: about 30 tokens', () => {
  const { views } = corpusViews()
  const lines = views.filter((v) => !v.own).flatMap((v) => Object.entries(v.graph.nodes).map(([id, node]) => renderHits([{ id: `c${v.cid}${id}`, node }]).split('\n')[1]))
  const mean = lines.reduce((n, l) => n + estimateTokens(l), 0) / lines.length
  assert.ok(mean >= 15 && mean <= 45, `mean topic line ${mean.toFixed(1)} tokens`)
  said(/1-5 topic lines, about 30 tokens each/)
})

test('recall of a topic: about 1,000 tokens; of a turn: about 2,000', () => {
  const big = { role: 'user', turn: 1, text: 'x'.repeat(40000) }
  const each = Math.floor(DEFAULTS.sourceMaxTokens / DEFAULTS.sourceMaxMessages)
  assert.ok(estimateTokens(formatSource([big, big, big], { maxTokens: each })) <= 1050)
  const log = [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'p'.repeat(20000) }] } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a'.repeat(40000) }] } } }]
  assert.ok(estimateTokens(turnTranscript((s) => log[s], 1, { maxTokens: DEFAULTS.turnMaxTokens }).text) <= 2050)
  said(/a topic's source up to about 1,000 tokens, a turn up to about 2,000/)
})
