/**
 * Review of v0.12-v0.15 (#97, #98): deleted memory stays deleted, whatever is running; a chat restored
 * and used again starts over; the tree's subjects meet search's.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.15-forget.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDir, listChats, removeChat } from '../../src/store/chats.js'
import { saveMessages } from '../../src/store/messages.js'
import { DEFAULT_REPLY, agentOf, assistant, chatEvents, quietly, scriptedLlm, setup, skip, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-forget-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}

/** The plugin with its page; every chat counts as archived, so its memory may be deleted. */
async function withPage(cwd, llm) {
  const routes = new Map()
  const logs = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const sessionQuery = { listSessions: async () => [], async observeSession(sid) { const l = logs.get(sid); return l && { header: {}, events: l.map((e, seq) => ({ ...e, seq })), [Symbol.dispose]() {} } } }
  const h = await setup({}, llm, { connection, sessionQuery, workspaceRegistry: { list: () => [{ path: cwd, title: 'w' }], archivedSessionIds: [] } })
  const call = async (name, query, post = false) => {
    const response = await quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`, { method: post ? 'POST' : 'GET', headers: post ? { 'x-context-graph': '1' } : {} })))
    return { status: response.status, body: await response.json() }
  }
  return { h, logs, call }
}

const folderOf = (cwd, sid) => chatDir(join(cwd, '.context-graph'), sid)

test('an index running when the memory is deleted writes nothing of it back (#97)', { skip }, () => inWorkspace(async (cwd) => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const llm = scriptedLlm({ reply: DEFAULT_REPLY, gate })
  const { h, call } = await withPage(cwd, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  // Memory for the chat first, then a second index held at its model call.
  release()
  await h.run(a, 'build')
  let hold
  const second = scriptedLlm({ reply: DEFAULT_REPLY, gate: new Promise((resolve) => { hold = resolve }) })
  const page = await withPage(cwd, second)
  for (const e of chatEvents(2).slice(1)) a.session.append(e)
  const running = page.h.run(a, 'build')
  await until(() => second.calls === 1)
  assert.deepEqual((await page.call('forget', '?sid=sA', true)).body, { forgotten: true })
  hold()
  await running
  assert.deepEqual(await readdir(folderOf(cwd, 'sA')), ['meta.json'], 'no topics, no messages')
  const meta = JSON.parse(await readFile(join(folderOf(cwd, 'sA'), 'meta.json'), 'utf8'))
  assert.ok(meta.forgotten)
  assert.deepEqual(Object.keys(meta).sort(), ['builtSeq', 'forgotten'], 'the tombstone as deletion left it: no title, summary or index position of the run that was cut short')
  assert.equal(meta.builtSeq, 8)
  assert.deepEqual(await listChats(join(cwd, '.context-graph')), [], 'listed nowhere')
}))

test('a message write after the deletion (the backfill) is dropped; the tombstone keeps where the chat\'s log ended (#97)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call, logs } = await withPage(cwd, scriptedLlm({ reply: DEFAULT_REPLY }))
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  a.session.append(user('said after the last index'))
  logs.set('sA', a.session.log)
  await call('forget', '?sid=sA', true)
  const meta = JSON.parse(await readFile(join(folderOf(cwd, 'sA'), 'meta.json'), 'utf8'))
  assert.equal(meta.builtSeq, 9, 'the end of the chat\'s log, past its last index')
  await saveMessages(folderOf(cwd, 'sA'), [{ seq: 1, role: 'user', text: 'old text', turn: 1 }], { complete: true })
  assert.deepEqual(await readdir(folderOf(cwd, 'sA')), ['meta.json'])
  assert.deepEqual(await h.plugin.keeper.sweep(), {}, 'the backfill does not see it')
}))

test('a chat restored and used again is indexed from where it was forgotten, as a new chat number (#97)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call, logs } = await withPage(cwd, scriptedLlm({ reply: DEFAULT_REPLY }))
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  logs.set('sA', a.session.log)
  await call('forget', '?sid=sA', true)
  // Restored from the archive, used again.
  for (const e of [user('a new question about signing after the restore'), assistant('a new answer')]) a.session.append(e)
  await h.run(a, 'build')
  const meta = JSON.parse(await readFile(join(folderOf(cwd, 'sA'), 'meta.json'), 'utf8'))
  assert.equal(meta.forgotten, undefined)
  assert.equal(meta.cid, 2, 'a new number: c1 stays the deleted one')
  const store = JSON.parse(await readFile(join(folderOf(cwd, 'sA'), 'msgs.json'), 'utf8'))
  assert.deepEqual(Object.keys(store.m), ['9', '10'], 'only what came after')
}))

test('memory off in a forgotten chat holds when it is used again (#97)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call } = await withPage(cwd, scriptedLlm({ reply: DEFAULT_REPLY }))
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await call('forget', '?sid=sA', true)
  await h.run(a, 'off')
  for (const e of [user('typed while memory was off'), assistant('ok')]) a.session.append(e)
  const built = await h.run(a, 'build')
  assert.match(built.text, /memory is off/)
  assert.deepEqual(await readdir(folderOf(cwd, 'sA')), ['meta.json'])
}))

test('the tree sends the subject key search uses, so spellings of one subject meet (#98)', { skip }, () => inWorkspace(async (cwd) => {
  let subject = 'Earth & Space Science'
  const llm = scriptedLlm({ reply: () => JSON.stringify({ summary: 's', subject, nodes: [{ label: 'tides', gist: 'g', msgs: [0] }], edges: [] }) })
  const { h, call } = await withPage(cwd, llm)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  subject = 'earth and space science'
  await h.run(agentOf('sB', cwd, chatEvents(4)), 'build')
  const w = (await call('overview', '')).body.workspaces[0].key
  const keys = (await call('tree', `?w=${w}`)).body.chats.map((c) => c.subjectKey)
  assert.ok(keys.every((k) => typeof k === 'string' && k.length > 0), 'a key for each')
  assert.equal(new Set(keys).size, 1, `one subject: ${keys.join(' | ')}`)
}))
