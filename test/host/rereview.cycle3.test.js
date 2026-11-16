/**
 * Host regression tests for the second, focused review of the cycle-3 (v0.9.0) review fixes. Each
 * test fails without its fix (checked by breaking the fix on purpose).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/rereview.cycle3.test.js
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-rereview3-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const ledgerOf = async (cwd) => JSON.parse(await readFile(join(cwd, '.context-graph', 'ledger.json'), 'utf8'))
const buildNow = (h, agent) => until(async () => { const out = await quietly(() => h.run(agent, 'build')); return !/^Build busy/.test(out.text) && out })
const listOf = async (h, cwd) => (await h.step(agentOf(`sL${Math.random()}`, cwd, [system()]), ask('hello'))).messages.at(-1).content[0].text
/** A chat whose first prompt was typed while memory was off, then indexed with memory on. */
async function privateFirst(h, cwd) {
  const a = agentOf('sA', cwd, [system()])
  await h.run(a, 'off')
  a.session.append(user('My divorce lawyer is Jane Roe, settlement 200k'))
  a.session.append(assistant('noted'))
  await h.run(a, 'on')
  await wait(150)
  for (const e of chatEvents(4).slice(1)) a.session.append(e)
  await buildNow(h, a)
  return a
}

test('a damaged meta keeps the title it can read back and never takes one from the log (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = await privateFirst(h, cwd)
  const file = join(cwd, '.context-graph', 'chats', 'sA', 'meta.json')
  const good = await metaOf(cwd, 'sA')
  assert.doesNotMatch(good.title, /Jane Roe/)
  const raw = JSON.stringify(good)
  await writeFile(file, raw.slice(0, -3), 'utf8')
  await quietly(() => h.run(a, 'on'))
  assert.equal((await metaOf(cwd, 'sA')).title, good.title, 'the title read back')
  // Cut before the title: none is taken from the log, also after the next build and a share.
  await writeFile(file, '{"cid":1,"builtSeq":3', 'utf8')
  await quietly(() => h.run(a, 'on'))
  await quietly(() => h.run(a, 'share'))
  a.session.append(user('later question about the release checklist'))
  a.session.append(assistant('ok'))
  await buildNow(h, a)
  assert.doesNotMatch(JSON.stringify(await metaOf(cwd, 'sA')), /Jane Roe|divorce/i)
  assert.doesNotMatch(await listOf(h, cwd), /Jane Roe|divorce/i)
}))

test('a meta cut before its off stretches closes its turns, as one cut inside them does (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, gaps: [[5, 6]] }))
  const raw = JSON.stringify(await metaOf(cwd, 'sA'))
  await writeFile(join(cwd, '.context-graph', 'chats', 'sA', 'meta.json'), raw.slice(0, raw.indexOf(',"gaps"')), 'utf8')
  await quietly(() => h.run(a, 'share'))
  assert.equal((await metaOf(cwd, 'sA')).turnsClosed, true)
  assert.equal((await h.recall(agentOf('sB', cwd, [system()]), 'c1t3')).status, 'unknown')
}))

test('a fork takes no title from its parent: not dsh\'s "<title> (1)" rename, not a title made from inherited prompts (second review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const parentEvents = [system(), user('My divorce lawyer is Jane Roe'), assistant('noted'), { type: 'session/title', data: { title: 'Divorce settlement with Jane Roe', messageSeqs: [1], source: { kind: 'provider' } } }, ...chatEvents(3).slice(1)]
  const forkEvents = [...parentEvents,
    // dsh renames a new fork after its parent's title, before its first own prompt.
    { type: 'session/title', data: { title: 'Divorce settlement with Jane Roe (1)', messageSeqs: [], source: { kind: 'user' } } },
    user('fork: the release checklist for Friday'), assistant('ok'),
    // An all-prompts title lists inherited prompts too.
    { type: 'session/title', data: { title: 'Jane Roe and the release checklist', messageSeqs: [1, parentEvents.length + 1], source: { kind: 'provider' } } },
    ...chatEvents(3).slice(1)]
  const fork = agentOf('sF', cwd, forkEvents, { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: parentEvents.length })
  await buildNow(h, fork)
  assert.equal((await metaOf(cwd, 'sF')).title, 'fork: the release checklist for Friday')
}))

test('a fork made where its parent\'s memory was off starts off, also when the parent is on again (second review of #60)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const p = agentOf('sP', cwd, chatEvents(4))
  await h.run(p, 'build')
  await h.run(p, 'off')
  p.session.append(user('Private: PIN 4921'))
  p.session.append(assistant('noted'))
  const forkedWhileOff = [...p.session.log]
  await h.run(p, 'on')
  const f = agentOf('sF', cwd, [...forkedWhileOff, user('fork turn')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: forkedWhileOff.length })
  assert.equal((await h.step(f, ask('gpg commit signing?'))).messages.length, 1, 'no block: memory off')
  assert.equal((await metaOf(cwd, 'sF')).memoryOff, true)
  // Made before memory went off: on.
  const g = agentOf('sG', cwd, [...chatEvents(4).slice(0, 5), user('g turn')], { header: { isSeeded: true, parentSession: 'sP' }, inheritedEventCount: 5 })
  await h.step(g, ask('hello'))
  assert.notEqual((await metaOf(cwd, 'sG')).memoryOff, true)
}))

