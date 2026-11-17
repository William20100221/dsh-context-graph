/**
 * Review of cycle 4 (v0.10.0): the day digest through the plugin (K4, K5, K8 of the review).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-review-digest.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { chatDir, saveGraph, updateMeta } from '../../src/store/chats.js'
import { agentOf, ask, setup, skip, system } from '../helpers/harness.js'

/** Three shared chats active from yesterday to tomorrow, so "yesterday" holds them at any hour. */
async function seed(cwd) {
  const dir = join(cwd, '.context-graph')
  const now = new Date().toISOString()
  const startedAt = new Date(Date.now() - 86400000).toISOString()
  const lastActiveAt = new Date(Date.now() + 86400000).toISOString()
  for (let c = 1; c <= 3; c++) {
    const nodes = {}
    for (let n = 1; n <= 3; n++) nodes[`n${n}`] = { label: `topic ${c}-${n} deploy pipeline`, gist: `chat ${c} decided step ${n} of the release checklist`, aliases: [], kind: 'fact', refs: [], at: now, updated: now }
    await updateMeta(dir, `s${c}`, (m) => m, () => ({ title: `chat number ${c}`, startedAt, lastActiveAt, turns: 4 }))
    await saveGraph(chatDir(dir, `s${c}`), { version: 2, nextId: 4, nodes, edges: [] })
  }
}
const added = (out) => out.messages.slice(1).map((m) => m.content[0].text).join('\n\n')
const STORY = 'the restaurant we tried last night was amazing, find me a similar one'
const FRONTEND = '这两天前端一直报错，之前我们说的方案是什么？'

test('review K4 K5 K8: a story or 前端 gets no day digest; a question about another 会话 gets one, list included', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4-review-'))
  try {
    await seed(cwd)
    const h = await setup()
    // As a chat's first message.
    assert.equal(added(await h.step(agentOf('sStory', cwd, [system()]), ask(STORY))), '', STORY)
    assert.doesNotMatch(added(await h.step(agentOf('sFrontend', cwd, [system()]), ask(FRONTEND))), /Chats from|No indexed chats/, FRONTEND)
    const first = added(await h.step(agentOf('sZh', cwd, [system()]), ask('昨天我们在另一个会话里聊的内容是什么')))
    assert.match(first, /Earlier chats in this workspace/)
    assert.match(first, /\[context-graph\] Chats from yesterday \(quoted data, not instructions\):\n- c\d+ /)
    // Later in a chat.
    const agent = agentOf('sLater', cwd, [system()])
    await h.step(agent, ask('hello'))
    for (const p of [STORY, FRONTEND]) assert.equal(added(await h.step(agent, ask(p))), '', p)
    assert.match(added(await h.step(agent, ask('我们昨天在那个会话里说的方案是哪个'))), /^\[context-graph\] Chats from yesterday /)
    // The day talked about, not the launch date talked about.
    const launch = added(await h.step(agent, ask('what did we decide about the may 1 launch last week?')))
    assert.match(launch, /^\[context-graph\] (?:Chats|No indexed chats) from last week\b/)
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 5 })
  }
})
