/**
 * Host tests for the review of the cycle-4 change (v0.10.0): turn ids stored by 0.9.0 (K2, K9), the
 * chat list on a later first block (K3), a damaged msgs.json that cannot be moved aside on the read
 * paths (K11), and a quiet index once per regular cycle (R0). Each test fails without its fix.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-review-host.test.js
 */
import assert from 'node:assert/strict'
import fsp, { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4rh-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const chat = (cwd, sid) => join(cwd, '.context-graph', 'chats', sid)
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(chat(cwd, sid), 'meta.json'), 'utf8'))
const blockOf = (out) => (out.messages.length > 1 ? out.messages.at(-1).content[0].text : '')
const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
/** A builder model that cites every message it is shown. */
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'all of it', aliases: [], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
/** dsh's sessionQuery over the test's own logs; a chat missing from `logs` cannot be read. */
const queryOf = (logs) => ({ async observeSession(sid) { return { events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } })

/** While `fn` runs, moving a file aside fails as on Windows while a sync tool or a scan holds it (EBUSY). */
async function holdingAside(fn) {
  const rename = fsp.rename
  fsp.rename = async (from, to) => {
    if (String(to).includes('.corrupt-')) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' })
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try { return await fn() } finally {
    fsp.rename = rename
    syncBuiltinESMExports()
  }
}

test('K2 K9 turn ids stored by 0.9.0 are relabelled before a topic names them, and named nowhere while the log cannot be read', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = agentOf('sA', cwd, [system(),
    ...turn(1, user('pick the signing key type'), assistant('ed25519?')),
    ...turn(2, user('yes'), assistant('Creating it.'), user('and name it id_signing'), assistant('Named it id_signing.'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  const file = join(chat(cwd, 'sA'), 'msgs.json')
  const stored = async () => JSON.parse(await readFile(file, 'utf8'))
  assert.equal((await stored()).v, 2, 'a new store is numbered by dsh\'s turns')
  // msgs.json as 0.9.0 left it: every typed prompt counted as a turn, so the steer is turn 3.
  const asOld = async () => {
    const store = await stored()
    for (const [i, m] of Object.values(store.m).entries()) m.t = [1, 1, 2, 2, 3, 3][i]
    await writeFile(file, JSON.stringify({ ...store, v: 1 }))
  }
  await asOld()
  const b = agentOf('sB', cwd, [system()])
  logs.delete('sA')
  const unnamed = (await h.recall(b, 'c1n1')).text
  assert.match(unnamed, /assistant:\nNamed it id_signing\.\n`+\n3 older source messages\.$/)
  assert.doesNotMatch(unnamed, /c1t\d/, 'no turn named while chat A\'s log cannot be read')
  logs.set('sA', a.session.log)
  const named = (await h.recall(b, 'c1n1')).text
  assert.match(named, /user \(c1t2\):\nand name it id_signing\n\nassistant \(c1t2\):\nNamed it id_signing\.\n`+\n3 older source messages in c1t1, c1t2\.$/)
  assert.match((await h.recall(b, 'c1t2')).text, /and name it id_signing/, 'the id opens the turn it came from')
  assert.equal((await h.recall(b, 'c1t3')).status, 'unknown')
  const relabelled = await stored()
  assert.deepEqual([relabelled.v, Object.values(relabelled.m).map((m) => m.t)], [2, [1, 1, 2, 2, 2, 2]])
  // This chat's own recall relabels from its live session.
  await asOld()
  assert.match((await h.recall(a, 'n1')).text, /user \(t2\):\nand name it id_signing/)
  assert.equal((await stored()).v, 2)
}))

test('K3 the chat list rides with the first block or a question about earlier work on any turn, once', { skip }, () => inWorkspace(async (cwd) => {
  await (await setup()).run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const h = await setup()
  // One turn: the block it got ('' for none), then the answer.
  const say = async (run, agent, text) => {
    const out = await run.step(agent, ask(text))
    agent.session.append(assistant('ok'))
    return blockOf(out)
  }
  const seqOf = (agent, re) => agent.session.log.findIndex((e) => e.data?.source?.kind === 'context-graph' && re.test(e.data.content[0].text))
  const b = agentOf('sB', cwd, [system()])
  assert.equal(await say(h, b, 'hi! quick one before we start'), '')
  assert.match(await say(h, b, 'what did we work on before?'), /^\[context-graph\] Earlier chats in this workspace/)
  assert.match(await say(h, b, 'and how do we do commit signing with gpg?'), /^\[context-graph\] Notes from other chats[^\n]*\n- c1n1 commit signing/, 'listed once')
  const c = agentOf('sC', cwd, [system()])
  assert.equal(await say(h, c, 'hi! quick one before we start'), '')
  assert.match(await say(h, c, 'how do we do commit signing with gpg?'), /^\[context-graph\] Earlier chats in this workspace[\s\S]*\n- c1n1 commit signing/, 'with its first block')
  // A compaction in the same run does not bring it back...
  const listed = seqOf(c, /Earlier chats/)
  c.session.compact(listed, listed)
  assert.equal(await say(h, c, 'what did we work on before?'), '')
  // ...nor an app restart of a chat whose surface still holds a block (chat B: only its list is gone).
  const list = seqOf(b, /Earlier chats/)
  b.session.compact(list, list)
  assert.equal(await say(await setup(), b, 'what did we work on before?'), '')
}))

test('K11 a damaged msgs.json that cannot be moved aside reads as no stored source: blocks still go, recall says so', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const events = chatEvents(4)
  await h.run(agentOf('sA', cwd, events), 'build')
  const file = join(chat(cwd, 'sA'), 'msgs.json')
  const damaged = (await readFile(file, 'utf8')).slice(0, -7)
  await writeFile(file, damaged, 'utf8')
  await quietly(() => holdingAside(async () => {
    // The lead hit's source cannot be inlined; its topic line still goes.
    assert.match(blockOf(await h.step(agentOf('sB', cwd, [system()]), ask('how do we do commit signing with gpg?'))), /\n- c1n1 commit signing/)
    // A fork of chat A cannot compare what it holds: the topic is sent, not the whole block dropped.
    const fork = agentOf('sF', cwd, [...events, user('in the fork')], { header: { isSeeded: true }, inheritedEventCount: events.length })
    assert.match(blockOf(await h.step(fork, ask('how do we do commit signing with gpg?'))), /\n- c1n1 commit signing/)
    const c = agentOf('sC', cwd, [system()])
    assert.match((await h.recall(c, 'c1n1')).text, /\n\(no source text stored for this topic\)$/)
    assert.equal((await h.recall(c, 'c1t1')).status, 'unknown', 'a turn from stored messages: none either')
  }))
  assert.equal(await readFile(file, 'utf8'), damaged, 'left as it was')
}))

test('R0 a chat with pauses is indexed once quiet at most once between two regular builds, after 30 minutes', { skip }, () => inWorkspace(async (cwd) => {
  const timers = []
  const timer = { timeout(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { timer })
  const a = agentOf('sA', cwd, chatEvents(2))
  h.listeners['agent/turn-stopping']({ agent: a })
  const [armed] = await until(() => timers.length === 1 && timers)
  assert.equal(armed.ms, 1800000, 'thirty minutes')
  armed.live = false
  armed.fn()
  await until(() => h.llm.calls === 1)
  await until(async () => (await metaOf(cwd, 'sA')).builtSeq === a.session.log.length - 1)
  // The user comes back after each pause. A turn end's work is done once touch() has moved an old
  // last-active time (it runs right after the quiet check).
  const OLD = '2026-01-01T00:00:00.000Z'
  let n = 0
  const turnEnd = async () => {
    await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, lastActiveAt: OLD }))
    a.session.append(user(`We decided to sign commits with the SSH key, step ${++n}. `.repeat(8)))
    a.session.append(assistant('ok'))
    h.listeners['agent/turn-stopping']({ agent: a })
    await until(async () => (await metaOf(cwd, 'sA')).lastActiveAt !== OLD)
  }
  for (let i = 0; i < 3; i++) await turnEnd()
  assert.equal(timers.length, 1, 'not armed again before a regular build')
  // The fourth turn since the quiet index is a regular build; after it the chat may wait again.
  a.session.append(user(`We decided to sign commits with the SSH key, step ${++n}. `.repeat(8)))
  a.session.append(assistant('ok'))
  h.listeners['agent/turn-stopping']({ agent: a })
  await until(() => h.llm.calls === 2)
  await until(async () => (await metaOf(cwd, 'sA')).builtSeq === a.session.log.length - 1)
  await turnEnd()
  assert.equal(timers.length, 2)
  assert.ok(timers[1].live)
}))

