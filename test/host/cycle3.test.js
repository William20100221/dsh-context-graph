/**
 * Host tests for the cycle-3 audit fixes (v0.9.0).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle3.test.js
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle3-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const topicOf = (label, aliases, msgs) => JSON.stringify({ nodes: [{ label, gist: `${label}, decided`, aliases, kind: 'decision', msgs }], edges: [] })

test('#59 what is typed while memory is off is never indexed or served, before or after on', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const sessionQuery = { async observeSession(sid) { return { events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } }
  // The model cites everything it is shown, so anything read would be stored.
  const llm = scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return topicOf('everything said', ['access key', 'deploy'], Array.from({ length: n }, (_, i) => i)) } })
  const h = await setup({ buildMinChars: 1 }, llm, { sessionQuery })
  const a = agentOf('sA', cwd, chatEvents(4))
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  a.session.append(user('Before off: we deploy on Fridays from now on.'))
  a.session.append(assistant('ok'))
  await h.run(a, 'off')
  a.session.append(user('Private: my access key is AKIA-SECRET-4921'))
  a.session.append(assistant('noted'))
  await h.run(a, 'on')
  await until(() => llm.calls === 2)
  await until(async () => (await metaOf(cwd, 'sA')).builtSeq > 8)
  const stored = await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'msgs.json'), 'utf8')
  assert.match(stored, /deploy on Fridays/, 'the turn before off is still indexed')
  assert.doesNotMatch(stored, /AKIA-SECRET/, 'the turn typed while off is not')
  assert.doesNotMatch(llm.prompts[1], /AKIA-SECRET/, 'and the model never saw it')
  const b = agentOf('sB', cwd, [system()])
  assert.equal((await h.recall(b, 'c1t6')).status, 'unknown', 'the off turn is not served from the log')
  assert.match((await h.recall(b, 'c1t5')).text, /deploy on Fridays/)
}))

test('#60 a fork of a private chat starts private, titled from its own first prompt', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const parentEvents = [system(), user('Private: my divorce settlement terms'), assistant('ok'), ...chatEvents(3).slice(1)]
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  await h.run(parent, 'unshare')
  for (const header of [{ isSeeded: true, parentSession: 'sP' }, { isSeeded: true }]) {
    const sid = header.parentSession ? 'sF1' : 'sF2'
    const fork = agentOf(sid, cwd, [...parentEvents, user('in the fork: the custody schedule'), assistant('ok')], { header, inheritedEventCount: parentEvents.length })
    await h.run(fork, 'build')
    const meta = await metaOf(cwd, sid)
    assert.equal(meta.private, true, `${sid} inherits privacy`)
    assert.equal(meta.title, 'in the fork: the custody schedule', 'titled from its own first prompt')
    assert.doesNotMatch(JSON.stringify(meta), /divorce/, 'the inherited first prompt is kept as a fingerprint only')
  }
}))

test('#62 one chat whose topics cannot be read does not take memory away from the others', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const bad = join(cwd, '.context-graph', 'chats', 'sZ')
  await h.run(agentOf('sZ', cwd, chatEvents(4)), 'build')
  await rm(join(bad, 'topics.json'), { force: true })
  await mkdir(join(bad, 'topics.json'))
  const b = agentOf('sB', cwd, [system()])
  const out = await quietly(() => h.step(b, ask('gpg commit signing?')))
  assert.equal(out.messages.length, 2, 'the readable chat still answers')
  assert.match((await quietly(() => h.run(b, ''))).text, /^Memory on/)
}))

test('#64 on tells a private chat that it stays private', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'unshare')
  await h.run(a, 'off')
  const on = await h.run(a, 'on')
  assert.match(on.text, /it stays private; \/context-graph share lets other chats use it/)
  assert.doesNotMatch(on.text, /other chats in this workspace can use it/)
}))

test('#65 a turn running when on was run is indexed when it ends', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, [system(), { type: 'turn/start' }, user('the running question about the deploy key'), assistant('thinking')])
  await h.run(a, 'on')
  await wait(150)
  a.session.append(assistant('Decision: rotate the deploy key yearly.'))
  a.session.append({ type: 'turn/end' })
  const calls = h.llm.calls
  // Repeated rather than timed turn ends, so a slow machine cannot make the test fail.
  await until(async () => { h.listeners['agent/turn-stopping']({ agent: a }); await wait(30); return h.llm.calls === calls + 1 })
  assert.match(h.llm.prompts.at(-1), /rotate the deploy key yearly/)
}))

test('#67 a topic recall gives the long answer what the short prompt left', { skip }, () => inWorkspace(async (cwd) => {
  const answer = 'The decision, in full: '.padEnd(2800, 'x')
  const h = await setup({}, scriptedLlm({ reply: topicOf('release process', ['release'], [0, 1]) }))
  await h.run(agentOf('sA', cwd, [system(), user('how do we release?'), assistant(answer), ...chatEvents(3).slice(1)]), 'build')
  const text = (await h.recall(agentOf('sB', cwd, [system()]), 'c1n1')).text
  assert.doesNotMatch(text, /chars cut/, 'an 800-token answer under a 1000-token budget is shown whole')
}))

test('#67 the shared budget holds for the source as a whole, not per message', { skip }, () => inWorkspace(async (cwd) => {
  const { estimateTokens } = await import('../../src/core/index.js')
  const long = (word) => `${word} `.repeat(700)
  const h = await setup({ sourceMaxTokens: 300 }, scriptedLlm({ reply: topicOf('release process', ['release'], [0, 1, 2]) }))
  await h.run(agentOf('sA', cwd, [system(), user(long('alpha')), assistant(long('beta')), user(long('gamma')), assistant('ok'), ...chatEvents(3).slice(1)]), 'build')
  const text = (await h.recall(agentOf('sB', cwd, [system()]), 'c1n1')).text
  assert.ok(estimateTokens(text) < 300 + 120, `about ${estimateTokens(text)} tokens for a 300-token source budget`)
}))

test('#68 the recall tool costs about 80 tokens per request', { skip }, async () => {
  const { tools } = await setup()
  const { estimateTokens } = await import('../../src/core/index.js')
  const cost = estimateTokens(tools[0].name + tools[0].description + JSON.stringify(tools[0].parameters))
  assert.ok(cost <= 85, `recall definition ~${cost} tokens (v0.8.0: 106)`)
  assert.match(tools[0].description, /c3n12[\s\S]*c3t7[\s\S]*2026-11-01[\s\S]*t7/)
  const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')
  assert.match(readme, /the `recall` tool definition, about 80 tokens/, 'the README says the measured cost (#37)')
})
