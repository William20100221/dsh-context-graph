/**
 * The plugin's page (#35, #36): the read-only routes the client module calls, and the map layout.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/page.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { emptyGraph, layoutMap, mergeDelta } from '../../src/core/index.js'
import { agentOf, chatEvents, scriptedLlm, setup, skip, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-page-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}

/** The plugin with a fake connection (routes captured) and a fake workspace registry. */
async function withPage(workspaces, llm) {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const workspaceRegistry = { list: () => workspaces.map((path) => ({ path, title: path.split(/[\\/]/).at(-1) })) }
  const h = await setup({}, llm ?? scriptedLlm({ reply: JSON.stringify({ summary: 'Commit signing with SSH keys', nodes: [{ label: 'commit signing', gist: 'signed with id_ed25519_signing', aliases: ['gpg'], kind: 'decision', msgs: [0] }, { label: 'ssh signing key', gist: 'the key file', aliases: [], kind: 'artifact', msgs: [0] }], edges: [['commit signing', 'ssh signing key', 'uses']] }) }), { connection, workspaceRegistry })
  const get = async (name, query = '') => {
    const response = await routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`))
    return { status: response.status, body: await response.json() }
  }
  return { h, routes, get }
}

test('three owner-only GET routes, registered only where dsh has a connection', { skip }, async () => {
  const { routes } = await withPage([])
  assert.deepEqual([...routes.keys()].sort(), ['/api/context-graph.map', '/api/context-graph.overview', '/api/context-graph.topic'])
  for (const route of routes.values()) assert.deepEqual([route.methods, route.requestBody], [['GET'], 'buffered'])
  const plain = await setup()
  assert.equal(plain.commands.length, 1, 'without a connection the page does not start, and nothing breaks')
})

test('overview, map and topic read only known workspaces', { skip }, () => inWorkspace(async (cwd) => {
  const { h, get } = await withPage([cwd])
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const overview = await get('overview')
  assert.equal(overview.status, 200)
  const [w] = overview.body.workspaces
  assert.deepEqual([w.chats, w.indexed, w.topics], [1, 1, 2])
  assert.ok(w.key && w.savings && typeof w.savings.net === 'number')
  const map = await get('map', `?w=${w.key}`)
  assert.equal(map.status, 200)
  assert.equal(map.body.chats[0].summary, 'Commit signing with SSH keys')
  assert.equal(map.body.topics.length, 2)
  assert.equal(map.body.topics[0].length, 7, '[cid, id, label, kind, x, y, degree]: labels only')
  assert.ok(!JSON.stringify(map.body).includes('id_ed25519_signing'), 'no gists or sources in the overview map')
  assert.deepEqual(map.body.edges, [[1, 'n1', 'n2', 'uses']])
  const topic = await get('topic', `?w=${w.key}&id=c1n1`)
  assert.equal(topic.body.gist, 'signed with id_ed25519_signing')
  assert.match(topic.body.sources[0].text, /We decided to sign commits/)
  assert.deepEqual(topic.body.links.map((l) => l.id), ['c1n2'])
  assert.equal((await get('map', '?w=../../etc')).status, 404, 'a workspace is a key, never a path')
  assert.equal((await get('map', `?w=${encodeURIComponent(join(cwd, '.context-graph'))}`)).status, 404, 'not even its own folder')
  assert.equal((await get('topic', `?w=${w.key}&id=c1n9`)).status, 404, 'a topic the chat does not have')
  assert.equal((await get('topic', `?w=${w.key}&id=c9n1`)).status, 404)
  assert.equal((await get('topic', `?w=${w.key}&id=constructor`)).status, 404)
}))

test('the layout is deterministic, keeps chats apart and topics inside their chat', () => {
  const chat = (cid, n, at) => {
    const graph = emptyGraph()
    mergeDelta(graph, { nodes: Array.from({ length: n }, (_, i) => ({ label: `topic ${cid}-${i}`, gist: 'g', msgs: [0] })), edges: [] }, { now: at })
    return { cid, lastActiveAt: at, graph }
  }
  const chats = [chat(1, 3, '2026-11-01'), chat(2, 40, '2026-11-03'), chat(3, 200, '2026-11-02')]
  const a = layoutMap(chats)
  assert.deepEqual(layoutMap(chats), a, 'same memory, same picture')
  assert.deepEqual(a.chats.map((c) => c.cid), [2, 3, 1], 'newest first')
  assert.equal(a.chats.find((c) => c.cid === 3).shown, 120, 'the most connected 120 are drawn')
  assert.equal(a.chats.find((c) => c.cid === 3).total, 200)
  for (let i = 0; i < a.chats.length; i++) {
    for (let j = i + 1; j < a.chats.length; j++) {
      const [p, q] = [a.chats[i], a.chats[j]]
      assert.ok(Math.hypot(p.x - q.x, p.y - q.y) >= p.r + q.r, `chats ${p.cid} and ${q.cid} overlap`)
    }
  }
  for (const t of a.topics) {
    const c = a.chats.find((x) => x.cid === t.cid)
    assert.ok(Math.hypot(t.x - c.x, t.y - c.y) <= c.r, `topic ${t.cid}${t.id} outside its chat`)
  }
  // Many chats wrap into rows: the picture stays as wide as the page, it grows downwards.
  const many = layoutMap(Array.from({ length: 30 }, (_, i) => chat(i + 1, 40, `2026-10-${String(i + 1).padStart(2, '0')}`)))
  for (const c of many.chats) assert.ok(c.x - c.r >= 0 && c.x + c.r <= many.width && c.y + c.r <= many.height, `chat ${c.cid} outside the picture`)
})
