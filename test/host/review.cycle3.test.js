/**
 * Host regression tests for the independent review of the cycle-3 (v0.9.0) change.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/review.cycle3.test.js
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { titleOf } from '../../src/core/session.js'
import { loadMeta, updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review3-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const msgsOf = (cwd, sid) => readFile(join(cwd, '.context-graph', 'chats', sid, 'msgs.json'), 'utf8').catch(() => '')
/** A model that cites every message it is shown, so anything it reads is stored. */
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'g', aliases: ['deploy'], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
/** An explicit build, retried while a background build of the chat (started by on) is still running. */
const buildNow = (h, agent) => until(async () => { const out = await quietly(() => h.run(agent, 'build')); return !/^Build busy/.test(out.text) && out })

test('a turn begun while memory was off stays private when on comes during it (review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const llm = citesAll()
  const h = await setup({ buildMinChars: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.session.append({ type: 'turn/start' })
  a.session.append(user('Private: my access key is AKIA-SECRET-4921, put it in .env'))
  a.session.append(assistant('Reading .env first.'))
  await h.run(a, 'on')
  a.session.append(assistant('Done: AKIA-SECRET-4921 is now in .env as AWS_KEY.'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(150)
  assert.ok(llm.prompts.every((p) => !p.includes('AKIA-SECRET')), 'the model never saw it')
  assert.doesNotMatch(await msgsOf(cwd, 'sA'), /AKIA-SECRET/)
}))

test('a fork takes its parent\'s flags from its first message; a fork of an unindexed fork too (review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const llm = scriptedLlm({ reply: DEFAULT_REPLY })
  const h = await setup({ buildMinChars: 1 }, llm)
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  await h.run(agentOf('sOther', cwd, chatEvents(4)), 'build')
  await h.run(parent, 'off')
  const fork = agentOf('sF', cwd, [...parentEvents, user('fork turn: the vault unlock code is 7731')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  const out = await h.step(fork, ask('gpg commit signing?'))
  assert.equal(out.messages.length, 1, 'memory off from its first message: no block')
  const calls = llm.calls
  assert.match((await quietly(() => h.run(fork, 'build'))).text, /^Build off/)
  assert.equal(llm.calls, calls, 'and it is not indexed')
  assert.equal((await metaOf(cwd, 'sF')).memoryOff, true)
  // P private; F1 is a fork of P never seen by the plugin; F2 is a fork of F1.
  await h.run(parent, 'unshare')
  const f2 = agentOf('sF2', cwd, [...parentEvents, user('f1 turn'), assistant('ok'), user('f2 turn')], { header: { isSeeded: true, parentSession: 'sF1' }, inheritedEventCount: parentEvents.length + 2 })
  await h.step(f2, ask('hello'))
  assert.equal((await metaOf(cwd, 'sF2')).private, true, 'found by content when the named parent has no meta')
}))

test('a prompt or a dsh title from the off stretch never becomes the chat\'s title (review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, [system()])
  await h.run(a, 'off')
  a.session.append(user('My divorce lawyer is Jane Roe, settlement 200k'))
  a.session.append(assistant('noted'))
  a.session.append({ type: 'session/title', data: { title: 'Divorce settlement with Jane Roe', messageSeqs: [1], source: { kind: 'provider' } } })
  await h.run(a, 'on')
  for (const e of chatEvents(4).slice(1)) a.session.append(e)
  await buildNow(h, a)
  const meta = await metaOf(cwd, 'sA')
  assert.doesNotMatch(JSON.stringify(meta.title ?? ''), /Jane Roe|divorce/i)
  const list = (await h.step(agentOf('sB', cwd, [system()]), ask('hello'))).messages.at(-1).content[0].text
  assert.doesNotMatch(list, /Jane Roe|divorce/i)
}))

