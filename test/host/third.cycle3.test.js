/**
 * Host regression tests for the third, focused review of the cycle-3 (v0.9.0) fixes. Each test
 * fails without its fix (checked by breaking the fix on purpose).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/third.cycle3.test.js
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { counters } from '../../src/core/ledger.js'
import { updateMeta } from '../../src/store/chats.js'
import { loadLedger } from '../../src/store/ledger.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-third3-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
// One file per chat since #83, zero counters left out (#78): read back with every counter.
const ledgerOf = async (cwd) => ({ chats: Object.fromEntries(Object.entries((await loadLedger(join(cwd, '.context-graph'))).chats).map(([sid, e]) => [sid, { ...e, c: counters(e.c) }])) })

/** G: indexed, then a private turn typed while off (its gap), then on again. */
async function grandparent(h, cwd) {
  const g = agentOf('sG', cwd, chatEvents(4))
  await h.run(g, 'build')
  await h.run(g, 'off')
  g.session.append(user('Private: the PIN of my second card is 7788'))
  g.session.append(assistant('noted'))
  await h.run(g, 'on')
  await wait(150)
  return g
}

test('a fork of a fork made at a point in the grandparent\'s off stretch starts off (third review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const g = await grandparent(h, cwd)
  const { gaps } = await metaOf(cwd, 'sG')
  const [from, to] = gaps.at(-1)
  // F1: a branch of G after the gap, seen here (it gets its meta). F2: a branch of F1 inside the gap.
  const gLog = [...g.session.log, user('after on'), assistant('ok')]
  const f1 = agentOf('sF1', cwd, [...gLog, user('f1 turn')], { header: { isSeeded: true, parentSession: 'sG' }, inheritedEventCount: gLog.length })
  await h.step(f1, ask('hello'))
  assert.notEqual((await metaOf(cwd, 'sF1')).memoryOff, true, 'F1 was made after the gap')
  const f2Log = gLog.slice(0, to + 1)
  const f2 = agentOf('sF2', cwd, [...f2Log, user('f2: and the PIN again?')], { header: { isSeeded: true, parentSession: 'sF1' }, inheritedEventCount: f2Log.length })
  await h.step(f2, ask('hello'))
  assert.ok(from <= to)
  assert.equal((await metaOf(cwd, 'sF2')).memoryOff, true)
}))

test('a fork of a fork whose meta came before 0.10.0 asks the grandparent too (third review of #60, v0.10.0)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const g = await grandparent(h, cwd)
  const [, to] = (await metaOf(cwd, 'sG')).gaps.at(-1)
  // F1 as 0.9.0 left it: a fork of G, but none of G's off stretches among its own gaps.
  const gLog = [...g.session.log, user('after on'), assistant('ok')]
  await updateMeta(join(cwd, '.context-graph'), 'sF1', (m) => m, () => ({ forkSeq: gLog.length, parent: 'sG', builtSeq: gLog.length - 1, startedAt: 'T', lastActiveAt: 'T' }))
  const f2Log = gLog.slice(0, to + 1)
  const f2 = agentOf('sF2', cwd, [...f2Log, user('f2: and the PIN again?')], { header: { isSeeded: true, parentSession: 'sF1' }, inheritedEventCount: f2Log.length })
  await h.step(f2, ask('hello'))
  assert.equal((await metaOf(cwd, 'sF2')).memoryOff, true)
}))

test('a fork of a chat whose damaged meta lost its off stretches starts off (third review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const p = agentOf('sP', cwd, chatEvents(4))
  await h.run(p, 'build')
  await updateMeta(join(cwd, '.context-graph'), 'sP', (m) => ({ ...m, turnsClosed: true }))
  const f = agentOf('sF', cwd, [...chatEvents(4).slice(0, 5), user('fork turn')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: 5 })
  await h.step(f, ask('hello'))
  assert.equal((await metaOf(cwd, 'sF')).memoryOff, true)
}))

