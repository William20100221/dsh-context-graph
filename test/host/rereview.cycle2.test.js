/**
 * Host regression tests for the second, focused review of the cycle-2 (v0.8.0) fixes.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/rereview.cycle2.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDir, saveGraph, updateMeta } from '../../src/store/chats.js'
import { saveMessages } from '../../src/store/messages.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, scriptedLlm, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-rereview2-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const topic = (label, aliases, msgs = [0], gist = `${label}, decided`) => JSON.stringify({ nodes: [{ id: null, label, gist, aliases, kind: 'decision', msgs }], edges: [] })
const blockOf = (out) => (out.messages.length > 1 ? out.messages.at(-1).content[0].text : '')

/** A fork folder the way v0.4-v0.6 wrote it: no fork point in its meta, a topic drawn from an inherited message. */
async function legacyFork(cwd, sid, secret) {
  const dir = join(cwd, '.context-graph')
  await updateMeta(dir, sid, (m) => m, () => ({ title: 'We decided to sign commits with the SSH key, step 0.', startedAt: new Date().toISOString(), lastActiveAt: new Date().toISOString(), builtSeq: 12 }))
  await saveGraph(chatDir(dir, sid), { version: 2, nextId: 2, nodes: { n1: { label: 'payroll cut plan', gist: 'confidential payroll decision', aliases: ['payroll'], kind: 'decision', refs: [1], at: 'T', updated: 'T' } }, edges: [] })
  await saveMessages(chatDir(dir, sid), [{ seq: 1, role: 'user', text: secret }])
  return (await metaOf(cwd, sid)).cid
}

test('a fork written by v0.4-v0.6 stops sharing its inherited topics once its fork point is known (second review)', { skip }, () => inWorkspace(async (cwd) => {
  const sessionQuery = { async observeSession() { return { header: { isSeeded: true }, inheritedEventCount: 9, events: [], [Symbol.dispose]: () => {} } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  await legacyFork(cwd, 'sF', 'Confidential: payroll cut of 15 percent')
  const b = agentOf('sB', cwd, [system(), user('hi'), assistant('hello')])
  // Opened in this version, the fork records its fork point and stops offering what it inherited.
  const fork = agentOf('sF', cwd, [...chatEvents(4), user('the fork goes on')], { header: { isSeeded: true }, inheritedEventCount: 9 })
  await h.run(fork, 'share')
  assert.equal((await metaOf(cwd, 'sF')).forkSeq, 9)
  assert.doesNotMatch(blockOf(await h.step(b, ask('what is the payroll cut plan?'))), /payroll/)
  // A legacy fork never opened again: recall asks dsh for its fork point before serving anything.
  const cid = await legacyFork(cwd, 'sG', 'Confidential: payroll cut of 20 percent')
  const recalled = await h.recall(b, `c${cid}n1`)
  assert.equal(recalled.status, 'unknown')
  assert.doesNotMatch(recalled.text, /20 percent/)
  assert.doesNotMatch(blockOf(await h.step(b, ask('the payroll cut plan again?'))), /20 percent|payroll cut plan/, 'and it is no longer matched in this run')
}))

test('recall of a chat number this chat shares with another names the other chat (second review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  await (await setup({}, scriptedLlm({ reply: topic('gpg commit signing', ['gpg']) }))).run(agentOf('sOther', cwd, chatEvents(4)), 'build')
  const reader = agentOf('sMine', cwd, chatEvents(4))
  await (await setup({}, scriptedLlm({ reply: topic('lunch menu', ['lunch']) }))).run(reader, 'build')
  await updateMeta(dir, 'sMine', (m) => ({ ...m, cid: 1, private: true, lastActiveAt: '2099-01-01T00:00:00.000Z' }))
  const recalled = await (await setup()).recall(reader, 'c1n1')
  assert.match(recalled.text, /# c1n1 gpg commit signing/)
}))

test('a fork\'s day digest leaves out the chats it holds word for word (second review)', { skip }, () => inWorkspace(async (cwd) => {
  await (await setup({}, scriptedLlm({ reply: topic('deploy key rotation', ['deploy']) }))).run(agentOf('sU', cwd, [system(), user('We rotate the deploy key every 90 days now.'), assistant('noted'), ...chatEvents(3).slice(1)]), 'build')
  const h = await setup()
  const parentEvents = chatEvents(4)
  await h.run(agentOf('sP', cwd, parentEvents), 'build')
  const parentCid = (await metaOf(cwd, 'sP')).cid
  const fork = agentOf('sF', cwd, [...parentEvents, user('in the fork')], { header: { isSeeded: true }, inheritedEventCount: parentEvents.length })
  const block = blockOf(await h.step(fork, ask('what did we do today?')))
  assert.match(block, /Chats from today/)
  assert.doesNotMatch(block, new RegExp(`\\n- c${parentCid} `), 'the parent is already in the fork')
  assert.match(block, /deploy key rotation/, 'other chats still are')
}))
