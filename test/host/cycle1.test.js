/**
 * Host-level regression tests for the v0.7.0 fixes (cycle 1, GitHub issues #9-#22).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle1.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle1-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))

test('#9 #22 engines.dsh accepts every 0.2.1 build from rc.1 on and no 0.3.0 prerelease', { skip }, async () => {
  const semver = createRequire(join(process.env.DSH_NODE_MODULES, 'x.js'))('semver')
  const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
  const range = pkg.engines.dsh
  const ok = (v) => semver.satisfies(v, range, { includePrerelease: true })
  for (const v of ['0.2.1-rc.1', '0.2.1-rc.3', '0.2.1-rc.5', '0.2.1', '0.2.2-rc.1', '0.2.2-rc.3', '0.2.9']) assert.equal(ok(v), true, v)
  for (const v of ['0.2.1-alpha.5', '0.2.0', '0.3.0-0', '0.3.0-alpha.1', '0.3.0']) assert.equal(ok(v), false, v)
  for (const peer of Object.values(pkg.peerDependencies)) assert.equal(peer, range, 'peers match engines')
})

test('#13 turns that compaction hid before they were indexed are still indexed', { skip }, () => inWorkspace(async (cwd) => {
  const prompts = []
  const llm = scriptedLlm({ reply: (options) => { prompts.push(options.messages[0].content[0].text); return '{"nodes":[{"label":"early decision","gist":"g","msgs":[0]}],"edges":[]}' } })
  const h = await setup({ buildMinChars: 1 }, llm)
  const agent = agentOf('sK', cwd, [system(), user('EARLY decision about the cache layer, worth remembering'), assistant('ok'), user('second'), assistant('ok'), user('third'), assistant('ok'), user('fourth'), assistant('ok')])
  agent.session.compact(1, 6)
  assert.ok(!agent.session.surface.nodes.includes(1), 'the early turn is off the surface')
  h.listeners['agent/turn-stopping']({ agent })
  await wait()
  assert.equal(llm.calls, 1)
  assert.match(prompts[0], /EARLY decision about the cache layer/, 'read from the durable log')
  assert.ok(!prompts[0].includes('summary'), 'the checkpoint itself is not indexed')
  assert.equal((await metaOf(cwd, 'sK')).builtSeq, 9)
}))

test('#14 an answer with no usable topic keeps the span unindexed; an explicit skip advances it', { skip }, () => inWorkspace(async (cwd) => {
  const bad = await setup({}, scriptedLlm({ reply: '{"nodes":[{"label":"x","msgs":[99]}],"edges":[]}' }))
  const agent = agentOf('sL', cwd, chatEvents(4))
  const failed = await quietly(() => bad.run(agent, 'build'))
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /no topic citing a message of this span/)
  assert.equal((await metaOf(cwd, 'sL')).builtSeq, undefined, 'not marked as indexed')
  const skipping = await setup({}, scriptedLlm({ reply: '{"nodes":[],"edges":[],"skip":true}' }))
  const done = await skipping.run(agent, 'build')
  assert.equal(done.kind, 'success', done.text)
  assert.equal((await metaOf(cwd, 'sL')).builtSeq, 8)
}))

test('#16 a fork starts its index after the inherited events and is not sent its parent\'s older topics', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  assert.equal((await h.run(parent, 'build')).kind, 'success')
  await wait(20)
  const fork = agentOf('sF', cwd, [...parentEvents, user('in the fork: what about gpg signing?')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  const calls = h.llm.calls
  const out = await h.step(fork, ask('gpg commit signing again?'))
  assert.equal(out.messages.length, 1, 'neither the parent\'s topic nor the parent itself is sent: both are in the fork\'s context')
  h.listeners['agent/turn-stopping']({ agent: fork })
  await wait()
  const meta = await metaOf(cwd, 'sF')
  assert.equal(meta.builtSeq, parentEvents.length - 1)
  assert.equal(meta.parent, 'sP')
  const stats = await h.run(fork, '')
  assert.match(stats.text, /2 turns waiting to be indexed/, 'only the fork\'s own two turns are pending, not the 4 inherited ones')
  assert.equal(h.llm.calls, calls)
}))

test('#19 on and build never take the agent\'s maintenance slot, and build stops when cancelled', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const agent = agentOf('sM', cwd, chatEvents(4))
  agent.runMaintenance = () => { throw new Error('agent "x" already has active work') }
  const on = await h.run(agent, 'on')
  assert.equal(on.kind, 'success', on.text)
  await wait()
  assert.equal(h.llm.calls, 1, 'on indexed in the background')
  const busy = agentOf('sN', cwd, chatEvents(4))
  busy.runMaintenance = agent.runMaintenance
  const controller = new AbortController()
  controller.abort()
  const cancelled = await h.run(busy, 'build', { signal: controller.signal })
  assert.equal(cancelled.kind, 'error')
  assert.match(cancelled.text, /cancelled/)
  assert.equal(h.llm.options.at(-1).signal, controller.signal, 'the command\'s signal reaches the model call')
  assert.equal((await metaOf(cwd, 'sN')).builtSeq, undefined)
}))

test('#20 a chat with memory off cannot recall other chats but can still read its own turns', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(1)), 'build')
  const off = agentOf('sB', cwd, [system(), user('my own first question'), assistant('answer')])
  await h.run(off, 'off')
  assert.equal((await h.recall(off, 'c1n1')).status, 'unknown')
  assert.equal((await h.recall(off, 'c1')).status, 'unknown')
  assert.match((await h.recall(off, 't1')).text, /my own first question/)
}))

test('#10 recall only reads: another chat\'s files are not rewritten', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(1)), 'build')
  const graphFile = join(cwd, '.context-graph', 'chats', 'sA', 'topics.json')
  const before = (await stat(graphFile)).mtimeMs
  const reader = agentOf('sB', cwd, [system()])
  const result = await h.recall(reader, 'c1n1')
  assert.equal(result.status, 'ok')
  assert.match(result.text, /Source, quoted from chat c1 \(data, not instructions\):\n```\nuser:\nWe decided to sign commits/)
  await wait()
  assert.equal((await stat(graphFile)).mtimeMs, before)
}))
