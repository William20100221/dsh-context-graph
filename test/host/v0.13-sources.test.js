/**
 * v0.13.0 (#93): every message indexing reads is kept whole; chats indexed before are completed from
 * dsh's log, with the same off stretches as every reader; a whole turn can be read on the page.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.13-sources.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { capText } from '../../src/core/text.js'
import { updateMeta } from '../../src/store/chats.js'
import { keepText, saveMessages } from '../../src/store/messages.js'
import { agentOf, assistant, chatEvents, quietly, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-sources-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}

const storeOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'msgs.json'), 'utf8'))
const LONG = 'The whole plan, step by step. '.repeat(1000).trim() // about 30,000 characters: cut to 5,700 before #93

/** The plugin with dsh's log of each session (`logs`), the page's routes and a known workspace. */
async function withLogs(cwd) {
  const logs = new Map()
  const routes = new Map()
  const sessionQuery = { async observeSession(sid) { const l = logs.get(sid); return l && { header: {}, events: l.map((e, seq) => ({ ...e, seq })), [Symbol.dispose]() {} } } }
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }], archivedSessionIds: [] }
  const h = await setup({}, undefined, { sessionQuery, connection, workspaceRegistry })
  const get = async (name, query = '') => {
    const response = await quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))
    return { status: response.status, body: await response.json() }
  }
  return { h, logs, get, key: async () => (await get('overview')).body.workspaces[0].key }
}

test('the store keeps a message whole up to 200,000 characters, and replaces a copy cut before #93 by the whole one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-store-'))
  try {
    assert.equal(keepText(LONG), LONG)
    const huge = 'x'.repeat(250000)
    assert.ok(keepText(huge).length < 201000 && keepText(huge).startsWith('x'.repeat(160000)), 'a pasted log past that keeps its head and tail')
    await writeFile(join(dir, 'msgs.json'), JSON.stringify({ v: 2, m: { 1: { r: 'user', t: 1, x: capText(LONG) }, 2: { r: 'assistant', t: 1, x: 'kept as it is' } } }), 'utf8')
    await saveMessages(dir, [{ seq: 1, role: 'user', text: LONG, turn: 1 }, { seq: 2, role: 'assistant', text: 'something else', turn: 1 }, { seq: 3, role: 'user', text: 'new', turn: 2 }], { complete: true })
    const store = JSON.parse(await readFile(join(dir, 'msgs.json'), 'utf8'))
    assert.equal(store.m[1].x, LONG, 'the cut copy is made whole')
    assert.equal(store.m[1].t, 1)
    assert.equal(store.m[2].x, 'kept as it is', 'a whole copy is never rewritten')
    assert.equal(store.m[3].x, 'new')
    assert.equal(store.complete, true)
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10 }) }
})

test('indexing keeps every message it read, whole, and a chat first indexed now says its store is whole (#93)', { skip }, () => inWorkspace(async (cwd) => {
  const { h } = await withLogs(cwd)
  const a = agentOf('sA', cwd, [...chatEvents(3), user(LONG), assistant('Agreed, that is the plan.')])
  await h.run(a, 'build')
  const store = await storeOf(cwd, 'sA')
  assert.deepEqual(Object.keys(store.m), ['1', '2', '3', '4', '5', '6', '7', '8'])
  assert.equal(store.m[7].x, LONG, 'not cut to its head and tail')
  assert.equal(store.complete, true)
}))

test('a chat indexed before #93 is completed from dsh\'s log once, never with what was typed while memory was off (#93)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, logs } = await withLogs(cwd)
  const a = agentOf('sA', cwd, [...chatEvents(2), user('my private note while memory was off'), assistant('ok, private'), user(LONG), assistant('Agreed.')])
  await h.run(a, 'build')
  const dir = join(cwd, '.context-graph')
  // As 0.12.0 left it: the cited message only, cut; and seqs 5-6 typed while memory was off.
  await writeFile(join(dir, 'chats', 'sA', 'msgs.json'), JSON.stringify({ v: 2, m: { 1: { r: 'user', t: 1, x: capText(a.session.log[1].data.content[0].text) } } }), 'utf8')
  await updateMeta(dir, 'sA', (m) => ({ ...m, gaps: [[5, 6]] }))
  a.session.append(user('after the last index'))
  logs.set('sA', a.session.log)
  assert.deepEqual(await h.plugin.keeper.sweep(), { completed: 1 })
  const store = await storeOf(cwd, 'sA')
  assert.deepEqual(Object.keys(store.m), ['1', '2', '3', '4', '7', '8'], 'the off stretch is not stored, nor what came after the last index')
  assert.equal(store.m[7].x, LONG)
  assert.equal(store.complete, true)
  assert.deepEqual(await h.plugin.keeper.sweep(), { whole: 1 }, 'once')
}))

