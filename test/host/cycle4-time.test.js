/**
 * Host tests for the cycle-4 time fixes (v0.10.0): the day digest and the day recall, through the plugin.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-time.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { day, estimateTokens } from '../../src/core/index.js'
import { chatDir, saveGraph, updateMeta } from '../../src/store/chats.js'
import { agentOf, ask, setup, skip, system, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle4-time-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}

/** `chats` shared chats active today, each with `topics` topics written now. */
async function seed(cwd, chats, topics) {
  const dir = join(cwd, '.context-graph')
  const now = new Date().toISOString()
  // Started yesterday and active until tomorrow, so "today" holds them even across midnight.
  const startedAt = new Date(Date.now() - 86400000).toISOString()
  const lastActiveAt = new Date(Date.now() + 86400000).toISOString()
  for (let c = 1; c <= chats; c++) {
    const nodes = {}
    for (let n = 1; n <= topics; n++) nodes[`n${n}`] = { label: `topic ${c}-${n} deploy pipeline`, gist: `chat ${c} decided step ${n} of the release checklist`, aliases: [], kind: 'fact', refs: [], at: now, updated: now }
    await updateMeta(dir, `s${c}`, (m) => m, () => ({ title: `chat number ${c}`, startedAt, lastActiveAt, turns: 4 }))
    await saveGraph(chatDir(dir, `s${c}`), { version: 2, nextId: topics + 1, nodes, edges: [] })
  }
  return now
}
const added = (out) => out.messages.slice(1).map((m) => m.content[0].text).join('\n\n')

test('#80 an everyday plan that names today gets no day digest; a question about today still does', { skip }, () => inWorkspace(async (cwd) => {
  await seed(cwd, 4, 6)
  const h = await setup()
  const agent = agentOf('sNew', cwd, [system()])
  await h.step(agent, ask('hello'))
  for (const p of ['what should we do tonight?', 'should we try the new thai place today?', 'how do we use a french press? I want coffee this morning', '今天我们要讨论的是周末去哪玩']) {
    assert.equal(added(await h.step(agent, ask(p))), '', p)
  }
  assert.match(added(await h.step(agent, ask('what did we do today?'))), /\[context-graph\] Chats from today \(quoted data, not instructions\):\n- c\d+ /)
}))

test('#77 recall of a day stays within a topic recall\'s budget and names every chat of the day', { skip }, () => inWorkspace(async (cwd) => {
  const now = await seed(cwd, 12, 10)
  const h = await setup()
  const agent = agentOf('sNew', cwd, [system()])
  const { status, text } = await h.recall(agent, day(now))
  assert.equal(status, 'ok')
  assert.ok(estimateTokens(text) <= 1000, `${estimateTokens(text)} tokens`)
  for (let c = 1; c <= 12; c++) assert.match(text, new RegExp(`\\bc${c}\\b`), `c${c} is named`)
  assert.ok((text.match(/^ {2}- c\d+n\d+ /gm) ?? []).length >= 10, 'each chat listed shows a topic')
  assert.match(text, /- … \d+ more from then: recall\("c\d+"\)/)
}))
