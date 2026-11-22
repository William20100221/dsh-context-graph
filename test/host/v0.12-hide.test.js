/**
 * v0.12.0: hide a chat from memory, use it again, delete the memory of a chat dsh archived or
 * deleted (#91), and the header chip's route (#92).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.12-hide.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { agentOf, ask, chatEvents, quietly, setup, skip, system, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-hide-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}

const exists = (path) => stat(path).then(() => true, () => false)
const blockOf = (out) => (out.messages.length > 1 ? out.messages.at(-1).content[0].text : '')

/** The plugin with a fake connection, workspace registry and session listing the test controls. */
async function withPage(cwd, { listed = () => [], archived = () => [] } = {}) {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => [{ path: cwd, title: 'w' }], get archivedSessionIds() { return archived() } }
  const sessionQuery = { listSessions: async () => listed().map((id) => ({ header: { id } })) }
  const h = await setup({}, undefined, { connection, workspaceRegistry, sessionQuery })
  const call = async (name, query = '', { post = false, header = post } = {}) => {
    const request = new Request(`http://localhost/api/context-graph.${name}${query}`, { method: post ? 'POST' : 'GET', headers: header ? { 'x-context-graph': '1' } : {} })
    const response = await quietly(() => routes.get(`/api/context-graph.${name}`).fetch(request))
    return { status: response.status, body: await response.json() }
  }
  const key = async () => (await call('overview')).body.workspaces[0].key
  return { h, routes, call, key }
}

test('six owner-only routes: four reads, and hide and forget as POSTs that need the page\'s header (#91, #92)', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-hide-'))
  try {
    const { routes, call } = await withPage(cwd)
    assert.deepEqual([...routes.keys()].sort(), ['chat', 'forget', 'hide', 'overview', 'topic', 'tree'].map((n) => `/api/context-graph.${n}`))
    assert.deepEqual(['hide', 'forget'].map((n) => routes.get(`/api/context-graph.${n}`).methods), [['POST'], ['POST']])
    assert.deepEqual(['overview', 'tree', 'topic', 'chat'].map((n) => routes.get(`/api/context-graph.${n}`).methods), [['GET'], ['GET'], ['GET'], ['GET']])
    assert.equal((await call('hide', '?w=x&cid=1', { post: true, header: false })).status, 403, 'a cross-site form cannot send the header')
    assert.equal((await call('forget', '?sid=sA', { post: true, header: false })).status, 403)
  } finally { await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
})

test('a hidden chat reaches no other chat: no topic, no list, no map entry, no recall; it is not indexed; Use again brings it back (#91)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call, key } = await withPage(cwd)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.run(b, 'build')
  const w = await key()
  assert.deepEqual((await call('hide', `?w=${w}&cid=1`, { post: true })).body, { cid: 1, hidden: true })
  const meta = JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'meta.json'), 'utf8'))
  assert.equal(meta.hidden, true, 'kept with the chat\'s other flags, in its meta (fails closed like them)')
  assert.equal(blockOf(await h.step(b, ask('how is commit signing set up with gpg?'))), '', 'no topic and no chat list')
  assert.equal((await h.recall(b, 'c1n1')).status, 'unknown', 'not recalled either')
  const map = (await h.run(b, 'map')).text
  assert.doesNotMatch(map, /commit signing/)
  assert.match(map, /Hidden from memory: c1 \(Memory tree → Use again\)$/)
  assert.match((await h.run(a, 'stats')).text, /hidden from memory/)
  const built = await h.run(a, 'build')
  assert.equal(built.kind, 'error', 'a hidden chat is not indexed')
  assert.match(built.text, /hidden from memory/)
  // The tree still shows it, marked.
  const tree = (await call('tree', `?w=${w}`)).body
  assert.equal(tree.chats.find((c) => c.cid === 1).hidden, true)
  assert.deepEqual((await call('hide', `?w=${w}&cid=1&on=0`, { post: true })).body, { cid: 1, hidden: false })
  const again = JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'meta.json'), 'utf8'))
  assert.equal('hidden' in again, false)
  const c = agentOf('sC', cwd, [system()])
  assert.match(blockOf(await h.step(c, ask('how is commit signing set up with gpg?'))), /c1n1 commit signing/)
}))

test('memory is deleted only for a chat dsh archived or deleted, and goes with its savings file (#91)', { skip }, () => inWorkspace(async (cwd) => {
  let listed = ['sA', 'sB']
  let archived = []
  const { h, call, key } = await withPage(cwd, { listed: () => listed, archived: () => archived })
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  await h.run(agentOf('sB', cwd, chatEvents(4)), 'build')
  const w = await key()
  const folder = join(cwd, '.context-graph', 'chats', 'sA')
  await mkdir(join(cwd, '.context-graph', 'ledger'), { recursive: true })
  await writeFile(join(cwd, '.context-graph', 'ledger', 'sA.json'), '{"c":{"used":1}}', 'utf8')
  assert.deepEqual((await call('forget', `?w=${w}&cid=1`, { post: true })), { status: 409, body: { error: 'this chat still exists: hide it, or archive it first' } })
  assert.ok(await exists(folder))
  const tree = (await call('tree', `?w=${w}`)).body
  assert.deepEqual(tree.chats.map((c) => [c.cid, c.archived, c.gone]).sort(), [[1, false, false], [2, false, false]])
  listed = ['sB'] // dsh deleted sA
  assert.equal((await call('tree', `?w=${w}`)).body.chats.find((c) => c.cid === 1).gone, true)
  assert.deepEqual((await call('forget', `?w=${w}&cid=1`, { post: true })).body, { forgotten: true })
  assert.equal(await exists(folder), false)
  assert.equal(await exists(join(cwd, '.context-graph', 'ledger', 'sA.json')), false)
  assert.equal((await call('forget', `?w=${w}&cid=1`, { post: true })).status, 404, 'gone already')
  // Archived (the session menu's Archive & forget names the chat by its session).
  archived = ['sB']
  assert.deepEqual((await call('forget', '?sid=sB', { post: true })).body, { forgotten: true })
  assert.equal(await exists(join(cwd, '.context-graph', 'chats', 'sB')), false)
}))

test('while dsh cannot list its sessions, no chat counts as deleted (#91)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call, key } = await withPage(cwd, { listed: () => { throw new Error('index rebuilding') } })
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const w = await key()
  assert.equal((await call('tree', `?w=${w}`)).body.chats[0].gone, false)
  assert.equal((await call('forget', `?w=${w}&cid=1`, { post: true })).status, 409)
}))

test('the header chip finds a chat by its session: number, topics and flags; 404 before it has memory (#92)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, call, key } = await withPage(cwd)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const w = await key()
  assert.deepEqual((await call('chat', '?sid=sA')).body, { w, cid: 1, topics: 1, shared: true, memory: true, hidden: false })
  assert.equal((await call('chat', '?sid=sNew')).status, 404)
  assert.equal((await call('chat', '?sid=../sA')).status, 404, 'a session id is looked up, never joined into a path')
}))