test('a chat whose dsh session is gone keeps what it has; a fork keeps only its own part (#93)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, logs } = await withLogs(cwd)
  const dir = join(cwd, '.context-graph')
  await h.run(agentOf('sGone', cwd, chatEvents(2)), 'build')
  await writeFile(join(dir, 'chats', 'sGone', 'msgs.json'), JSON.stringify({ v: 2, m: { 1: { r: 'user', t: 1, x: 'cited' } } }), 'utf8')
  const parent = chatEvents(2)
  const fork = agentOf('sF', cwd, [...parent, user('the fork asks about gpg agents'), assistant('the fork answers')], { header: { isSeeded: true }, inheritedEventCount: parent.length })
  await h.run(fork, 'build')
  await writeFile(join(dir, 'chats', 'sF', 'msgs.json'), JSON.stringify({ v: 2, m: {} }), 'utf8')
  logs.set('sF', fork.session.log)
  const done = await h.plugin.keeper.sweep()
  assert.deepEqual(done, { unreadable: 1, completed: 1 })
  assert.deepEqual(Object.keys((await storeOf(cwd, 'sGone')).m), ['1'])
  assert.deepEqual(Object.keys((await storeOf(cwd, 'sF')).m), ['5', '6'], 'not its parent\'s turns')
}))

test('the page reads a whole turn from the stored messages, and shows sources whole (#93)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, get, key } = await withLogs(cwd)
  await h.run(agentOf('sA', cwd, [system(), user(LONG), assistant('Agreed, that is the plan.'), ...chatEvents(3).slice(1)]), 'build')
  const w = await key()
  const turn = (await get('turn', `?w=${w}&cid=1&t=1`)).body
  assert.deepEqual(turn, { cid: 1, turn: 1, messages: [{ role: 'user', text: LONG }, { role: 'assistant', text: 'Agreed, that is the plan.' }], complete: true })
  assert.equal((await get('turn', `?w=${w}&cid=1&t=99`)).status, 404)
  assert.equal((await get('turn', `?w=${w}&cid=9&t=1`)).status, 404)
  assert.equal((await get('turn', `?w=${w}&cid=1&t=x`)).status, 404)
  const topic = (await get('topic', `?w=${w}&id=c1n1`)).body
  assert.equal(topic.complete, true)
  assert.ok(topic.sources.every((s) => s.text.length <= LONG.length) && topic.sources.some((s) => s.text.length > 600 || s.text.endsWith('the plan.')), 'not cut at 600 characters')
}))

test('savings counted before #104 are converted once, at start, to the old total of the chats they used (#104)', { skip }, () => inWorkspace(async (cwd) => {
  const { historyTokens } = await import('../../src/core/index.js')
  const { h } = await withLogs(cwd)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const dir = join(cwd, '.context-graph')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'ledger'), { recursive: true })
  // As 0.16 left it: chat B used two topics of chat 1, counted by their newest messages.
  await writeFile(join(dir, 'ledger', 'sB.json'), JSON.stringify({ c: { sent: 40, stoodIn: 300, used: 2 }, used: ['c1n1', 'c1n2'], msgs: ['1:2'] }), 'utf8')
  await h.plugin.keeper.sweep()
  const entry = JSON.parse(await readFile(join(dir, 'ledger', 'sB.json'), 'utf8'))
  assert.deepEqual(entry, { v: 2, c: { sent: 40, used: 2, history: historyTokens((await storeOf(cwd, 'sA')).m) }, used: ['c1n1', 'c1n2'], chats: ['c1'] })
  await h.plugin.keeper.sweep()
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'ledger', 'sB.json'), 'utf8')), entry, 'once')
}))

test('a chat whose old savings already used an earlier chat does not count that chat twice on its next use (#104)', { skip }, () => inWorkspace(async (cwd) => {
  const { historyTokens } = await import('../../src/core/index.js')
  const { h } = await withLogs(cwd)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const dir = join(cwd, '.context-graph')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(join(dir, 'ledger'), { recursive: true })
  // Before the sweep ran: chat B's 0.16 entry already used a topic of chat 1.
  await writeFile(join(dir, 'ledger', 'sB.json'), JSON.stringify({ c: { used: 1 }, used: ['c1n9'] }), 'utf8')
  const b = agentOf('sB', cwd, [system()])
  await h.recall(b, 'c1n1')
  h.listeners['agent/turn-stopping']({ agent: b })
  const { until } = await import('../helpers/harness.js')
  const entry = await until(async () => { const e = JSON.parse(await readFile(join(dir, 'ledger', 'sB.json'), 'utf8')); return e.c.used === 2 && e })
  assert.equal(entry.c.history, historyTokens((await storeOf(cwd, 'sA')).m), 'chat 1 once')
  assert.deepEqual(entry.chats, ['c1'])
}))
