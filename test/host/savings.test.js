/**
 * The savings estimate end to end (#35): the ledger file, and a chat that is sent a topic, uses it
 * in its answer and sees the result on the /context-graph card, also after a restart.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/savings.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { addToLedger, chatEntry, workspaceTotal } from '../../src/store/ledger.js'
import { agentOf, ask, assistant, chatEvents, setup, skip, system, until, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-savings-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const ledgerOf = async (cwd) => JSON.parse(await readFile(join(cwd, '.context-graph', 'ledger.json'), 'utf8'))

test('the ledger adds every write, even concurrent ones, and keeps used ids once', () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  await Promise.all(Array.from({ length: 20 }, (_, i) => addToLedger(dir, i % 2 ? 'sA' : 'sB', { sent: 10, tool: 1 }, [`c1n${i % 3}`])))
  const a = await chatEntry(dir, 'sA')
  assert.equal(a.c.sent, 100)
  assert.deepEqual([...a.used].sort(), ['c1n0', 'c1n1', 'c1n2'])
  assert.equal((await workspaceTotal(dir)).sent, 200)
}))

test('a topic the answer uses counts as saved; the card shows it, also after a restart', { skip }, () => inWorkspace(async (cwd) => {
  const { markAgentLoopRequest } = await import('@deepseek-ai/dsh-llm')
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  // Two label words: listed, not inlined (an inlined source would stand in for nothing more).
  const out = await h.step(b, ask('is commit signing set up?'))
  assert.equal(out.messages.length, 2, 'a block was sent')
  assert.doesNotMatch(out.messages[1].content[0].text, /Source of/)
  // The conversation requests that carry it, as dsh's agent loop makes them: the first sends the
  // block (counted as sent), the second re-sends it as cached input (counted as re-sent).
  const requestOnce = async () => {
    const request = markAgentLoopRequest({ provider: 'p', model: 'm', messages: [], sessionId: 'sB' })
    for await (const _ of h.listeners['llm/stream'](request, () => (async function* () { yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 40 } } })())) { /* drain */ }
  }
  await requestOnce()
  await requestOnce()
  b.session.append(assistant('Commits are signed: commit signing uses the SSH key id_ed25519_signing, not gpg.'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const entry = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(entry.c.used, 1)
  assert.ok(entry.c.stoodIn > 0, 'its original messages')
  assert.ok(entry.c.sent > 0 && entry.c.tool > 0 && entry.c.requests === 2)
  assert.equal(entry.c.resent, entry.c.sent, 'sent once, then re-sent once with the second request')
  assert.deepEqual(entry.used, ['c1n1'])
  const card = (await h.run(b, '')).text
  assert.match(card, /\nSavings \(estimate\): (saved|cost) about [\d,]+ tokens[^\n]* in this chat · /)
  assert.match(card, /stood in for: \d+ \(1 topic used/)
  const restarted = (await (await setup()).run(b, '')).text
  assert.match(restarted, /stood in for: \d+ \(1 topic used/, 'the ledger survives a restart')
}))

test('a recalled topic counts once as used; an unused line counts only as cost', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.step(b, ask('how is gpg commit signing set up?'))
  b.session.append(assistant('I do not know yet.'))
  h.listeners['agent/turn-stopping']({ agent: b })
  const first = await until(async () => (await ledgerOf(cwd).catch(() => undefined))?.chats?.sB)
  assert.equal(first.c.used, 0, 'the answer did not use it')
  await h.recall(b, 'c1n1')
  await h.recall(b, 'c1n1')
  h.listeners['agent/turn-stopping']({ agent: b })
  const second = await until(async () => { const e = (await ledgerOf(cwd)).chats.sB; return e.c.recalled > 0 && e })
  assert.equal(second.c.used, 1, 'two recalls of one topic: one use')
}))
