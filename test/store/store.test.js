/**
 * The store: folder layout, concurrency (#10, #11), damaged files, messages stored once (#12) and
 * non-destructive migrations from v0.1-v0.6 layouts (#12, #17 and the cycle-1 review).
 * Plain node:test, no dsh needed.
 */
import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { emptyGraph, mergeDelta } from '../../src/core/index.js'
import { chatDir, listChats, loadGraph, loadMeta, migrateRootLayout, saveGraph, updateMeta } from '../../src/store/chats.js'
import { writeJson } from '../../src/store/files.js'
import { capText, loadMessages, oldTurns, saveMessages, sourceOf } from '../../src/store/messages.js'
import { BACKUP_DAYS, parseSourceFile, upgradeChat } from '../../src/store/migrate.js'

const exists = (path) => stat(path).then(() => true, () => false)
async function workspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-store-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const quietly = async (fn) => {
  const original = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = original }
}

/** A v0.1-v0.6 source file: sections per build, messages under "**role** (seq N):". */
const v1Source = (sections) => sections.map(({ at, session, turn, messages }) =>
  `## ${at} session ${session} turn ${turn}\n\n${messages.map((m) => `**${m.role}** (seq ${m.seq}):\n\n${m.text}`).join('\n\n')}\n\n`).join('')

const v1Node = (label, session, extra = {}) => ({ label, gist: `about ${label}`, aliases: [], kind: 'fact', src: [{ session, turn: null, at: '2026-11-01T10:00:00Z' }], updated: '2026-11-01T10:00:00Z', hits: 0, ...extra })

test('layout: one folder per chat, chat numbers, newest first, graph round-trip', () => workspace(async (dir) => {
  assert.deepEqual(await listChats(dir), [], 'no chats folder yet')
  const a = await updateMeta(dir, 'sA', (m) => m, () => ({ title: 'first', lastActiveAt: '2026-11-01T09:00:00Z' }))
  const b = await updateMeta(dir, 'sB', (m) => m, () => ({ title: 'second', lastActiveAt: '2026-11-02T09:00:00Z' }))
  assert.deepEqual([a.cid, b.cid], [1, 2])
  const again = await updateMeta(dir, 'sA', (m) => ({ ...m, private: true }), () => ({ title: 'ignored' }))
  assert.equal(again.title, 'first', 'init only applies to a new chat')
  assert.equal((await loadMeta(dir, 'sA')).private, true)
  assert.deepEqual((await listChats(dir)).map((c) => c.sid), ['sB', 'sA'], 'newest activity first; the .cid folder is not a chat')
  const chat = chatDir(dir, 'sA')
  assert.equal(Object.keys((await loadGraph(chat)).nodes).length, 0, 'missing file is an empty graph')
  const g = emptyGraph()
  mergeDelta(g, { nodes: [{ label: 'x', msgs: [0] }], edges: [] }, { now: 'T', refsOf: () => [3] })
  await saveGraph(chat, g)
  assert.deepEqual(await loadGraph(chat), g)
  assert.ok(!(await readFile(join(chat, 'topics.json'), 'utf8')).includes('\n'), 'compact JSON on disk')
}))

test('#10 concurrent writes never corrupt a file, even unserialized', () => workspace(async (dir) => {
  await updateMeta(dir, 'sA', (m) => m, () => ({ title: 'a' }))
  const writes = []
  for (let i = 0; i < 60; i++) {
    writes.push(updateMeta(dir, 'sA', (m) => ({ ...m, n: i, pad: 'x'.repeat((i % 7) * 300) })))
    writes.push(saveGraph(chatDir(dir, 'sA'), { ...emptyGraph(), nextId: i + 1 }))
  }
  await Promise.all(writes)
  assert.equal(JSON.parse(await readFile(join(chatDir(dir, 'sA'), 'meta.json'), 'utf8')).n, 59, 'updates are serialized: none is lost mid-write')
  const file = join(dir, 'raw.json')
  for (let round = 0; round < 50; round++) {
    const results = await Promise.allSettled([writeJson(file, { big: 'x'.repeat(4000) }), writeJson(file, { small: 1 })])
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'], 'two direct writes to one file both succeed')
    JSON.parse(await readFile(file, 'utf8'))
  }
  assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind')
}))