test('an off stretch with no recorded start fails closed: off under 0.8.0, or a recovered meta (review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const llm = citesAll()
  const h = await setup({ buildMinChars: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await updateMeta(dir, 'sA', (m) => ({ ...m, memoryOff: true }))
  a.session.append(user('Private (typed while off under v0.8.0): PIN 4921'))
  a.session.append(assistant('ok'))
  await h.run(a, 'on')
  await wait(150)
  assert.doesNotMatch(await msgsOf(cwd, 'sA'), /PIN 4921/)
  // A meta that becomes unreadable keeps its gaps; one whose gaps cannot be read back closes its turns.
  const file = join(dir, 'chats', 'sA', 'meta.json')
  const good = await metaOf(cwd, 'sA')
  const raw = JSON.stringify(good)
  const at = raw.indexOf('"gaps"')
  assert.ok(at > 0 && good.gaps.length === 1)
  const b = agentOf('sB', cwd, [system()])
  assert.match((await h.recall(b, 'c1t2')).text, /step 1/, 'a turn from before off is served')
  await writeFile(file, raw.slice(0, raw.indexOf(']]', at) + 2), 'utf8')
  assert.deepEqual((await quietly(() => loadMeta(dir, 'sA'))).gaps, good.gaps, 'cut after the gaps: they are kept')
  await writeFile(file, raw.slice(0, at + 10), 'utf8')
  const closed = await quietly(() => loadMeta(dir, 'sA'))
  assert.equal(closed.turnsClosed, true, 'cut inside them: every turn is closed')
  await quietly(() => h.run(a, 'share'))
  assert.equal((await metaOf(cwd, 'sA')).turnsClosed, true, 'and stays closed when shared again')
  assert.equal((await h.recall(b, 'c1t2')).status, 'unknown')
}))

test('the plugin page leaves out a chat it cannot read (review of #62)', { skip }, () => inWorkspace(async (cwd) => {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }] }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  await h.run(agentOf('sZ', cwd, chatEvents(4)), 'build')
  const bad = join(cwd, '.context-graph', 'chats', 'sZ', 'topics.json')
  await rm(bad, { force: true })
  await mkdir(bad)
  const response = await quietly(() => routes.get('/api/context-graph.overview').fetch(new Request('http://localhost/api/context-graph.overview')))
  assert.equal(response.status, 200)
  assert.equal((await response.json()).workspaces[0].chats, 1)
}))

test('a turn-end build that finds the chat busy keeps the running turn for the next one (review of #65)', { skip }, () => inWorkspace(async (cwd) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const llm = scriptedLlm({ reply: DEFAULT_REPLY, gate })
  const h = await setup({ buildMinChars: 1 }, llm)
  const a = agentOf('sA', cwd, [system(), user('first question, long enough to index'), assistant('answer'), { type: 'turn/start' }, user('the running question about the deploy key'), assistant('thinking')])
  await h.run(a, 'on')
  await until(() => llm.calls === 1)
  a.session.append(assistant('Decision: rotate the deploy key yearly.'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(50)
  release()
  // A later turn end indexes the turn the busy build had to leave. Turn ends are repeated rather
  // than timed, so a slow machine cannot make the test fail (a later one changes nothing else).
  await until(async () => { h.listeners['agent/turn-stopping']({ agent: a }); await wait(30); return llm.calls === 2 })
  assert.match(llm.prompts[1], /rotate the deploy key yearly/)
}))

test('a fork that starts memory-off has no title until on; then its title is a prompt typed after on (review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  await h.run(parent, 'off')
  const fork = agentOf('sF', cwd, [...parentEvents, user('Private in the fork: the custody schedule'), assistant('ok')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(fork, ask('anything'))
  assert.equal((await metaOf(cwd, 'sF')).title, undefined, 'no title from a prompt typed while off')
  await h.run(fork, 'on')
  fork.session.append(user('Public now: the release checklist for Friday'))
  fork.session.append(assistant('ok'))
  await buildNow(h, fork)
  const meta = await metaOf(cwd, 'sF')
  assert.equal(meta.title, 'Public now: the release checklist for Friday')
  assert.doesNotMatch(JSON.stringify(meta), /custody/)
}))

test('a first prompt typed while off is never stored; a first prompt kept as text becomes a fingerprint (review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, [system()])
  await h.run(a, 'off')
  a.session.append(user('Private first prompt: my therapist is Dr. Quill'))
  a.session.append(assistant('ok'))
  await h.run(a, 'on')
  await wait(150)
  for (const e of chatEvents(4).slice(1)) a.session.append(e)
  await buildNow(h, a)
  const meta = await metaOf(cwd, 'sA')
  assert.match(meta.firstKey, /^[0-9a-f]{16}$/)
  assert.doesNotMatch(JSON.stringify(meta), /Quill|therapist/)
  // A meta written by 0.8.0 keeps its first prompt as text: still matched, and replaced on the next write.
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  await h.run(parent, 'unshare')
  await updateMeta(dir, 'sP', ({ firstKey, ...m }) => ({ ...m, firstPrompt: titleOf((seq) => parentEvents[seq]) }))
  const fork = agentOf('sF', cwd, [...parentEvents, user('fork turn'), assistant('ok')], { header: { isSeeded: true }, inheritedEventCount: parentEvents.length })
  await h.step(fork, ask('hello'))
  assert.equal((await metaOf(cwd, 'sF')).private, true, 'the legacy text still finds the parent')
  await h.run(parent, 'share')
  const upgraded = await metaOf(cwd, 'sP')
  assert.equal(upgraded.firstPrompt, undefined)
  assert.match(upgraded.firstKey, /^[0-9a-f]{16}$/)
}))