test('a waiting on is applied after a restart, after a race with the turn end, and when queued input is removed (third review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.session.append({ type: 'turn/start' })
  a.session.append(user('typed while off'))
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
  // The app closes before the turn ends; on the next start dsh closes the turn and the agent is idle.
  a.session.append({ type: 'turn/end' })
  const restarted = await setup({ buildMinChars: 1 })
  restarted.listeners['agent/created']({ agent: a })
  await until(async () => (await metaOf(cwd, 'sA')).memoryOff === false)
  // The turn ends while the command writes its flag: the command looks once more.
  await restarted.run(a, 'off')
  let looks = 0
  a.inbox = { get nextTurn() { return looks++ === 0 ? [{ source: { kind: 'user' } }] : [] }, nextStep: [] }
  assert.match((await restarted.run(a, 'on')).text, /^Memory on ·/)
  assert.equal((await metaOf(cwd, 'sA')).memoryOff, false)
  // The queued message is removed: nothing else will end a turn.
  await restarted.run(a, 'off')
  a.inbox = { nextTurn: [{ source: { kind: 'user' } }], nextStep: [] }
  assert.match((await restarted.run(a, 'on')).text, /^Memory on when this turn ends/)
  a.inbox = { nextTurn: [], nextStep: [] }
  restarted.listeners['agent/inbox/discarded']({ agent: a })
  await until(async () => (await metaOf(cwd, 'sA')).memoryOff === false)
}))

test('a stopped turn\'s shown topics are not judged against the next turn\'s answer (third review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  assert.equal((await h.step(b, ask('is commit signing set up?'))).messages.length, 2, 'shown in turn 1')
  // Turn 1 is stopped: dsh closes it, no turn end runs, the agent goes idle.
  h.listeners['agent/status']({ agent: b, status: 'idle' })
  await h.step(b, ask('what changed in the release notes?'))
  b.session.append(assistant('Commits are signed with id_ed25519_signing since the last release.'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 0, 'turn 1 had no answer to judge')
}))

test('the page says the savings are unavailable while the ledger cannot be read (third review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }] }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  await mkdir(join(cwd, '.context-graph', 'ledger.json'))
  const get = (name, query = '') => quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))
  const { workspaces } = await (await get('overview')).json()
  assert.equal(workspaces[0].savings, null)
  const map = await (await get('tree', `?w=${workspaces[0].key}`)).json()
  assert.equal(map.chats[0].savings, null)
}))

test('recall of a repeated chat number reaches the chat with topics, as the page does (third review of #36)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup()
  await h.run(agentOf('sOld', cwd, chatEvents(4)), 'build')
  await mkdir(join(dir, 'chats', 'sEmpty'), { recursive: true })
  await writeFile(join(dir, 'chats', 'sEmpty', 'meta.json'), JSON.stringify({ cid: 1, lastActiveAt: '2099-01-01T00:00:00.000Z' }), 'utf8')
  const out = await h.recall(agentOf('sZ', cwd, [system()]), 'c1n1')
  assert.equal(out.status, 'ok')
  assert.match(out.text, /commit signing/)
}))

test('a fork indexed by 0.8.0 drops the title 0.8.0 gave it at its next write (review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const parentEvents = chatEvents(4)
  const f = agentOf('sF', cwd, [...parentEvents, user('fork: the release checklist'), assistant('ok')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f, ask('hello'))
  await updateMeta(dir, 'sF', ({ firstKey, ...m }) => ({ ...m, title: 'Divorce settlement with Jane Roe (1)', firstPrompt: 'We decided to sign commits' }))
  await h.run(f, 'unshare')
  const meta = await metaOf(cwd, 'sF')
  assert.equal(meta.title, undefined)
  assert.equal(meta.firstPrompt, undefined)
}))

test('an off whose write is held up already holds: a turn that ends meanwhile is not indexed (fourth review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const { locked } = await import('../../src/store/files.js')
  const { chatDir } = await import('../../src/store/chats.js')
  const llm = scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'g', aliases: [], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
  const h = await setup({ buildMinChars: 1, buildEveryTurns: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  // Another program holds meta.json, so the off's write waits (here: the chat's lock is held).
  let release
  const holding = locked(chatDir(join(cwd, '.context-graph'), 'sA'), () => new Promise((resolve) => { release = resolve }))
  a.session.append({ type: 'turn/start' })
  a.session.append(user('a question asked while memory was on'))
  const off = h.run(a, 'off')
  await wait(30)
  a.session.append(assistant('Private, written after off: the PIN is 4921'))
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/turn-stopping']({ agent: a })
  await wait(150)
  release()
  await holding
  await off
  await wait(150)
  assert.ok(llm.prompts.every((p) => !p.includes('4921')), 'the model never saw what came after off')
}))

