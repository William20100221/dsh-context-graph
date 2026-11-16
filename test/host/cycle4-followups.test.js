/**
 * Host tests for the follow-ups found while merging the cycle-4 (v0.10.0) work: a late answer
 * holds a waiting `on`, `on` whose build finds the chat busy, and the day digest's token budget.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-followups.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { estimateTokens } from '../../src/core/text.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4f-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}

test('a late answer to a question, still queued when on runs, holds the on like a typed message (#70, #59)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ buildMinChars: 1 })
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  await h.run(a, 'off')
  a.inbox = { nextTurn: [], nextStep: [{ source: { kind: 'user-question-reply' } }] }
  assert.match((await h.run(a, 'on')).text, /^Memory on when this turn ends/)
}))

test('an on whose own build finds the chat busy leaves the turn to the next turn end (#65)', { skip }, () => inWorkspace(async (cwd) => {
  let current = Promise.resolve()
  let release
  const gate = { then: (resolve, reject) => current.then(resolve, reject) }
  const llm = scriptedLlm({ reply: DEFAULT_REPLY, gate })
  const h = await setup({ buildMinChars: 1 }, llm)
  const a = agentOf('sA', cwd, chatEvents(4))
  await h.run(a, 'build')
  a.session.append(user('second: the deploy key is rotated yearly'))
  a.session.append(assistant('noted'))
  current = new Promise((resolve) => { release = resolve })
  const building = h.run(a, 'build')
  await until(() => llm.calls === 2)
  await h.run(a, 'on')
  release()
  await building
  // One more turn: too few for an ordinary turn-end build, so only the kept turn end indexes it.
  a.session.append(user('third: we tag releases on Fridays'))
  a.session.append(assistant('ok'))
  await until(async () => { h.listeners['agent/turn-stopping']({ agent: a }); await wait(30); return llm.prompts.some((p) => p.includes('tag releases on Fridays')) })
}))

test('the day digest stays within a recall\'s token budget, also with long Chinese gists (#77)', { skip }, () => inWorkspace(async (cwd) => {
  const gist = '这是一个很长的中文说明，讲述了数据库迁移的每一个步骤以及相关的注意事项。'.repeat(8)
  const reply = JSON.stringify({ nodes: Array.from({ length: 4 }, (_, i) => ({ label: `迁移步骤${'甲乙丙丁'[i]}`, gist, aliases: [], kind: 'fact', msgs: [0] })), edges: [] })
  const h = await setup({ buildMinChars: 1 }, scriptedLlm({ reply }))
  for (const sid of ['sA', 'sB', 'sC']) await h.run(agentOf(sid, cwd, chatEvents(4)), 'build')
  const out = await h.step(agentOf('sZ', cwd, [system()]), ask('我们今天讨论了什么？'))
  assert.equal(out.messages.length, 2, 'a digest was sent')
  const block = out.messages[1].content[0].text
  assert.match(block, /迁移步骤/)
  assert.ok(estimateTokens(block) <= 1000 + 150, `about ${estimateTokens(block)} tokens`)
}))