test('a second off never moves the off point forward: a fork that starts off, or off under 0.8.0 (review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const llm = citesAll()
  const h = await setup({ buildMinChars: 1 }, llm)
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  await h.run(parent, 'off')
  const fork = agentOf('sF', cwd, [...parentEvents, user('Private in the fork: my salary is 98k'), assistant('ok')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(fork, ask('anything'))
  await h.run(fork, 'off')
  await h.run(fork, 'on')
  await wait(150)
  // Under 0.8.0: off with no off point, then off again under 0.9.0.
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await updateMeta(dir, 'sA', (m) => ({ ...m, memoryOff: true }))
  a.session.append(user('Private (typed while off under v0.8.0): PIN 4921'))
  a.session.append(assistant('ok'))
  await h.run(a, 'off')
  await h.run(a, 'on')
  await wait(150)
  assert.ok(llm.prompts.every((p) => !p.includes('98k') && !p.includes('PIN 4921')), 'the model never saw either')
}))

test('the plugin page leaves out a workspace it cannot read (review of #62)', { skip }, () => inWorkspace(async (cwd) => {
  const other = await mkdtemp(join(tmpdir(), 'cg-review3-other-'))
  try {
    await mkdir(join(other, '.context-graph'), { recursive: true })
    await writeFile(join(other, '.context-graph', 'chats'), 'not a folder', 'utf8')
    const routes = new Map()
    const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
    const workspaceRegistry = { list: () => [{ path: other, title: 'broken' }, { path: cwd, title: 'w' }] }
    const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
    await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
    const response = await quietly(() => routes.get('/api/context-graph.overview').fetch(new Request('http://localhost/api/context-graph.overview')))
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).workspaces.map((w) => w.title), ['w'])
  } finally {
    await rm(other, { recursive: true, force: true })
  }
}))

