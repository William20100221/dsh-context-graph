/**
 * Cycle 2 (v0.8.0): the store. Read cache (#33), fail-closed reads (#50), repair of long junk (#54),
 * and the v1 backup kept until it has been quiet for a week (#56). Plain node:test, no dsh needed.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDir, loadGraph, loadMeta, saveGraph, updateMeta } from '../../src/store/chats.js'
import { BACKUP_DAYS, upgradeChat } from '../../src/store/migrate.js'

const exists = (path) => stat(path).then(() => true, () => false)
async function workspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-store2-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true }) }
}
const quietly = async (fn) => {
  const original = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = original }
}

test('#33 an unchanged file is read once; readers share a frozen copy; a write is seen at once', () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await saveGraph(chat, { version: 2, nextId: 2, nodes: { n1: { label: 'a', gist: 'g', aliases: [], refs: [] } }, edges: [] })
  const first = await loadGraph(chat)
  assert.equal(await loadGraph(chat), first, 'the same object while the file is unchanged')
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.nodes.n1), 'shared data cannot be changed by a reader')
  assert.throws(() => { first.nodes.n1.label = 'x' }, TypeError)
  const writable = await loadGraph(chat, { writable: true })
  assert.notEqual(writable, first)
  writable.nodes.n2 = { label: 'b', gist: '', aliases: [], refs: [] }
  await saveGraph(chat, writable)
  assert.deepEqual(Object.keys((await loadGraph(chat)).nodes), ['n1', 'n2'], 'the next read sees the write')
}))

test('#50 an unreadable meta reads as private with memory off, keeping its number, without a write', () => workspace(async (dir) => {
  const meta = await updateMeta(dir, 'sA', (m) => ({ ...m, builtSeq: 12 }), () => ({ title: 'a' }))
  const file = join(chatDir(dir, 'sA'), 'meta.json')
  await writeFile(file, `{"cid":${meta.cid},"builtSeq":12,"memoryOff":fal`, 'utf8')
  const read = await quietly(() => loadMeta(dir, 'sA'))
  assert.deepEqual([read.cid, read.builtSeq, read.private, read.memoryOff], [meta.cid, 12, true, true])
  assert.equal(await exists(file), false, 'nothing was written in its place')
  assert.equal((await loadMeta(dir, 'sA')).memoryOff, true, 'and it stays closed while the file is gone')
  assert.equal(await loadMeta(dir, 'never-seen'), undefined, 'a chat with no meta at all is just new')
}))

test('#54 trailing junk of any length is cut where the JSON ends', () => workspace(async (dir) => {
  await mkdir(chatDir(dir, 'sA'), { recursive: true })
  const value = { cid: 4, title: 'x }} in a string', builtSeq: 3 }
  await writeFile(join(chatDir(dir, 'sA'), 'meta.json'), JSON.stringify(value) + '"}'.repeat(77) + ']}', 'utf8')
  assert.deepEqual(await quietly(() => loadMeta(dir, 'sA')), value, '77 closing braces of junk, as v0.6 could leave in msgs.json')
}))

test('review: two readers of a folder that is being upgraded both see its topics', () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await mkdir(join(chat, 'src'), { recursive: true })
  const node = (label) => ({ label, gist: 'g', aliases: [], kind: 'fact', src: [], updated: '2026-11-01T10:00:00Z' })
  await writeFile(join(chat, 'graph.json'), JSON.stringify({ version: 1, nextId: 3, nodes: { n1: node('a'), n2: node('b') }, edges: [] }))
  const [first, second] = await Promise.all([loadGraph(chat), loadGraph(chat)])
  assert.deepEqual([Object.keys(first.nodes).length, Object.keys(second.nodes).length], [2, 2], 'the second reader waits for the upgrade in flight')
}))

test(`#56 the v1 backup is kept until ${BACKUP_DAYS} days after its LAST write`, () => workspace(async (dir) => {
  const chat = chatDir(dir, 'sA')
  await mkdir(join(chat, 'src'), { recursive: true })
  const v1 = { version: 1, nextId: 2, nodes: { n1: { label: 'pnpm via corepack', gist: 'g', aliases: [], kind: 'fact', src: [], updated: '2026-11-01T10:00:00Z' } }, edges: [] }
  await writeFile(join(chat, 'graph.json'), JSON.stringify(v1))
  await loadGraph(chat)
  const day = 86400000
  // An older plugin copy writes the old file again on day 6.
  v1.nodes.n2 = { label: 'late topic', gist: 'g', aliases: [], kind: 'fact', src: [], updated: '2026-11-07T10:00:00Z' }
  await writeFile(join(chat, 'graph.json'), JSON.stringify(v1))
  const day6 = new Date(Date.now() + 6 * day)
  await utimes(join(chat, 'graph.json'), day6, day6)
  await upgradeChat(chat, { now: new Date(Date.now() + 6.5 * day) })
  await upgradeChat(chat, { now: new Date(Date.now() + (BACKUP_DAYS + 0.5) * day) })
  assert.equal(await exists(join(chat, 'graph.json')), true, 'quiet for only 1.5 days: kept')
  await upgradeChat(chat, { now: new Date(Date.now() + (BACKUP_DAYS + 6.5) * day) })
  assert.equal(await exists(join(chat, 'graph.json')), false, 'a week after the last write: removed')
  assert.deepEqual(Object.values((await loadGraph(chat)).nodes).map((n) => n.label).sort(), ['late topic', 'pnpm via corepack'])
  assert.ok(JSON.parse(await readFile(join(chat, 'topics.json'), 'utf8')).upgradedAt)
}))
