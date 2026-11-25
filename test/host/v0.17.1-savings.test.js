/**
 * v0.17.1: what indexing costs is written when the index ends, not only at a turn end (#105); two
 * writes of one chat at once skip nothing (#106); deleting a chat's memory keeps its counters (#107).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.17.1-savings.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { counters } from '../../src/core/ledger.js'
import { removeChat } from '../../src/store/chats.js'
import { chatEntry } from '../../src/store/ledger.js'
import { DEFAULT_REPLY, agentOf, chatEvents, scriptedLlm, setup, skip, system, until, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cost-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}

const USAGE = { inputTokens: 700, cacheReadTokens: 100, outputTokens: 50 }

/** A model whose calls go through the plugin's llm/stream hook, as dsh's llm service does, each reporting USAGE. */
function metered(reply = DEFAULT_REPLY) {
  const inner = scriptedLlm({ reply })
  const llm = {
    hook: undefined,
    get calls() { return inner.calls },
    stream: (options) => llm.hook(options, () => (async function* () { yield { type: 'usage', usage: USAGE }; yield* inner.stream(options) })())
  }
  return llm
}
async function withMeter(config = {}, llm = metered()) {
  const h = await setup(config, llm)
  llm.hook = h.listeners['llm/stream']
  return h
}
const costOf = async (cwd, sid) => counters((await chatEntry(join(cwd, '.context-graph'), sid)).c)

test('a /context-graph build writes what its indexing call cost, with no turn end after it (#105)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await withMeter()
  const result = (await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')).text
  assert.match(result, /indexed/)
  const c = await until(async () => { const got = await costOf(cwd, 'sA'); return got.indexIn > 0 && got })
  assert.deepEqual([c.indexIn, c.indexCached, c.indexOut], [700, 100, 50])
  await wait(50)
  assert.equal((await costOf(cwd, 'sA')).indexIn, 700, 'once')
}))

test('a turn end\'s own index is written once, with its turn (#105)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await withMeter({ buildEveryTurns: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  h.listeners['agent/turn-stopping']({ agent: a })
  const c = await until(async () => { const got = await costOf(cwd, 'sA'); return got.indexIn > 0 && got })
  assert.equal(c.indexIn, 700)
  await wait(50)
  assert.equal((await costOf(cwd, 'sA')).indexIn, 700, 'not twice')
}))

test('the calls labelling older chats are written when they end, as the indexing chat\'s cost (#105)', { skip }, () => inWorkspace(async (cwd) => {
  const llm = metered()
  // An older chat without labels, indexed in an earlier app run.
  await (await withMeter({}, llm)).run(agentOf('sOld', cwd, chatEvents(4)), 'build')
  const h = await withMeter({ _sort: true }, llm)
  const calls = llm.calls
  await h.run(agentOf('sB', cwd, chatEvents(4)), 'build')
  await until(() => llm.calls === calls + 2)
  const c = await until(async () => { const got = await costOf(cwd, 'sB'); return got.indexIn === 1400 && got })
  assert.equal(c.indexOut, 100, 'its index and the labelling call')
}))

test('two writes of one chat at once credit every topic it used (#106)', { skip }, () => inWorkspace(async (cwd) => {
  const three = JSON.stringify({ nodes: [0, 2, 4].map((i) => ({ id: null, label: `topic ${i}`, gist: `gist ${i}`, aliases: [], kind: 'fact', msgs: [i] })), edges: [] })
  const h = await setup({}, scriptedLlm({ reply: three }))
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  for (const id of ['c1n1', 'c1n2', 'c1n3']) await h.recall(b, id)
  await Promise.all([h.plugin.settle(b), h.plugin.settle(b)])
  const entry = await chatEntry(join(cwd, '.context-graph'), 'sB')
  assert.deepEqual([...entry.used].sort(), ['c1n1', 'c1n2', 'c1n3'])
  assert.equal(counters(entry.c).used, 3)
}))

test('deleting a chat\'s memory keeps what it cost and saved in the workspace totals (#107)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await withMeter()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const dir = join(cwd, '.context-graph')
  await until(async () => (await costOf(cwd, 'sA')).indexIn === 700)
  await removeChat(dir, 'sA', { builtSeq: 8 })
  assert.equal((await costOf(cwd, 'sA')).indexIn, 700)
  assert.deepEqual(Object.keys(JSON.parse(await readFile(join(dir, 'chats', 'sA', 'meta.json'), 'utf8'))).sort(), ['builtSeq', 'forgotten'], 'the memory itself is gone')
}))