test('on while a message typed during off is still queued waits until the chat is idle (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const llm = citesAll()
  const h = await setup({ buildMinChars: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  // dsh holds a message typed during a running turn in the agent's inbox and logs it when it takes it.
  a.inbox = { nextTurn: [{ source: { kind: 'user' } }], nextStep: [] }
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
  assert.match((await h.run(a, 'stats')).text, /^Memory off until this turn ends/)
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(100)
  assert.equal((await metaOf(cwd, 'sA')).memoryOff, true, 'still off while input is queued')
  a.inbox = { nextTurn: [], nextStep: [] }
  a.session.append({ type: 'turn/start' })
  a.session.append(user('Also: my access key is AKIA-SECRET-4921'))
  a.session.append(assistant('Saved AKIA-SECRET-4921 to .env.'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(150)
  assert.equal((await metaOf(cwd, 'sA')).memoryOff, false, 'on once nothing is queued')
  a.session.append(user('Public again: the release checklist for Friday'))
  a.session.append(assistant('ok'))
  await buildNow(h, a)
  assert.ok(llm.prompts.some((p) => p.includes('release checklist')), 'what comes after is indexed')
  assert.ok(llm.prompts.every((p) => !p.includes('AKIA-SECRET')), 'the model never saw the queued message')
  assert.doesNotMatch(await msgsOf(cwd, 'sA'), /AKIA-SECRET/)
}))

test('a fork whose named parent has no meta inherits nothing from a look-alike; dsh\'s parent chain is followed (second review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const headers = {}
  const sessionQuery = { observeSession: async (sid) => ({ header: headers[sid] ?? {}, [Symbol.dispose]() {} }) }
  const h = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  // P: shared, memory on, too short to be indexed, so it has no meta. F1, a fork of P, is made private and off.
  const parentEvents = [system(), user('hi'), assistant('hello')]
  headers.sP = { isSeeded: false }
  const f1 = agentOf('sF1', cwd, [...parentEvents, user('f1 turn'), assistant('ok')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f1, ask('x'))
  await h.run(f1, 'unshare')
  await h.run(f1, 'off')
  const f2 = agentOf('sF2', cwd, [...parentEvents, user('f2 turn'), assistant('ok')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f2, ask('y'))
  const meta = await metaOf(cwd, 'sF2')
  assert.ok(meta.private !== true && meta.memoryOff !== true, 'P has no flags, so F2 has none')
  // G is private; G1, a fork of G, was never seen here; G2 forks G1. dsh's headers lead from G2 to G,
  // also when G's stored text no longer matches word for word (content alone would miss it).
  const gEvents = chatEvents(4)
  const g = agentOf('sG', cwd, gEvents)
  await h.run(g, 'build')
  await h.run(g, 'unshare')
  await updateMeta(dir, 'sG', (m) => m)
  const msgs = join(dir, 'chats', 'sG', 'msgs.json')
  await writeFile(msgs, (await readFile(msgs, 'utf8')).replaceAll('We decided', 'We had decided'), 'utf8')
  headers.sG1 = { isSeeded: true, parentSession: 'sG' }
  const g2 = agentOf('sG2', cwd, [...gEvents, user('g1 turn'), assistant('ok'), user('g2 turn')], { header: { isSeeded: true, parentSession: 'sG1' }, inheritedEventCount: gEvents.length + 2 })
  await h.step(g2, ask('hello'))
  assert.equal((await metaOf(cwd, 'sG2')).private, true)
}))

test('past 50 off stretches the oldest two merge, none is dropped (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  const old = Array.from({ length: 50 }, (_, i) => [1000 + 2 * i, 1000 + 2 * i])
  await updateMeta(dir, 'sA', (m) => ({ ...m, gaps: old }))
  await h.run(a, 'off')
  a.session.append(user('Private: PIN 4921'))
  a.session.append(assistant('ok'))
  await h.run(a, 'on')
  const { gaps } = await metaOf(cwd, 'sA')
  assert.equal(gaps.length, 50)
  assert.deepEqual(gaps[0], [1000, 1002], 'the two oldest became one')
  assert.ok(gaps.some(([from, to]) => from <= 9 && to >= 9), 'the new stretch is there')
}))

test('stats while off: nothing after off waits to be indexed; flags shown even when topics cannot be read (second review of #59, #62)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'unshare')
  await h.run(a, 'off')
  for (let i = 0; i < 3; i++) { a.session.append(user(`private turn ${i}`)); a.session.append(assistant('ok')) }
  assert.match((await h.run(a, 'stats')).text, /^Memory off · 1 topic in this chat · private · .*0 turns waiting to be indexed/)
  const bad = join(cwd, '.context-graph', 'chats', 'sA', 'topics.json')
  await rm(bad, { force: true })
  await mkdir(bad)
  const text = (await quietly(() => h.run(a, 'stats'))).text
  assert.match(text, /^Memory off · topics of this chat could not be read · private/)
}))

