/**
 * Cycle 4 (v0.10.0), storage and speed: a damaged file that cannot be moved aside (#79), no local
 * path in a meta (#78), no dsh log read to learn that an ordinary chat is not a fork (#72), forks
 * indexed by 0.4-0.6 found with one session listing per run (#58), a capped map (#82). Each test
 * fails without its fix.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-store.test.js
 */
import assert from 'node:assert/strict'
import fsp, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDir, loadGraph, loadMeta, saveGraph, updateMeta } from '../../src/store/chats.js'
import { readJsonDetailed } from '../../src/store/files.js'
import { addToLedger } from '../../src/store/ledger.js'
import { saveMessages } from '../../src/store/messages.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle4s-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const blockOf = (out) => (out.messages.length > 1 ? out.messages.at(-1).content[0].text : '')
const node = (label, gist, refs) => ({ label, gist, aliases: [], kind: 'decision', refs, at: 'T', updated: 'T' })

/** A chat folder as 0.4-0.7 wrote it: its meta has neither a fork point nor a first prompt. */
async function legacyChat(dir, sid, title, nodes) {
  const now = new Date().toISOString()
  const meta = await updateMeta(dir, sid, (m) => m, () => ({ title, startedAt: now, lastActiveAt: now, builtSeq: 12 }))
  await saveGraph(chatDir(dir, sid), { version: 2, nextId: Object.keys(nodes).length + 1, nodes, edges: [] })
  return meta.cid
}

/**
 * While `fn` runs, moving a file aside fails as it does on Windows while a sync tool or a scan holds
 * the file without delete sharing (EBUSY). Reads and writes still work: the worst case, a hold that
 * is over before the next write.
 */
async function holdingAside(fn) {
  const rename = fsp.rename
  fsp.rename = async (from, to) => {
    if (String(to).includes('.corrupt-')) throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}'`), { code: 'EBUSY' })
    return rename(from, to)
  }
  syncBuiltinESMExports()
  try { return await fn() } finally {
    fsp.rename = rename
    syncBuiltinESMExports()
  }
}

test('#79 a damaged file that cannot be moved aside is not read as missing, and no writer replaces it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cg-cycle4s-'))
  try {
    const chat = chatDir(dir, 'sA')
    await mkdir(chat, { recursive: true })
    await mkdir(join(dir, 'ledger'))
    const files = [
      [join(chat, 'meta.json'), '{"cid":1,"builtSeq":8,"offSeq":8,"memoryOff":true,"priv'],
      [join(chat, 'msgs.json'), '{"v":1,"m":{"1":{"r":"user","x":"forty stored messages'],
      [join(chat, 'topics.json'), '{"version":2,"nextId":26,"nodes":{"n1":{"label":"twenty-five topics'],
      [join(dir, 'ledger', 'sA.json'), '{"c":{"sent":40']
    ]
    for (const [path, raw] of files) await writeFile(path, raw, 'utf8')
    await quietly(() => holdingAside(async () => {
      await assert.rejects(readJsonDetailed(files[0][0]), { code: 'EBUSY' })
      await assert.rejects(loadMeta(dir, 'sA'), { code: 'EBUSY' }, 'not "no meta", which reads as memory on')
      await assert.rejects(updateMeta(dir, 'sA', (m) => ({ ...m, builtSeq: 16 })))
      await assert.rejects(saveMessages(chat, [{ seq: 9, role: 'user', text: 'typed while off' }]))
      await assert.rejects(loadGraph(chat, { writable: true }))
      await assert.rejects(addToLedger(dir, 'sA', { requests: 1 }))
    }))
    for (const [path, raw] of files) assert.equal(await readFile(path, 'utf8'), raw, `${path} is left as it was`)
    assert.ok((await readdir(chat)).every((f) => !f.includes('.corrupt-')))
    // Once the file is free, the next read sets it aside and the chat reads as private, memory off.
    assert.equal((await quietly(() => loadMeta(dir, 'sA'))).memoryOff, true)
    assert.ok((await readdir(chat)).some((f) => f.startsWith('meta.json.corrupt-')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('#79 a memory-off chat whose damaged meta cannot be moved aside gets no memory and is not indexed', { skip }, () => inWorkspace(async (cwd) => {
  const llm = scriptedLlm({ reply: DEFAULT_REPLY })
  const h = await setup({ buildEveryTurns: 1, buildMinChars: 1 }, llm)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, chatEvents(4))
  await h.run(b, 'build')
  await h.run(b, 'off')
  b.session.append(user('SECRET my tax id is 123-45-6785'))
  b.session.append(assistant('noted'))
  const file = join(cwd, '.context-graph', 'chats', 'sB', 'meta.json')
  const damaged = (await readFile(file, 'utf8')).slice(0, -3)
  await writeFile(file, damaged, 'utf8')
  const calls = llm.calls
  const logs = []
  const original = console.error
  console.error = (...args) => logs.push(args.map(String).join(' '))
  try {
    await holdingAside(async () => {
      assert.equal((await h.step(b, ask('is commit signing set up?'))).messages.length, 1, 'no memory block')
      b.session.append(assistant('I cannot tell.'))
      h.listeners['agent/turn-stopping']({ agent: b })
      // The turn end's background work gives up on the meta (or, unfixed, indexes the chat).
      await until(() => llm.calls > calls || logs.some((line) => /activity update failed|build failed/.test(line)))
    })
  } finally {
    console.error = original
  }
  assert.equal(llm.calls, calls, 'not indexed: the model never saw what was typed while off')
  assert.equal(await readFile(file, 'utf8'), damaged, 'the meta is left as it was')
  // Once the file is free, the chat reads as memory off (fail closed, #50).
  assert.equal((await quietly(() => h.step(b, ask('is commit signing set up?')))).messages.length, 1)
}))

test('#78 a meta keeps no local path: a new one has none, an older one drops it on its next write', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup()
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  assert.equal((await metaOf(cwd, 'sA')).workspace, undefined)
  // As 0.9.0 wrote it.
  await updateMeta(dir, 'sA', (m) => ({ ...m, workspace: dir }))
  await h.run(a, 'unshare')
  const meta = await metaOf(cwd, 'sA')
  assert.equal(meta.private, true)
  assert.equal(meta.workspace, undefined)
}))

