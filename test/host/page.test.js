/**
 * The routes behind the plugin's page (#35) and the Memory tree page (#85, #86), and the tree they send.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/page.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { emptyGraph, memoryTree, mergeDelta } from '../../src/core/index.js'
import { agentOf, chatEvents, scriptedLlm, setup, skip, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-page-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
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
  assert.deepEqual([...routes.keys()].sort(), ['/api/context-graph.overview', '/api/context-graph.topic', '/api/context-graph.tree'])
  for (const route of routes.values()) assert.deepEqual([route.methods, route.requestBody], [['GET'], 'buffered'])
  const plain = await setup()
  assert.equal(plain.commands.length, 1, 'without a connection the page does not start, and nothing breaks')
})

test('overview, tree and topic read only known workspaces', { skip }, () => inWorkspace(async (cwd) => {
  const { h, get } = await withPage([cwd])
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const overview = await get('overview')
  assert.equal(overview.status, 200)
  const [w] = overview.body.workspaces
  assert.deepEqual([w.chats, w.indexed, w.topics], [1, 1, 2])
  assert.ok(w.key && w.savings && typeof w.savings.net === 'number')
  const tree = await get('tree', `?w=${w.key}`)
  assert.equal(tree.status, 200)
  const [chat] = tree.body.chats
  assert.equal(chat.summary, 'Commit signing with SSH keys')
  assert.deepEqual(chat.topics, [['n1', 'commit signing', 'decision'], ['n2', 'ssh signing key', 'artifact']], '[id, label, kind]: labels only')
  assert.ok(!JSON.stringify(tree.body).includes('id_ed25519_signing'), 'no gists or sources in the tree')
  assert.deepEqual(chat.links, [['n1', 'n2']])
  const topic = await get('topic', `?w=${w.key}&id=c1n1`)
  assert.equal(topic.body.gist, 'signed with id_ed25519_signing')
  assert.match(topic.body.sources[0].text, /We decided to sign commits/)
  assert.deepEqual(topic.body.links.map((l) => l.id), ['c1n2'])
  assert.equal((await get('tree', '?w=../../etc')).status, 404, 'a workspace is a key, never a path')
  assert.equal((await get('tree', `?w=${encodeURIComponent(join(cwd, '.context-graph'))}`)).status, 404, 'not even its own folder')
  assert.equal((await get('topic', `?w=${w.key}&id=c1n9`)).status, 404, 'a topic the chat does not have')
  assert.equal((await get('topic', `?w=${w.key}&id=c9n1`)).status, 404)
  assert.equal((await get('topic', `?w=${w.key}&id=constructor`)).status, 404)
}))

test('the tree lists chats newest first, topics grouped by kind, and the most connected 120 of a big chat (#86)', () => {
  const chat = (cid, n, at, kinds = ['fact']) => {
    const graph = emptyGraph()
    mergeDelta(graph, { nodes: Array.from({ length: n }, (_, i) => ({ label: `topic ${cid}-${i}`, gist: 'g', kind: kinds[i % kinds.length], msgs: [0] })), edges: [] }, { now: at })
    return { cid, lastActiveAt: at, graph }
  }
  const mixed = chat(2, 6, '2026-11-03', ['open-question', 'fact', 'decision'])
  mixed.graph.edges.push(['n6', 'n1', 'uses'], ['n6', 'n2', 'uses'])
  const chats = [chat(1, 3, '2026-11-01'), mixed, chat(3, 200, '2026-11-02')]
  const tree = memoryTree(chats)
  assert.deepEqual(memoryTree(chats), tree, 'same memory, same tree')
  assert.deepEqual(tree.map((c) => c.cid), [2, 3, 1], 'newest first')
  assert.deepEqual(tree[0].topics.map(([, , kind]) => kind), ['decision', 'decision', 'fact', 'fact', 'open-question', 'open-question'], 'one band per kind')
  assert.equal(tree[0].topics[0][0], 'n6', 'the most connected first within its kind')
  assert.deepEqual(tree[0].links, [['n6', 'n1'], ['n6', 'n2']])
  assert.equal(tree[1].topics.length, 120)
  assert.equal(tree[1].total, 200)
  // A chain through all 200: the 120 listed are linked to some that are not, and those links go.
  const big = chat(4, 200, '2026-11-04')
  for (let i = 1; i < 200; i++) big.graph.edges.push([`n${i}`, `n${i + 1}`, 'uses'])
  const [chain] = memoryTree([big])
  const listed = new Set(chain.topics.map(([id]) => id))
  assert.ok(chain.links.length > 0 && chain.links.length < 199)
  assert.ok(chain.links.every(([from, to]) => listed.has(from) && listed.has(to)), 'no link to a topic the tree does not list')
})

test('the topic route shows a source\'s turn only where the store numbers turns as dsh does (second review of #71)', { skip }, () => inWorkspace(async (cwd) => {
  const { h, get } = await withPage([cwd])
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const [w] = (await get('overview')).body.workspaces
  assert.ok(Number.isInteger((await get('topic', `?w=${w.key}&id=c1n1`)).body.sources[0].turn))
  // The same store as 0.9.0 wrote it: its turn ids counted typed prompts.
  const file = join(cwd, '.context-graph', 'chats', 'sA', 'msgs.json')
  const store = JSON.parse(await readFile(file, 'utf8'))
  await writeFile(file, JSON.stringify({ ...store, v: 1 }))
  const old = (await get('topic', `?w=${w.key}&id=c1n1`)).body.sources[0]
  assert.equal(old.turn, undefined)
  assert.match(old.text, /We decided to sign commits/)
}))