test('a 0.8.0 fork keeps the title its first 0.9.0 index gives it (fourth review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const parentEvents = chatEvents(4)
  const f = agentOf('sF', cwd, [...parentEvents], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f, ask('hello'))
  await updateMeta(dir, 'sF', ({ firstKey, ...m }) => ({ ...m, title: 'Commit signing (1)', firstPrompt: 'We decided to sign commits' }))
  f.session.append(user('fork: the release checklist'))
  f.session.append(assistant('ok'))
  f.session.append({ type: 'session/title', data: { title: 'Release checklist planning', messageSeqs: [f.session.log.length - 2], source: { kind: 'provider' } } })
  await h.run(f, 'build')
  assert.equal((await metaOf(cwd, 'sF')).title, 'Release checklist planning')
}))

test('recall of a repeated chat number skips a copy whose topics cannot be read (fourth review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup()
  await h.run(agentOf('sOld', cwd, chatEvents(4)), 'build')
  await mkdir(join(dir, 'chats', 'sCopy', 'topics.json'), { recursive: true })
  await writeFile(join(dir, 'chats', 'sCopy', 'meta.json'), JSON.stringify({ cid: 1, lastActiveAt: '2000-01-01T00:00:00.000Z' }), 'utf8')
  const out = await quietly(() => h.recall(agentOf('sZ', cwd, [system()]), 'c1n1'))
  assert.equal(out.status, 'ok')
}))

test('a repaired meta is unsure only up to where memory was turned on again (fourth review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const logs = new Map()
  const sessionQuery = { async observeSession(sid) { return { events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } }
  const h = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  const p = agentOf('sP', cwd, chatEvents(4))
  logs.set('sP', p.session.log)
  await h.run(p, 'build')
  await updateMeta(dir, 'sP', (m) => ({ ...m, turnsClosed: true, memoryOff: true }))
  await h.run(p, 'on')
  await wait(150)
  const { closedThrough } = await metaOf(cwd, 'sP')
  assert.ok(Number.isInteger(closedThrough))
  for (const e of chatEvents(4).slice(1)) p.session.append(e)
  await until(async () => !/^Build busy/.test((await quietly(() => h.run(p, 'build'))).text))
  // A fork made after that point starts with memory on, and a turn from after it is served.
  const forked = [...p.session.log]
  const f = agentOf('sF', cwd, [...forked, user('fork turn')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: forked.length })
  await h.step(f, ask('hello'))
  assert.notEqual((await metaOf(cwd, 'sF')).memoryOff, true)
  assert.equal((await h.recall(agentOf('sZ', cwd, [system()]), 'c1t1')).status, 'unknown', 'a turn from before stays closed')
  assert.equal((await h.recall(agentOf('sZ', cwd, [system()]), 'c1t6')).status, 'ok', 'a turn from after is served')
}))

test('while an off waits for its write, the chat gets no memory blocks (fourth review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const { locked } = await import('../../src/store/files.js')
  const { chatDir } = await import('../../src/store/chats.js')
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  let release
  const holding = locked(chatDir(join(cwd, '.context-graph'), 'sB'), () => new Promise((resolve) => { release = resolve }))
  const off = h.run(b, 'off')
  await wait(30)
  const out = await h.step(b, ask('is commit signing set up?'))
  release()
  await holding
  await off
  assert.equal(out.messages.length, 1, 'no block while the off is on its way')
}))

