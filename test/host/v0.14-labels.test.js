/**
 * v0.14.0 (#94): a build stores the chat's labels; the tree route sends them.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.14-labels.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { agentOf, chatEvents, quietly, scriptedLlm, setup, skip, wait } from '../helpers/harness.js'

const reply = (labels) => JSON.stringify({ summary: 'Signing and a crash', ...labels, nodes: [{ id: null, label: 'commit signing', gist: 'ssh key', aliases: [], kind: 'decision', msgs: [0] }], edges: [] })

test('a build stores the chat\'s type, project and parts (as message ranges and turns); later builds update them (#94)', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-labels-'))
  try {
    let labels = { type: 'coding', project: 'dsh-context-graph', parts: [{ msgs: [0, 3], type: 'coding', about: 'signing setup' }, { msgs: [4, 7], type: 'debugging', about: 'a crash' }] }
    const routes = new Map()
    const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
    const h = await setup({}, scriptedLlm({ reply: () => reply(labels) }), { connection, workspaceRegistry: { list: () => [{ path: cwd, title: 'w' }], archivedSessionIds: [] } })
    const a = agentOf('sA', cwd, chatEvents(4))
    await h.run(a, 'build')
    const metaOf = async () => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'meta.json'), 'utf8'))
    const meta = await metaOf()
    assert.equal(meta.type, 'coding')
    assert.equal(meta.project, 'dsh-context-graph')
    assert.deepEqual(meta.parts, [{ from: 1, to: 4, turns: [1, 2], type: 'coding', about: 'signing setup' }, { from: 5, to: 8, turns: [3, 4], type: 'debugging', about: 'a crash' }])
    // A later build that names no project keeps the one known; a new type replaces the old.
    labels = { type: 'debugging', project: '' }
    for (const event of chatEvents(1).slice(1)) a.session.append(event)
    await h.run(a, 'build')
    const later = await metaOf()
    assert.deepEqual([later.type, later.project, later.parts.length], ['debugging', 'dsh-context-graph', 2])
    const get = async (name, query) => JSON.parse(await (await quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`)))).text())
    const w = (await get('overview', '')).workspaces[0].key
    const chat = (await get('tree', `?w=${w}`)).chats[0]
    assert.deepEqual([chat.type, chat.project, chat.parts[1]], ['debugging', 'dsh-context-graph', { turns: [3, 4], type: 'debugging', about: 'a crash' }])
  } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
})