test('a waiting on: a dsh notice in the inbox does not hold it, and a stopped turn ends the wait (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.inbox = { nextTurn: [], nextStep: [{ source: { kind: 'notice' } }] }
  assert.match((await h.run(a, 'on')).text, /^Memory on ·/, 'only input the user typed is waited for')
  await h.run(a, 'off')
  a.inbox = { nextTurn: [], nextStep: [] }
  a.session.append({ type: 'turn/start' })
  a.session.append(user('typed while off'))
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
  // The user stops the turn: dsh closes it in the log, but no turn end runs; the agent goes idle.
  a.session.append({ type: 'turn/end' })
  h.listeners['agent/status']({ agent: a, status: 'idle' })
  await until(async () => (await metaOf(cwd, 'sA')).memoryOff === false)
}))

test('a waiting on does not undo an off sent as the turn ends (second review of #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  for (let round = 0; round < 5; round++) {
    await h.run(a, 'off')
    a.session.append({ type: 'turn/start' })
    a.session.append(user(`typed while off ${round}`))
    await h.run(a, 'on')
    a.session.append(assistant('ok'))
    a.session.append({ type: 'turn/end' })
    h.listeners['agent/turn-stopping']({ agent: a })
    await h.run(a, 'off')
    await wait(60)
    assert.equal((await metaOf(cwd, 'sA')).memoryOff, true, `round ${round}: the last command was off`)
  }
}))

test('a turn\'s uses survive a failed index and an unreadable ledger: credited at the next turn end (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.step(b, ask('is commit signing set up?'))
  b.session.append(assistant('Yes: commits are signed with id_ed25519_signing.'))
  const ledger = join(cwd, '.context-graph', 'ledger.json')
  await mkdir(ledger)
  await quietly(async () => { h.listeners['agent/turn-stopping']({ agent: b }); await wait(150) })
  await rm(ledger, { recursive: true, force: true })
  await h.step(b, ask('and the weather?'))
  b.session.append(assistant('No idea.'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 1, 'the first turn\'s use')
  assert.ok(entry.c.stoodIn > 0)
}))

test('a subagent forked from a chat is charged to it: the blocks it carries and the recall tool (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const agents = new Map()
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { agents: { get: (id) => agents.get(id) } })
  const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm')
  const request = async (sid) => {
    const r = markAgentLoopRequest({ provider: 'p', model: 'm', messages: [], sessionId: sid })
    for await (const _ of h.listeners['llm/stream'](r, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 40 } } })())) { /* drain */ }
  }
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  agents.set('sB', b)
  assert.equal((await h.step(b, ask('is commit signing set up?'))).messages.length, 2)
  await request('sB')
  const kid = agentOf('sKid', cwd, [...b.session.log], { header: { origin: 'subagent', parentSession: 'sB', isSeeded: true }, inheritedEventCount: b.session.log.length })
  kid.options.origin = 'subagent'
  agents.set('sKid', kid)
  for (let i = 0; i < 3; i++) await request('sKid')
  b.session.append(assistant('ok'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.requests, 4)
  assert.equal(entry.c.resent, 3 * entry.c.sent, 'the block, carried by each of the subagent\'s requests')
  const { estimateTokens } = await import('../../src/core/index.js')
  const tool = h.tools[0]
  assert.equal(entry.c.tool, 4 * estimateTokens(tool.name + tool.description + JSON.stringify(tool.parameters)), 'the recall tool, with each of the four requests')
}))

test('the map and the topic route open the same chat for a number; unreadable sources leave the topic readable (second review of #36)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }] }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { connection, workspaceRegistry })
  await h.run(agentOf('sOld', cwd, chatEvents(4)), 'build')
  // A newer chat with the same number and no topics (a copied folder).
  await mkdir(join(dir, 'chats', 'sEmpty'), { recursive: true })
  await writeFile(join(dir, 'chats', 'sEmpty', 'meta.json'), JSON.stringify({ cid: 1, lastActiveAt: '2099-01-01T00:00:00.000Z' }), 'utf8')
  const get = (name, query = '') => quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))
  const { workspaces } = await (await get('overview')).json()
  const w = workspaces[0].key
  const map = await (await get('map', `?w=${w}`)).json()
  assert.deepEqual(map.chats.map((c) => c.cid), [1], 'the chat with topics is drawn')
  assert.equal((await (await get('topic', `?w=${w}&id=c1n1`)).json()).label, 'commit signing')
  const msgs = join(dir, 'chats', 'sOld', 'msgs.json')
  await rm(msgs, { force: true })
  await mkdir(msgs)
  const topic = await get('topic', `?w=${w}&id=c1n1`)
  assert.equal(topic.status, 200)
  assert.deepEqual((await topic.json()).sources, [])
}))

test('the savings estimate is settled even when the turn end\'s own write fails (second review of #35)', { skip }, () => inWorkspace(async (cwd) => {
  const { chmod } = await import('node:fs/promises')
  const dir = join(cwd, '.context-graph')
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.run(b, 'share')
  await updateMeta(dir, 'sB', (m) => ({ ...m, lastActiveAt: '2026-01-01T00:00:00.000Z' }))
  await h.step(b, ask('is commit signing set up?'))
  b.session.append(assistant('Yes: commits are signed with id_ed25519_signing.'))
  // The turn end moves the chat's last-active time: a read-only meta.json makes that write fail.
  const meta = join(dir, 'chats', 'sB', 'meta.json')
  await chmod(meta, 0o444)
  let entry
  try {
    entry = await quietly(async () => {
      h.listeners['agent/turn-stopping']({ agent: b })
      return until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
    })
  } finally {
    await chmod(meta, 0o644)
  }
  assert.equal(entry.c.used, 1)
}))