test('a pending off holds for everything that asks: a fork made meanwhile, a waiting on, recall (final review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const { locked } = await import('../../src/store/files.js')
  const { chatDir } = await import('../../src/store/chats.js')
  const h = await setup({ buildMinChars: 1 })
  await h.run(agentOf('sOther', cwd, chatEvents(4)), 'build')
  const parentEvents = chatEvents(4)
  const p = agentOf('sP', cwd, parentEvents)
  await h.run(p, 'build')
  let release
  const holding = locked(chatDir(join(cwd, '.context-graph'), 'sP'), () => new Promise((resolve) => { release = resolve }))
  const off = h.run(p, 'off')
  await wait(30)
  const f = agentOf('sF', cwd, [...parentEvents, user('fork turn')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f, ask('hello'))
  assert.equal((await metaOf(cwd, 'sF')).memoryOff, true, 'a fork made while the off waits starts off')
  assert.match((await h.recall(p, 'c1n1')).text, /memory is off|off for this chat/i, 'recall from the chat going off is refused')
  const sub = agentOf('sSub', cwd, [system()], { header: { origin: 'subagent', parentSession: 'sP' } })
  sub.options.origin = 'subagent'
  assert.match((await h.recall(sub, 'c1n1')).text, /memory is off|off for this chat/i, 'and from a subagent it started')
  p.session.append({ type: 'turn/start' })
  p.session.append(user('typed after off'))
  const on = h.run(p, 'on')
  release()
  await holding
  await off
  assert.match((await on).text, /^Memory on when this turn ends/, 'the on waits like any on of a chat that is off')
}))

test('two offs: the first failing while the second waits keeps memory off until the second lands (final review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const { chmod } = await import('node:fs/promises')
  const llm = scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'g', aliases: [], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
  const h = await setup({ buildMinChars: 1, buildEveryTurns: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  const meta = join(cwd, '.context-graph', 'chats', 'sA', 'meta.json')
  a.session.append({ type: 'turn/start' })
  a.session.append(user('a question asked while memory was on'))
  await chmod(meta, 0o444)
  try {
    const first = quietly(() => h.run(a, 'off').then(() => 'ok', () => 'failed'))
    await wait(100)
    const second = h.run(a, 'off')
    assert.equal(await first, 'failed', 'the first off could not write')
    await chmod(meta, 0o644)
    a.session.append(assistant('Private, written after off: the PIN is 4921'))
    a.session.append({ type: 'turn/end' })
    h.listeners['agent/turn-stopping']({ agent: a })
    await second
    await wait(150)
  } finally {
    await chmod(meta, 0o644)
  }
  assert.ok(llm.prompts.every((p) => !p.includes('4921')))
}))

test('a second damage of a repaired meta keeps the turns the first one closed (final review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await updateMeta(dir, 'sA', (m) => ({ ...m, turnsClosed: true, closedThrough: 8, gaps: [[3, 4]] }))
  const raw = JSON.stringify(await metaOf(cwd, 'sA'))
  // Only the closing brace is lost: the off stretches read back, the closed part must too.
  await writeFile(join(dir, 'chats', 'sA', 'meta.json'), raw.slice(0, -1), 'utf8')
  await quietly(() => h.run(a, 'share'))
  const meta = await metaOf(cwd, 'sA')
  assert.deepEqual(meta.gaps, [[3, 4]])
  assert.equal(meta.turnsClosed, true)
  assert.equal(meta.closedThrough, 8)
}))

test('recall of a number this chat shares with one it cannot read answers nothing, not this chat (final review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup()
  const me = agentOf('sMe', cwd, chatEvents(4))
  await h.run(me, 'build')
  await mkdir(join(dir, 'chats', 'sOther', 'topics.json'), { recursive: true })
  await writeFile(join(dir, 'chats', 'sOther', 'meta.json'), JSON.stringify({ cid: 1, lastActiveAt: '2000-01-01T00:00:00.000Z' }), 'utf8')
  assert.equal((await quietly(() => h.recall(me, 'c1n1'))).status, 'unknown')
}))

test('a fork written by v0.4-v0.7 drops its inherited title at its next write (final review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({ buildMinChars: 1 })
  const parentEvents = chatEvents(4)
  const f = agentOf('sF', cwd, [...parentEvents, user('fork: the release checklist')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await h.step(f, ask('hello'))
  await updateMeta(dir, 'sF', ({ firstKey, ...m }) => ({ ...m, title: 'We decided to sign commits with the SSH key, step 0.' }))
  await h.run(f, 'unshare')
  const meta = await metaOf(cwd, 'sF')
  assert.equal(meta.title, undefined)
  assert.match(meta.firstKey, /^[0-9a-f]{16}$/)
}))