test('#72 a topic recall of an ordinary chat reads no dsh log; a meta from 0.4-0.7 still asks dsh, once', { skip }, () => inWorkspace(async (cwd) => {
  const observed = []
  const sessionQuery = { async observeSession(sid) { observed.push(sid); return { header: {}, inheritedEventCount: 0, events: [], [Symbol.dispose]() {} } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  assert.match((await h.recall(b, 'c1n1')).text, /^# c1n1 commit signing/)
  assert.deepEqual(observed, [], 'its meta says it is not a fork')
  const cid = await legacyChat(join(cwd, '.context-graph'), 'sL', 'deploys', { n1: node('deploy key rotation', 'rotated every 90 days', [1]) })
  for (let i = 0; i < 2; i++) assert.match((await h.recall(b, `c${cid}n1`)).text, /deploy key rotation/)
  assert.deepEqual(observed, ['sL'])
}))

test('#58 a fork indexed by 0.4-0.6 and never opened again holds back what it inherited from the first message on; one listing per run', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  let listings = 0
  const observed = []
  const sessionQuery = {
    async listSessions() { listings++; return [{ header: { id: 'sF', isSeeded: true } }, { header: { id: 'sL', isSeeded: false } }] },
    async observeSession(sid) { observed.push(sid); return { header: { isSeeded: sid === 'sF' }, inheritedEventCount: sid === 'sF' ? 9 : 0, events: [], [Symbol.dispose]() {} } }
  }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  // A topic drawn from an inherited message (before seq 9), and one of its own.
  await legacyChat(dir, 'sF', 'quarterly planning', { n1: node('payroll cut plan', 'confidential payroll decision', [1]), n2: node('office move date', 'the office moves on March 3', [10]) })
  await legacyChat(dir, 'sL', 'deploys', { n1: node('deploy key rotation', 'rotated every 90 days', [1]) })
  const blockFor = async (text) => blockOf(await h.step(agentOf(`sR${Math.random()}`, cwd, [system()]), ask(text)))
  assert.doesNotMatch(await blockFor('what is the payroll cut plan?'), /payroll/, 'held back from the first message of the run')
  await until(async () => /office move date/.test(await blockFor('when is the office move date?')))
  assert.doesNotMatch(await blockFor('what is the payroll cut plan?'), /payroll/, 'and once its fork point is known')
  assert.match(await blockFor('how often is the deploy key rotation?'), /deploy key rotation/, 'a chat dsh does not list as a fork is served')
  assert.equal(listings, 1)
  assert.deepEqual(observed, ['sF'], 'one log read, the fork\'s')
}))

test('#82 /context-graph map lists the newest 40 chats and points to the page for the rest', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  for (let i = 1; i <= 45; i++) {
    await mkdir(chatDir(dir, `s${i}`), { recursive: true })
    const at = new Date(Date.UTC(2026, 10, 1, 9, i)).toISOString()
    await writeFile(join(chatDir(dir, `s${i}`), 'meta.json'), JSON.stringify({ cid: i, title: `chat ${i}`, startedAt: at, lastActiveAt: at }), 'utf8')
  }
  const text = (await (await setup()).run(agentOf('s45', cwd, [system()]), 'map')).text
  assert.match(text, /^45 chats in /)
  assert.equal(text.match(/^c\d+ /gm).length, 40)
  assert.match(text, /^c45 /m, 'the newest')
  assert.match(text, /^c6 /m)
  assert.doesNotMatch(text, /^c5 /m, 'not the oldest')
  assert.match(text, /\n… 5 more chats; Plugins → Context Graph has the full map$/)
}))