test('second review: after its quiet index a chat\'s last turns are still indexed when a new chat starts, and only a flush that indexed counts', { skip }, () => inWorkspace(async (cwd) => {
  const timers = []
  const timer = { timeout(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { timer })
  const a = agentOf('sA', cwd, chatEvents(2))
  h.listeners['agent/turn-stopping']({ agent: a })
  const [armed] = await until(() => timers.length === 1 && timers)
  armed.live = false
  armed.fn()
  await until(() => h.llm.calls === 1)
  await until(async () => (await metaOf(cwd, 'sA')).builtSeq === a.session.log.length - 1)
  // The user comes back for the conclusion, then moves on to a new chat of the workspace.
  const OLD = '2026-01-01T00:00:00.000Z'
  await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, lastActiveAt: OLD }))
  a.session.append(user('Decision: the staging proxy listens on port 8443. '.repeat(10)))
  a.session.append(assistant('ok'))
  h.listeners['agent/turn-stopping']({ agent: a })
  await until(async () => (await metaOf(cwd, 'sA')).lastActiveAt !== OLD)
  assert.equal(timers.length, 1, 'no second timer before a regular build (R0)')
  // It had its quiet index in this cycle: indexed a few minutes after the new chat starts (third check).
  h.listeners['agent/status']({ agent: agentOf('sB', cwd, [system()]), status: 'running' })
  const left = await until(() => timers.length === 2 && timers[1])
  assert.equal(left.ms, 300000)
  assert.equal(h.llm.calls, 1, 'not at once')
  left.live = false
  left.fn()
  await until(() => h.llm.calls === 2)
  assert.match(h.llm.prompts.at(-1), /port 8443/)

  // A timer that fires while memory is off indexes nothing, so it does not use up the chat's quiet index.
  const c = agentOf('sC', cwd, chatEvents(2))
  h.listeners['agent/turn-stopping']({ agent: c })
  const second = await until(() => timers.length === 3 && timers[2])
  await h.run(c, 'off')
  second.live = false
  second.fn()
  await h.run(c, 'on')
  await until(() => h.llm.calls === 3)
  await until(async () => (await metaOf(cwd, 'sC')).builtSeq === c.session.log.length - 1)
  c.session.append(user('We also rotate the deploy key every 90 days. '.repeat(12)))
  c.session.append(assistant('ok'))
  h.listeners['agent/turn-stopping']({ agent: c })
  await until(() => timers.length === 4)
  assert.ok(timers[3].live)
}))