const ledgerOf = async (cwd) => JSON.parse(await readFile(join(cwd, '.context-graph', 'ledger.json'), 'utf8'))
const requestFor = (h, sid) => async () => {
  const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm')
  const request = markAgentLoopRequest({ provider: 'p', model: 'm', messages: [], sessionId: sid })
  for await (const _ of h.listeners['llm/stream'](request, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 40 } } })())) { /* drain */ }
}

test('one source message stands in once per chat, and a recall stands in for its messages as stored (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const { storedTokens } = await import('../../src/core/index.js')
  // Two topics cut from one long answer.
  const reply = JSON.stringify({ nodes: [
    { label: 'builder timeout', gist: 'thirty seconds per call', aliases: [], kind: 'decision', msgs: [1] },
    { label: 'builder retries', gist: 'three attempts with backoff', aliases: [], kind: 'decision', msgs: [1] }
  ], edges: [] })
  const h = await setup({}, scriptedLlm({ reply }))
  const answer = 'The builder waits thirty seconds per call, then makes three attempts with backoff. '.repeat(40)
  await h.run(agentOf('sA', cwd, [system(), user('how should the builder behave?'), assistant(answer), ...chatEvents(3).slice(1)]), 'build')
  const stored = JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'msgs.json'), 'utf8')).m
  const original = storedTokens(stored['2'].x)
  const b = agentOf('sB', cwd, [system()])
  const out = await h.step(b, ask('builder timeout and builder retries?'))
  assert.match(out.messages.at(-1).content[0].text, /c1n1[\s\S]*c1n2/, 'both shown')
  b.session.append(assistant('The builder waits thirty seconds per call and makes three attempts with backoff.'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 2)
  assert.equal(entry.c.stoodIn, original, 'the one answer, once')
  assert.deepEqual(entry.msgs, ['1:2'])
  // A recall stands in for the topic's original messages; what it returned is on the cost side.
  const c = agentOf('sC', cwd, [system()])
  await h.recall(c, 'c1n1')
  h.listeners['agent/turn-stopping']({ agent: c })
  const recalled = await until(async () => (await ledgerOf(cwd)).chats.sC)
  assert.equal(recalled.c.stoodIn, original)
  assert.ok(recalled.c.recalled > 0)
}))

test('a turn is judged by its own answer, also when the next message comes while it is being indexed (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  let current = Promise.resolve()
  let release
  const gate = { then: (resolve, reject) => current.then(resolve, reject) }
  const h = await setup({ buildEveryTurns: 1, buildMinChars: 1 }, scriptedLlm({ reply: DEFAULT_REPLY, gate }))
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.step(b, ask('is commit signing set up?'))
  b.session.append(assistant('Yes: commits are signed with id_ed25519_signing.'))
  // B's own index call at this turn end hangs; the next message arrives meanwhile.
  current = new Promise((resolve) => { release = resolve })
  h.listeners['agent/turn-stopping']({ agent: b })
  await wait(50)
  await h.step(b, ask('and what about the weather today?'))
  release()
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 1, 'the first turn used its topic')
}))

test('blocks a compaction dropped stop being charged, also mid-turn and with memory off (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const toolRound = (agent) => h.listeners['agent/pre-step']({ agent, messages: [] }, async () => ({ kind: 'enter', messages: [] }))
  for (const [sid, off] of [['sB', false], ['sC', true]]) {
    const b = agentOf(sid, cwd, [system()])
    const request = requestFor(h, sid)
    assert.equal((await h.step(b, ask('is commit signing set up?'))).messages.length, 2, 'a block was sent')
    await request()
    b.session.append(assistant('ok'))
    if (off) await h.run(b, 'off')
    const nodes = b.session.surface.nodes
    b.session.compact(nodes[0], nodes.at(-1))
    if (off) await h.step(b, ask('next question'))
    else await toolRound(b)
    await request()
    await request()
    h.listeners['agent/turn-stopping']({ agent: b })
    const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.[sid])
    assert.equal(entry.c.resent, 0, `${sid}: nothing re-sent once the block is gone`)
  }
}))

