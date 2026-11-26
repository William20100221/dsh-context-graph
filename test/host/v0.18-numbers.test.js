/**
 * v0.18.0 (#109): existing chats are numbered 1..N by themselves, after a deletion and at start; the
 * savings files and running chats follow; a chat that saw the old numbers is told, once.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.18-numbers.test.js
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { idMapper, renumberNotice } from '../../src/core/numbers.js'
import { renumberChats, updateMeta, withNumbers } from '../../src/store/chats.js'
import { writeJson } from '../../src/store/files.js'
import { agentOf, ask, chatEvents, quietly, scriptedLlm, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inDir(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-numbers-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const cidOf = async (dir, sid) => JSON.parse(await readFile(join(dir, 'chats', sid, 'meta.json'), 'utf8')).cid
const claims = async (dir) => (await readdir(join(dir, 'chats', '.cid'))).sort((a, b) => a - b)
const reply = (label) => JSON.stringify({ nodes: [{ id: null, label, gist: `${label} decided`, aliases: [], kind: 'decision', msgs: [0] }], edges: [] })
const OLD = 1000 // a chat that began long before any renumbering

test('existing chats are numbered 1..N in their order, claims follow, and the next chat is N+1 (#109)', () => inDir(async (dir) => {
  for (const [sid, cid] of [['s12', 12], ['s14', 14], ['s15', 15], ['s16', 16]]) await writeJson(join(dir, 'chats', sid, 'meta.json'), { cid, title: sid })
  await writeJson(join(dir, 'chats', 'sGone', 'meta.json'), { forgotten: '2026-11-25T00:00:00.000Z', builtSeq: 9 })
  await mkdir(join(dir, 'chats', '.cid'), { recursive: true })
  for (let n = 1; n <= 16; n++) await writeFile(join(dir, 'chats', '.cid', String(n)), '')
  const r = await withNumbers(dir, () => renumberChats(dir))
  assert.deepEqual(r.moves.map((m) => [m.sid, m.from, m.to]), [['s12', 12, 1], ['s14', 14, 2], ['s15', 15, 3], ['s16', 16, 4]])
  assert.deepEqual(r.gone, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13])
  assert.deepEqual(await Promise.all(['s12', 's14', 's15', 's16'].map((sid) => cidOf(dir, sid))), [1, 2, 3, 4])
  assert.deepEqual(await claims(dir), ['1', '2', '3', '4'])
  assert.equal(JSON.parse(await readFile(join(dir, 'chats', 'sGone', 'meta.json'), 'utf8')).cid, undefined, 'a deleted chat gets no number')
  assert.equal(await withNumbers(dir, () => renumberChats(dir)), undefined, 'nothing to do once 1..N')
  assert.equal((await updateMeta(dir, 'sNew', (m) => ({ ...m, title: 'new' }))).cid, 5)
  // The last chat deleted: its number is freed too, and the next chat takes it.
  await writeJson(join(dir, 'chats', 'sNew', 'meta.json'), { forgotten: 'x' })
  assert.deepEqual((await withNumbers(dir, () => renumberChats(dir))).gone, [5])
  assert.equal((await updateMeta(dir, 'sNext', (m) => m)).cid, 5)
}))

test('the notice names each renumbering in runs; ids map to their new numbers, a deleted chat\'s to none (#109)', () => {
  const map = idMapper({ moves: [{ from: 12, to: 1 }, { from: 14, to: 2 }], gone: [1, 13] })
  assert.deepEqual(['c12n3', 'c14t2', 'c14', 'c1n1', 'c13', 'c20n1', 't3'].map(map), ['c1n3', 'c2t2', 'c2', undefined, undefined, 'c20n1', 't3'])
  const at = new Date(2026, 10, 26, 9).getTime()
  assert.equal(renumberNotice([{ at, moves: [[12, 1], [14, 2], [15, 3], [16, 4]], gone: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13] }]),
    '[context-graph] Chat numbers were renumbered after chats\' memory was deleted; ids from before that in this chat use the old numbers. 2026-11-26: c12→c1, c14–c16→c2–c4; removed c1–c11, c13.')
  assert.equal(renumberNotice([]), undefined)
})

/** The plugin with its page and dsh's session list (`listed`); chats built each with their own label. */
async function workspace(cwd, listed) {
  const routes = new Map()
  const connection = { fetch: { register: (route) => { routes.set(route.path, route); return async () => {} } } }
  const sessionQuery = { listSessions: async () => listed().map((id) => ({ header: { id } })) }
  const h = await setup({}, scriptedLlm({ reply: reply('unused') }), { connection, sessionQuery, workspaceRegistry: { list: () => [{ path: cwd, title: 'w' }], archivedSessionIds: [] } })
  const call = async (name, query, post = false) => {
    const response = await quietly(() => routes.get(`/api/context-graph.${name}`).fetch(new Request(`http://localhost/api/context-graph.${name}${query}`, { method: post ? 'POST' : 'GET', headers: post ? { 'x-context-graph': '1' } : {} })))
    return { status: response.status, body: await response.json() }
  }
  const build = async (sid, label) => (await setup({}, scriptedLlm({ reply: reply(label) }))).run(agentOf(sid, cwd, chatEvents(4)), 'build')
  return { h, call, build }
}
const dirOf = (cwd) => join(cwd, '.context-graph')
const ledgerOf = async (cwd, sid) => JSON.parse(await readFile(join(dirOf(cwd), 'ledger', `${sid}.json`), 'utf8'))
const toolResult = (text) => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } })

test('deleting a chat\'s memory renumbers at once: savings files and running chats follow, and a chat that saw the old numbers is told once (#109)', { skip }, () => inDir(async (cwd) => {
  const { h, call, build } = await workspace(cwd, () => ['sB', 'sC', 'sD', 'sE'])
  await build('sA', 'alpha deployment')
  await build('sB', 'beta caching')
  await build('sC', 'gamma signing')
  const d = agentOf('sD', cwd, [{ ...system(), time: OLD }])
  // Chat D used c3 (written) and c2 (still waiting for its turn end) before the deletion.
  await h.recall(d, 'c3n1')
  await h.plugin.settle(d)
  await h.recall(d, 'c2n1')
  assert.deepEqual((await call('forget', '?sid=sA', true)).body, { forgotten: true })
  assert.deepEqual([await cidOf(dirOf(cwd), 'sB'), await cidOf(dirOf(cwd), 'sC')], [1, 2])
  assert.deepEqual((await call('tree', `?w=${(await call('overview', '')).body.workspaces[0].key}`)).body.chats.map((c) => c.cid).sort(), [1, 2])
  const written = await ledgerOf(cwd, 'sD')
  assert.deepEqual([written.used, written.chats], [['c2n1'], ['c2']], 'the savings file in the new numbers')
  await h.plugin.settle(d)
  const after = await ledgerOf(cwd, 'sD')
  assert.deepEqual([after.used, after.chats], [['c2n1', 'c1n1'], ['c2', 'c1']], 'the waiting use moved with its chat: beta is c1 now')
  // Chat D recalls an id it was given before: told which numbers changed, once.
  const first = (await h.recall(d, 'c2n1')).text
  assert.match(first, /^\[context-graph\] Chat numbers were renumbered[^\n]*: c2–c3→c1–c2; removed c1\.\n\n# c2n1 gamma signing/)
  d.session.append(toolResult(first))
  assert.doesNotMatch((await h.recall(d, 'c2n1')).text, /renumbered/)
  assert.doesNotMatch((await h.recall(d, 't1')).text, /renumbered/, 'its own turns never changed')
  // Gamma, used before as c3n1, is not counted again as c2n1.
  await h.plugin.settle(d)
  const again = await ledgerOf(cwd, 'sD')
  assert.deepEqual([again.c.used, again.c.history, again.chats], [2, after.c.history, ['c2', 'c1']])
  // Chat E, also from before, is told with its next note; a chat begun after is not.
  const e = agentOf('sE', cwd, [{ ...system(), time: OLD }])
  const note = (await h.step(e, ask('what did we decide about gamma signing?'))).messages[1].content[0].text
  assert.match(note, /^\[context-graph\] Chat numbers were renumbered/)
  const fresh = agentOf('sF', cwd, [system()])
  assert.doesNotMatch((await h.step(fresh, ask('what did we decide about gamma signing?'))).messages[1].content[0].text, /renumbered/)
  // A new chat is numbered after the existing ones.
  await build('sG', 'delta logging')
  assert.equal(await cidOf(dirOf(cwd), 'sG'), 3)
}))

test('an id a chat was sent before a renumbering does not count as shown: the topic that has it now is sent (#109)', { skip }, () => inDir(async (cwd) => {
  const { h, call, build } = await workspace(cwd, () => ['sB', 'sC', 'sG'])
  await build('sA', 'alpha deployment')
  await build('sB', 'beta caching')
  await build('sC', 'gamma signing')
  // Chat G was shown beta as c2n1 before the deletion.
  const old = { ...user('- c2n1 beta caching — beta caching decided', OLD), data: { source: { kind: 'context-graph' }, content: [{ type: 'text', text: '[context-graph] Earlier chats:\n- c2n1 beta caching — beta caching decided' }] } }
  const g = agentOf('sG', cwd, [{ ...system(), time: OLD }, old])
  await call('forget', '?sid=sA', true)
  // Gamma is c2n1 now: it is sent, not taken for the beta line above.
  const note = (await h.step(g, ask('what did we decide about gamma signing?'))).messages[1].content[0].text
  assert.match(note, /- c2n1 gamma signing/)
}))

test('gaps left before (or by folders removed by hand) are closed at start, by the keeper (#109)', { skip }, () => inDir(async (cwd) => {
  const { h } = await workspace(cwd, () => [])
  const dir = dirOf(cwd)
  for (const [sid, cid] of [['s3', 3], ['s5', 5]]) await writeJson(join(dir, 'chats', sid, 'meta.json'), { cid, title: sid })
  await writeJson(join(dir, 'ledger', 'sX.json'), { v: 2, c: { used: 2 }, used: ['c3n1', 'c4n2'], chats: ['c3', 'c4'] })
  await h.plugin.keeper.sweep()
  assert.deepEqual([await cidOf(dir, 's3'), await cidOf(dir, 's5')], [1, 2])
  assert.deepEqual(await ledgerOf(cwd, 'sX'), { v: 2, c: { used: 2 }, used: ['c1n1'], chats: ['c1'] }, 'c4 was deleted: dropped, so the chat now c4 one day is not taken for it')
  const events = JSON.parse(await readFile(join(dir, 'renumbered.json'), 'utf8')).events
  assert.deepEqual(events.map((e) => [e.moves, e.gone]), [[[[3, 1], [5, 2]], [1, 2, 4]]])
}))