test('#10 a damaged file: trailing junk is repaired; an unreadable one is kept aside, never overwritten', () => workspace(async (dir) => {
  await updateMeta(dir, 'sB', (m) => ({ ...m, private: true }), () => ({ title: 'b' }))
  const metaB = join(chatDir(dir, 'sB'), 'meta.json')
  await writeFile(metaB, `${await readFile(metaB, 'utf8')}garbage}`, 'utf8')
  assert.equal((await quietly(() => loadMeta(dir, 'sB'))).private, true, 'a valid prefix is recovered, flags included')

  await updateMeta(dir, 'sC', (m) => ({ ...m, private: true, memoryOff: true, builtSeq: 40 }), () => ({ title: 'c' }))
  const cid = (await loadMeta(dir, 'sC')).cid
  await writeFile(join(chatDir(dir, 'sC'), 'meta.json'), `{"cid":${cid},"builtSeq":40,"private":tr`, 'utf8')
  const chats = await quietly(() => listChats(dir))
  const read = chats.find((c) => c.sid === 'sC')
  // #50: read as private with memory off (what the lost file may have said), keeping its number.
  assert.deepEqual([read?.meta.cid, read?.meta.private, read?.meta.memoryOff], [cid, true, true], 'an unreadable meta fails closed on read; the workspace keeps working')
  assert.ok((await readdir(chatDir(dir, 'sC'))).some((f) => f.startsWith('meta.json.corrupt-')), 'the bytes are kept aside')
  const healed = await quietly(() => updateMeta(dir, 'sC', (m) => m, () => ({ title: 'fresh' })))
  assert.equal(healed.cid, cid, 'the chat keeps its number')
  assert.equal(healed.builtSeq, 40, 'and its index position')
  assert.equal(healed.private, true, 'it fails closed: private')
  assert.equal(healed.memoryOff, true, 'it fails closed: memory off')

  await writeFile(join(chatDir(dir, 'sB'), 'topics.json'), '{"nodes": {', 'utf8')
  assert.equal(Object.keys((await quietly(() => loadGraph(chatDir(dir, 'sB')))).nodes).length, 0, 'an unreadable graph reads as empty')
  assert.ok((await readdir(chatDir(dir, 'sB'))).some((f) => f.startsWith('topics.json.corrupt-')))
  await mkdir(join(dir, 'chats', 'stray', 'meta.json'), { recursive: true })
  assert.ok((await quietly(() => listChats(dir))).length >= 1, 'an entry that cannot be read at all is skipped, not fatal')
}))

test('#11 chats that start at the same moment get different chat numbers', () => workspace(async (dir) => {
  const metas = await Promise.all(Array.from({ length: 12 }, (_, i) => updateMeta(dir, `s${i}`, (m) => m, () => ({ title: `chat ${i}` }))))
  assert.equal(new Set(metas.map((m) => m.cid)).size, 12)
  await mkdir(join(dir, 'chats', '.cid'), { recursive: true })
  await writeFile(join(dir, 'chats', '.cid', '13'), '', 'utf8')
  assert.equal((await updateMeta(dir, 'late', (m) => m)).cid, 14, 'a number another process claimed is never reused')
}))

test('#12 each message is stored once, by seq, capped; topics point at it', () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  const msgs = [{ seq: 5, role: 'user', text: 'hello', turn: 2, time: 1 }, { seq: 6, role: 'assistant', text: 'hi', turn: 2 }]
  await saveMessages(chat, msgs)
  await saveMessages(chat, [{ seq: 5, role: 'user', text: 'CHANGED' }, ...msgs])
  const stored = await loadMessages(chat)
  assert.deepEqual(Object.keys(stored), ['5', '6'])
  assert.equal(stored['5'].x, 'hello', 'writing a seq twice is a no-op')
  assert.equal(JSON.parse(await readFile(join(chat, 'msgs.json'), 'utf8')).v, 2, 'a new store numbers turns as dsh does (#71)')
  assert.equal(await oldTurns(chat), false)
  assert.deepEqual(sourceOf(stored, { refs: [6, 5, 99] }).map((m) => [m.seq, m.role, m.text]), [[6, 'assistant', 'hi'], [5, 'user', 'hello']])
  const long = 'a'.repeat(4500) + 'MIDDLE' + 'b'.repeat(5000)
  const capped = capText(long)
  assert.ok(capped.length < 6000 && capped.startsWith('aaaa') && capped.endsWith('bbbb') && !capped.includes('MIDDLE'))
  assert.equal(capText('short'), 'short')
}))