test('third check: a quick side question in another chat costs no index of a chat already indexed once quiet, and a model that keeps failing is not called at every pause', { skip }, () => inWorkspace(async (cwd) => {
  const timers = []
  const timer = { timeout(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { timer })
  const a = agentOf('sA', cwd, chatEvents(2))
  h.listeners['agent/turn-stopping']({ agent: a })
  const [armed] = await until(() => timers.length === 1 && timers)
  armed.live = false
  armed.fn()
  await until(async () => (await metaOf(cwd, 'sA').catch(() => ({}))).builtSeq === a.session.log.length - 1)
  const OLD = '2026-01-01T00:00:00.000Z'
  await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, lastActiveAt: OLD }))
  a.session.append(user('Decision: the staging proxy listens on port 8443. '.repeat(10)))
  a.session.append(assistant('ok'))
  h.listeners['agent/turn-stopping']({ agent: a })
  await until(async () => (await metaOf(cwd, 'sA')).lastActiveAt !== OLD)
  // A side question, then back to A before the few minutes are up.
  h.listeners['agent/status']({ agent: agentOf('sSide', cwd, [system()]), status: 'running' })
  const left = await until(() => timers.length === 2 && timers[1])
  h.listeners['agent/status']({ agent: a, status: 'running' })
  assert.equal(left.live, false, 'cancelled by the turn in A')
  left.fn()
  await wait(100)
  assert.equal(h.llm.calls, 1)

  // A model whose answers cannot be used: its failed quiet index counts as the cycle's one.
  const junk = await setup({}, scriptedLlm({ reply: 'not json at all' }), { timer })
  const c = agentOf('sC', cwd, chatEvents(2))
  junk.listeners['agent/turn-stopping']({ agent: c })
  const third = await until(() => timers.length === 3 && timers[2])
  third.live = false
  third.fn()
  await until(() => junk.llm.calls === 1)
  await until(async () => /could not|unusable|failed/.test((await junk.run(c, 'stats')).text))
  await updateMeta(join(cwd, '.context-graph'), 'sC', (m) => ({ ...m, lastActiveAt: OLD }))
  c.session.append(user('We also rotate the deploy key every 90 days. '.repeat(12)))
  c.session.append(assistant('ok'))
  junk.listeners['agent/turn-stopping']({ agent: c })
  // The turn end's work is done once touch() has moved the old last-active time (after the quiet check).
  await until(async () => (await metaOf(cwd, 'sC')).lastActiveAt !== OLD)
  assert.equal(timers.length, 3, 'no new timer after a failed quiet index')
}))
