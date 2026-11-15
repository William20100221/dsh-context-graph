/**
 * Host regression tests for findings of the cycle-1 review of the v0.7.0 diff.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/review.cycle1.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review1-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))

test('an honest empty answer advances the index; three unusable answers in a row skip the span', { skip }, () => inWorkspace(async (cwd) => {
  const empty = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: '{"nodes":[],"edges":[]}' }))
  const quiet = agentOf('sQ', cwd, chatEvents(4))
  assert.equal((await empty.run(quiet, 'build')).kind, 'success', 'nothing worth remembering is not a failure')
  assert.equal((await metaOf(cwd, 'sQ')).builtSeq, 8)
  const broken = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: '{"nodes":[{"label":"x","msgs":["zz"]}],"edges":[]}' }))
  const agent = agentOf('sR', cwd, chatEvents(4))
  for (let i = 1; i <= 2; i++) {
    assert.equal((await quietly(() => broken.run(agent, 'build'))).kind, 'error')
    assert.equal((await metaOf(cwd, 'sR')).builtSeq, undefined, `attempt ${i}: still unindexed, to be retried`)
  }
  const third = await quietly(() => broken.run(agent, 'build'))
  assert.match(third.text, /skipped these turns after 3 unusable answers/)
  assert.equal((await metaOf(cwd, 'sR')).builtSeq, 8, 'the span is no longer re-sent')
  assert.match((await broken.run(agent, '')).text, /\nLast index failed at \d\d:\d\d UTC: /)
}))

test('a fork without a parent id in its header is still recognised, and only inherited topics are held back', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const parentEvents = chatEvents(4)
  const parent = agentOf('sP', cwd, parentEvents)
  await h.run(parent, 'build')
  const fork = agentOf('sF2', cwd, [...parentEvents, user('in the fork: what about gpg signing?')], { header: { isSeeded: true }, inheritedEventCount: parentEvents.length })
  const out = await h.step(fork, ask('gpg commit signing again?'))
  assert.equal(out.messages.length, 1, 'parent found by title; its inherited topic and the parent itself are not sent')
  h.listeners['agent/turn-stopping']({ agent: fork })
  await wait()
  assert.equal((await metaOf(cwd, 'sF2')).builtSeq, parentEvents.length - 1, 'the inherited history is not re-indexed')
  // The parent later indexes a turn that came after the fork point: that topic is new to the fork.
  const laterReply = JSON.stringify({ nodes: [{ label: 'gpg key rotation', gist: 'rotate the gpg key yearly', aliases: ['gpg'], kind: 'decision', msgs: [0] }], edges: [] })
  const h2 = await setup({}, scriptedLlm({ reply: laterReply }))
  parent.session.append(user('new in the parent after the fork: rotate the gpg key yearly'))
  parent.session.append(assistant('ok'))
  await h2.run(parent, 'build')
  const again = await h2.step(fork, ask('gpg key, anything new?'))
  const block = again.messages.at(-1).content[0].text
  assert.match(block, /gpg key rotation/, 'a topic citing post-fork messages is sent')
  assert.doesNotMatch(block, /commit signing/, 'the inherited one still is not')
}))

test('a subagent can recall shared topics unless the chat that started it has memory off', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(1)), 'build')
  const starter = agentOf('sS', cwd, [system(), user('start a task')])
  await h.run(starter, 'on')
  await wait()
  const sub = agentOf('sSub', cwd, [system()], { header: { origin: 'subagent', parentSession: 'sS' } })
  assert.equal((await h.recall(sub, 'c1n1')).status, 'ok')
  await h.run(starter, 'off')
  const denied = await h.recall(sub, 'c1n1')
  assert.equal(denied.status, 'unknown')
  assert.match(denied.text, /chat that started this task/)
}))

test('a command build mid-turn indexes only finished turns, so a question is never split from its answer', { skip }, () => inWorkspace(async (cwd) => {
  const prompts = []
  const llm = scriptedLlm({ reply: (options) => { prompts.push(options.messages[0].content[0].text); return '{"nodes":[{"label":"x","msgs":[0]}],"edges":[]}' } })
  const h = await setup({ buildMinChars: 1 }, llm)
  const events = [system(), { type: 'turn/start' }, user('first question'), assistant('first answer'), { type: 'turn/end' }, { type: 'turn/start' }, user('Which port should the API use?'), assistant('Let me check the config first.')]
  const agent = agentOf('sT', cwd, events)
  assert.equal((await h.run(agent, 'build')).kind, 'success')
  assert.doesNotMatch(prompts[0], /Which port/, 'the running turn is left for later')
  assert.equal((await metaOf(cwd, 'sT')).builtSeq, 4)
  agent.session.append(assistant('Decision: the API listens on port 8443.'))
  agent.session.append({ type: 'turn/end' })
  await h.run(agent, 'build')
  assert.match(prompts[1], /\[m0 user\]\nWhich port should the API use\?[\s\S]*Decision: the API listens on port 8443/, 'question and answer are indexed together')
}))