test('parseSourceFile reads the v0.1-v0.6 source format, with the session of each section', () => {
  const text = v1Source([
    { at: 'T1', session: 'sA', turn: 'null', messages: [{ seq: 1, role: 'user', text: 'first\n\nwith a blank line' }, { seq: 2, role: 'assistant', text: 'answer' }] },
    { at: 'T2', session: 'sB', turn: 3, messages: [{ seq: 7, role: 'user', text: 'later' }] }
  ])
  assert.deepEqual(parseSourceFile(text), [
    { seq: 1, role: 'user', text: 'first\n\nwith a blank line', session: 'sA' },
    { seq: 2, role: 'assistant', text: 'answer', session: 'sA' },
    { seq: 7, role: 'user', text: 'later', session: 'sB' }
  ])
  assert.deepEqual(parseSourceFile(''), [])
})

/** A v0.4-v0.6 chat folder: graph.json v1 + one source file per topic citing the same two messages. */
async function v1Chat(chat, { long = false } = {}) {
  await mkdir(join(chat, 'src'), { recursive: true })
  const sid = chat.split(/[\\/]/).at(-1)
  const shared = [{ seq: 1, role: 'user', text: long ? `decided ${'x'.repeat(20000)} MIDDLE-FACT ${'y'.repeat(20000)}` : 'decided to use corepack' }, { seq: 2, role: 'assistant', text: 'ok, corepack pnpm' }]
  const v1 = { version: 1, nextId: 3, nodes: { n1: v1Node('pnpm via corepack', sid, { hits: 4 }), n2: v1Node('pnpm not on PATH', sid, { updated: '2026-11-02T10:00:00Z' }) }, edges: [['n1', 'n2', 'caused-by']] }
  await writeFile(join(chat, 'graph.json'), JSON.stringify(v1, null, 1))
  for (const id of ['n1', 'n2']) await writeFile(join(chat, 'src', `${id}.md`), v1Source([{ at: 'T', session: sid, turn: null, messages: shared }]))
}

test('#12 a v0.4-v0.6 chat folder is upgraded without deleting or cutting anything', () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await v1Chat(chat, { long: true })
  const graph = await loadGraph(chat)
  assert.equal(graph.version, 2)
  assert.deepEqual([graph.nodes.n1.refs, graph.nodes.n2.refs], [[1, 2], [1, 2]])
  assert.equal(graph.nodes.n1.at, '2026-11-01T10:00:00Z')
  assert.equal('src' in graph.nodes.n1 || 'hits' in graph.nodes.n1, false, 'write-only fields are gone')
  assert.deepEqual(graph.edges, [['n1', 'n2', 'caused-by']])
  const stored = await loadMessages(chat)
  assert.deepEqual(Object.keys(stored), ['1', '2'], 'the shared messages are stored once')
  assert.ok(stored['1'].x.includes('MIDDLE-FACT'), 'migrated text is kept in full: it may be the only copy')
  assert.ok(await exists(join(chat, 'graph.json')) && await exists(join(chat, 'src')), 'the v1 files stay as a read-only backup')
  assert.equal(await upgradeChat(chat), false, 'a second run does nothing')
}))

test('review: topics an older copy adds to graph.json after the upgrade are merged, not lost', () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await v1Chat(chat)
  await loadGraph(chat)
  const v1 = JSON.parse(await readFile(join(chat, 'graph.json'), 'utf8'))
  v1.nodes.n3 = v1Node('late topic', 'sA', { updated: '2026-11-03T10:00:00Z' })
  v1.nextId = 4
  await writeFile(join(chat, 'graph.json'), JSON.stringify(v1))
  await writeFile(join(chat, 'src', 'n3.md'), v1Source([{ at: 'T', session: 'sA', turn: null, messages: [{ seq: 9, role: 'user', text: 'a later decision' }] }]))
  const future = new Date(Date.now() + 5000)
  await utimes(join(chat, 'graph.json'), future, future)
  // The builder's load (writable) always looks; readers look at most once a minute (#33).
  const graph = await loadGraph(chat, { writable: true })
  assert.deepEqual(Object.values(graph.nodes).map((n) => n.label).sort(), ['late topic', 'pnpm not on PATH', 'pnpm via corepack'])
  assert.equal((await loadMessages(chat))['9'].x, 'a later decision')
}))

test(`review: the v1 backup is removed once it has been quiet for ${BACKUP_DAYS} days`, () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await v1Chat(chat)
  await loadGraph(chat)
  await upgradeChat(chat, { now: new Date(Date.now() + (BACKUP_DAYS - 1) * 86400000) })
  assert.equal(await exists(join(chat, 'graph.json')), true, 'kept before the deadline')
  await upgradeChat(chat, { now: new Date(Date.now() + (BACKUP_DAYS + 1) * 86400000) })
  assert.equal(await exists(join(chat, 'graph.json')), false)
  assert.equal(await exists(join(chat, 'src')), false)
  assert.equal(Object.keys((await loadGraph(chat)).nodes).length, 2, 'the upgraded memory is unaffected')
}))

