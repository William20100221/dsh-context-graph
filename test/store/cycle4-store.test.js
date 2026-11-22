/**
 * Cycle 4 (v0.10.0): the savings ledger is one small file per chat, holding only what is not zero
 * (#78, #83); 0.9.0's ledger.json is read as where each chat's file starts, and never written again.
 * No meta holds a local path (#78). Plain node:test, no dsh needed.
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { addCounters, balance } from '../../src/core/ledger.js'
import { loadMeta, migrateRootLayout } from '../../src/store/chats.js'
import { addToLedger, chatEntry, loadLedger, workspaceTotal } from '../../src/store/ledger.js'

async function workspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cg-store4-'))
  try { await fn(dir) } finally { await rm(dir, { recursive: true, force: true, maxRetries: 10 }) }
}

test('#83 #78 a turn end writes only its own chat\'s small file; 0.9.0\'s ledger.json is read, kept as it was, and counts the same', () => workspace(async (dir) => {
  // The whole ledger as 0.9.0 wrote it: every counter, zeros too, an empty used list, a time.
  const old = JSON.stringify({ v: 1, chats: {
    sA: { c: { sent: 100, resent: 50, tool: 20, recalled: 0, indexIn: 300, indexCached: 0, indexOut: 40, stoodIn: 900, used: 2, requests: 5 }, used: ['c1n1', 'c1n2'], msgs: ['1:2', '1:4'], at: '2026-11-17T10:00:00.000Z' },
    sB: { c: { sent: 0, resent: 0, tool: 30, recalled: 0, indexIn: 0, indexCached: 0, indexOut: 0, stoodIn: 0, used: 0, requests: 3 }, used: [], at: '2026-11-17T10:00:00.000Z' }
  } })
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'ledger.json'), old, 'utf8')
  const before = await workspaceTotal(dir)
  assert.equal(before.tool, 50, 'a workspace 0.9.0 left keeps its total')
  assert.deepEqual((await chatEntry(dir, 'sA')).used, ['c1n1', 'c1n2'])

  const delta = { sent: 10, requests: 1 }
  await addToLedger(dir, 'sA', delta, ['c1n3'], ['c2'])
  assert.equal(await readFile(join(dir, 'ledger.json'), 'utf8'), old, 'the old file is only read')
  assert.deepEqual(await readdir(join(dir, 'ledger')), ['sA.json'], 'one file, the chat\'s own')
  // Converted in the same write (#104): the old stand-in count goes, the chats it used are named
  // (chat 1 is not in this folder, so its history counts nothing); no zero, no time.
  assert.deepEqual(JSON.parse(await readFile(join(dir, 'ledger', 'sA.json'), 'utf8')), {
    v: 2,
    c: { sent: 110, resent: 50, tool: 20, indexIn: 300, indexOut: 40, used: 2, requests: 6 },
    used: ['c1n1', 'c1n2', 'c1n3'],
    chats: ['c1', 'c2']
  }, 'every cost counter and used id carried over')
  assert.deepEqual((await chatEntry(dir, 'sA')).used, ['c1n1', 'c1n2', 'c1n3'], 'the chat\'s own file wins')
  assert.deepEqual(Object.keys((await loadLedger(dir)).chats).sort(), ['sA', 'sB'])
  assert.deepEqual(balance(await workspaceTotal(dir)), balance(addCounters(before, delta)), 'the same counters give the same savings')

  // A chat that only made requests stores just those.
  await addToLedger(dir, 'sC', { tool: 25, requests: 1 })
  assert.equal(await readFile(join(dir, 'ledger', 'sC.json'), 'utf8'), '{"v":2,"c":{"tool":25,"requests":1}}')
}))

test('#78 the meta of memory moved from v0.1-v0.3 holds no local path', () => workspace(async (dir) => {
  await writeFile(join(dir, 'graph.json'), JSON.stringify({ version: 1, nextId: 2, nodes: { n1: { label: 'battery limit', gist: 'g', aliases: [], kind: 'fact', src: [], updated: '2026-11-02T04:33:00Z' } }, edges: [] }))
  const sid = await migrateRootLayout(dir)
  assert.equal((await loadMeta(dir, sid)).title, 'Memory from before v0.4')
  assert.equal((await loadMeta(dir, sid)).workspace, undefined)
}))

test('second review: a damaged fork meta keeps its ancestors\' off stretches next to the ones read back', () => workspace(async (dir) => {
  const { updateMeta } = await import('../../src/store/chats.js')
  await mkdir(join(dir, 'chats', 'sF'), { recursive: true })
  // Cut off mid-write after its own gaps, so they can be read back.
  await writeFile(join(dir, 'chats', 'sF', 'meta.json'), '{"cid":3,"forkSeq":30,"parent":"sP","gaps":[[40,45]],"summary":"the fork', 'utf8')
  const fresh = () => ({ forkSeq: 30, parent: 'sP', gaps: [[5, 11]], offsInherited: true, startedAt: 'T', lastActiveAt: 'T' })
  const meta = await updateMeta(dir, 'sF', (m) => m, fresh)
  assert.deepEqual(meta.gaps, [[5, 11], [40, 45]])
  assert.equal(meta.memoryOff, true, 'a recovered meta reads as off until on')
}))