test('an unreadable ledger.json costs the savings line, not the card or the page (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }] }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await mkdir(join(cwd, '.context-graph', 'ledger.json'))
  const card = (await quietly(() => h.run(a, 'stats'))).text
  assert.match(card, /^Memory on · 1 topic in this chat/)
  assert.match(card, /\nSavings: unavailable for now/)
  const get = (name, query = '') => quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))
  const overview = await (await get('overview')).json()
  assert.equal(overview.workspaces[0].chats, 1)
  assert.equal((await get('map', `?w=${overview.workspaces[0].key}`)).status, 200)
}))

test('the map leaves out a chat without a chat number, and a repeated number (second review of #36)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }] }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
  for (const sid of ['sA', 'sB', 'sC', 'sD']) await h.run(agentOf(sid, cwd, chatEvents(4)), 'build')
  await updateMeta(dir, 'sB', (m) => ({ ...m, cid: 1 }))
  await writeFile(join(dir, 'chats', 'sC', 'meta.json'), '', 'utf8')
  await writeFile(join(dir, 'chats', 'sD', 'meta.json'), '', 'utf8')
  const get = (name, query = '') => quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))
  const { workspaces } = await (await get('overview')).json()
  const response = await get('map', `?w=${workspaces[0].key}`)
  assert.equal(response.status, 200)
  const map = await response.json()
  const cids = map.chats.map((c) => c.cid)
  assert.deepEqual(cids, [...new Set(cids)], 'each number once')
  assert.ok(cids.every(Number.isInteger))
  assert.ok(map.topics.every(([cid]) => Number.isInteger(cid)))
}))

test('a source message credited before a restart is not credited again for a sibling topic (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const reply = JSON.stringify({ nodes: [
    { label: 'builder timeout', gist: 'thirty seconds per call', aliases: [], kind: 'decision', msgs: [1] },
    { label: 'builder retries', gist: 'three attempts with backoff', aliases: [], kind: 'decision', msgs: [1] }
  ], edges: [] })
  const h = await setup({}, scriptedLlm({ reply }))
  const answer = 'The builder waits thirty seconds per call, then makes three attempts with backoff. '.repeat(40)
  await h.run(agentOf('sA', cwd, [system(), user('how should the builder behave?'), assistant(answer), ...chatEvents(3).slice(1)]), 'build')
  const e = agentOf('sE', cwd, [system()])
  await h.recall(e, 'c1n1')
  h.listeners['agent/turn-stopping']({ agent: e })
  const first = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sE)
  const restarted = await setup({}, scriptedLlm({ reply }))
  await restarted.recall(e, 'c1n2')
  restarted.listeners['agent/turn-stopping']({ agent: e })
  const second = await until(async () => { const entry = (await ledgerOf(cwd)).chats.sE; return entry.c.used === 2 && entry })
  assert.equal(second.c.stoodIn, first.c.stoodIn, 'the same answer, still counted once')
}))

test('on during a running turn of a memory-off chat waits for the turn to end (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.session.append({ type: 'turn/start' })
  a.session.append(user('a question typed while off'))
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
  a.session.append(assistant('an answer'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await until(async () => (await metaOf(cwd, 'sA')).memoryOff === false)
}))

test('off after an on that waits for the turn end cancels it (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.session.append({ type: 'turn/start' })
  a.session.append(user('a question typed while off'))
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
  await h.run(a, 'off')
  a.session.append(assistant('an answer'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(150)
  const meta = await metaOf(cwd, 'sA')
  assert.equal(meta.memoryOff, true, 'the later off wins')
  assert.equal(meta.onWhenIdle, undefined)
}))

test('an answer that only repeats the question does not count its topic as used, end to end (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  assert.equal((await h.step(b, ask('is commit signing set up?'))).messages.length, 2, 'a block was sent')
  b.session.append(assistant("I don't know whether commit signing is set up here. Can you share your git config?"))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 0)
  assert.equal(entry.c.stoodIn, 0)
}))