test('#17 memory from v0.1-v0.3 (root graph.json) moves into a chat folder and is listed', () => workspace(async (dir) => {
  await mkdir(join(dir, 'src'), { recursive: true })
  const v1 = { version: 1, nextId: 2, nodes: { n1: v1Node('battery limit', 'old-session', { src: [{ session: 'old-session', turn: null, at: '2026-11-02T04:00:00Z' }], updated: '2026-11-02T04:33:00Z' }) }, edges: [] }
  await writeFile(join(dir, 'graph.json'), JSON.stringify(v1, null, 2))
  await writeFile(join(dir, 'src', 'n1.md'), v1Source([{ at: 'T', session: 'old-session', turn: null, messages: [{ seq: 4, role: 'user', text: 'how do I limit charging' }] }]))
  const chats = await listChats(dir)
  assert.deepEqual(chats.map((c) => [c.sid, c.meta.cid, c.meta.title, c.meta.legacyRoot]), [['old-session', 1, 'Memory from before v0.4', true]])
  assert.equal(chats[0].meta.startedAt, '2026-11-02T04:00:00Z')
  assert.equal(chats[0].meta.lastActiveAt, '2026-11-02T04:33:00Z')
  const graph = await loadGraph(chatDir(dir, 'old-session'))
  assert.deepEqual(graph.nodes.n1.refs, [4])
  assert.equal((await loadMessages(chatDir(dir, 'old-session')))['4'].x, 'how do I limit charging')
  assert.equal(await exists(join(dir, 'graph.json')), false, 'the root copy is removed only after the migration succeeded')
  assert.equal(await exists(join(dir, 'src')), false)
}))

test('review: a v0.1-v0.3 graph from several sessions keeps each session\'s text apart', () => workspace(async (dir) => {
  await mkdir(join(dir, 'src'), { recursive: true })
  const v1 = { version: 1, nextId: 3, nodes: { n1: v1Node('A topic', 'sA'), n2: v1Node('B topic', 'sB') }, edges: [] }
  await writeFile(join(dir, 'graph.json'), JSON.stringify(v1))
  await writeFile(join(dir, 'src', 'n1.md'), v1Source([{ at: 'T', session: 'sA', turn: null, messages: [{ seq: 1, role: 'user', text: 'SESSION A: use pnpm' }] }]))
  await writeFile(join(dir, 'src', 'n2.md'), v1Source([{ at: 'T', session: 'sB', turn: null, messages: [{ seq: 1, role: 'user', text: 'SESSION B: battery limit 80%' }] }]))
  const [chat] = await listChats(dir)
  assert.equal(chat.sid, 'legacy')
  const graph = await loadGraph(chatDir(dir, 'legacy'))
  const stored = await loadMessages(chatDir(dir, 'legacy'))
  const textOf = (id) => sourceOf(stored, graph.nodes[id]).map((m) => m.text)
  assert.deepEqual(textOf('n1'), ['SESSION A: use pnpm'])
  assert.deepEqual(textOf('n2'), ['SESSION B: battery limit 80%'])
}))

test('review: a root migration that is repeated (the root came back or deletion failed) duplicates nothing', () => workspace(async (dir) => {
  await mkdir(join(dir, 'src'), { recursive: true })
  const v1 = { version: 1, nextId: 2, nodes: { n1: v1Node('battery limit', 'sX') }, edges: [] }
  await writeFile(join(dir, 'graph.json'), JSON.stringify(v1))
  await writeFile(join(dir, 'src', 'n1.md'), v1Source([{ at: 'T', session: 'sX', turn: null, messages: [{ seq: 4, role: 'user', text: 'limit charging' }] }]))
  const keep = join(dir, '..', `${dir.split(/[\\/]/).at(-1)}-copy`)
  await cp(dir, keep, { recursive: true })
  try {
    assert.equal(await migrateRootLayout(dir), 'sX')
    await cp(join(keep, 'graph.json'), join(dir, 'graph.json'))
    await cp(join(keep, 'src'), join(dir, 'src'), { recursive: true })
    assert.equal(await migrateRootLayout(dir), 'sX', 'the same folder is used again')
    const graph = await loadGraph(chatDir(dir, 'sX'))
    assert.equal(Object.keys(graph.nodes).length, 1)
    assert.deepEqual(Object.keys(await loadMessages(chatDir(dir, 'sX'))), ['4'])
    assert.equal((await listChats(dir)).length, 1)
  } finally {
    await rm(keep, { recursive: true, force: true })
  }
}))
