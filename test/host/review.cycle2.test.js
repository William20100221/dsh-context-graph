/**
 * Host regression tests for the independent review of the cycle-2 (v0.8.0) change. Each test fails
 * on the code the review was run against (checked by breaking each fix in turn).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/review.cycle2.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { day, estimateTokens } from '../../src/core/index.js'
import { chatDir, saveGraph, updateMeta } from '../../src/store/chats.js'
import { saveMessages } from '../../src/store/messages.js'
import { corpusViews } from '../fixtures/relevance-corpus.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review2-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const topic = (label, aliases, msgs = [0], gist = `${label}, decided`) => JSON.stringify({ nodes: [{ id: null, label, gist, aliases, kind: 'decision', msgs }], edges: [] })
const turn = (prompt, answer) => [{ type: 'turn/start' }, user(prompt), assistant(answer), { type: 'turn/end' }]

/** Corpus chats written to a workspace the way the builder would have stored them. */
async function writeCorpus(cwd, cids) {
  const dir = join(cwd, '.context-graph')
  const { views, messages } = corpusViews()
  for (const view of views.filter((v) => cids.includes(v.cid))) {
    await updateMeta(dir, view.sid, (m) => ({ ...m, cid: view.cid }), () => ({ title: view.meta.title, startedAt: view.meta.startedAt, lastActiveAt: view.meta.lastActiveAt }))
    await saveGraph(chatDir(dir, view.sid), view.graph)
    await saveMessages(chatDir(dir, view.sid), Object.entries(messages[view.sid]).map(([seq, m]) => ({ seq: Number(seq), role: m.r, turn: m.t, time: m.a, text: m.x })))
  }
}

test('a nested subagent follows the chat that started the task, however deep (review)', { skip }, () => inWorkspace(async (cwd) => {
  const agents = new Map()
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { agents: { get: (id) => agents.get(id) } })
  await h.run(agentOf('sX', cwd, chatEvents(4)), 'build')
  const starter = agentOf('sS', cwd, [system(), user('start a task')])
  const a = agentOf('sA', cwd, [system()], { header: { origin: 'subagent', parentSession: 'sS', delegationDepth: 1 } })
  const b = agentOf('sB', cwd, [system()], { header: { origin: 'subagent', parentSession: 'sA', delegationDepth: 2 } })
  for (const agent of [starter, a, b]) agents.set(agent.session.id, agent)
  assert.equal((await h.recall(b, 'c1n1')).status, 'ok', 'memory on: the nested subagent may recall')
  await h.run(starter, 'off')
  assert.equal((await h.recall(a, 'c1n1')).status, 'unknown')
  assert.equal((await h.recall(b, 'c1n1')).status, 'unknown', 'memory off holds two levels down')
  agents.clear()
  assert.equal((await h.recall(b, 'c1n1')).status, 'unknown', 'a chain that cannot be followed fails closed')
}))

test('recall finds a shared chat even when a private chat has the same number (review)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const h = await setup({}, scriptedLlm({ reply: topic('gpg commit signing', ['gpg']) }))
  await h.run(agentOf('sOld', cwd, chatEvents(4)), 'build')
  await updateMeta(dir, 'sNew', (m) => ({ ...m, cid: 1, private: true, lastActiveAt: '2099-01-01T00:00:00.000Z' }), () => ({ title: 'newer private chat' }))
  assert.equal((await h.recall(agentOf('sR', cwd, [system()]), 'c1n1')).status, 'ok')
}))

test('a build never moves the index past what it read, whatever a failed build pinned (review of #45)', { skip }, () => inWorkspace(async (cwd) => {
  let fail = true
  const llm = scriptedLlm({ reply: () => { if (fail) throw new Error('network down'); return DEFAULT_REPLY } })
  const h = await setup({ buildMinChars: 1 }, llm)
  const events = [system(), ...[1, 2, 3, 4].flatMap((i) => turn(`turn ${i} question`, `turn ${i} answer`)), { type: 'turn/start' }, user('THE REAL DECISION X5'), assistant('working on it')]
  const agent = agentOf('sP', cwd, events)
  const x5 = events.findIndex((e) => e.data?.content?.[0]?.text === 'THE REAL DECISION X5')
  await quietly(async () => { h.listeners['agent/turn-stopping']({ agent }); await until(() => llm.calls === 1) })
  fail = false
  // The failed background build may still be closing: retry while it says busy.
  await until(async () => (await h.run(agent, 'build')).kind === 'success')
  assert.ok((await metaOf(cwd, 'sP')).builtSeq < x5, 'the running turn was not read, so it is not marked indexed')
  assert.match((await h.run(agent, '')).text, /· 1 turn waiting/)
}))

test('a fork whose meta has no fork point still never exposes inherited turns (review of #34)', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const sessionQuery = {
    async observeSession(sid) {
      const entry = logs.get(sid)
      if (!entry) throw new Error('not found')
      return { header: entry.header, inheritedEventCount: entry.inherited, events: entry.log.map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} }
    }
  }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  const parent = agentOf('sP', cwd, chatEvents(4))
  await h.run(parent, 'build')
  await h.run(parent, 'unshare')
  // Written as a plain chat, the way v0.4-v0.6 wrote forks: no forkSeq in its meta.
  const fork = agentOf('sF', cwd, [...parent.session.log, user('the fork asks about deploys'), assistant('ok')])
  await h.run(fork, 'build')
  assert.equal((await metaOf(cwd, 'sF')).forkSeq, undefined)
  logs.set('sF', { log: fork.session.log, header: { isSeeded: true }, inherited: 9 })
  const reader = agentOf('sR', cwd, [system()])
  const cid = (await metaOf(cwd, 'sF')).cid
  assert.equal((await h.recall(reader, `c${cid}t1`)).status, 'unknown', 'dsh says turn 1 was inherited')
  assert.match((await h.recall(reader, `c${cid}t5`)).text, /the fork asks about deploys/)
}))

test('a turn recalled from stored messages keeps the turn budget (review of #47)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({}, scriptedLlm({ reply: topic('deploy checklist', ['deploy'], [0, 1, 2, 3]) }))
  const long = (c) => `${c} `.repeat(2000)
  await h.run(agentOf('sA', cwd, [system(), user(long('prompt')), assistant(long('step')), assistant(long('more')), assistant(long('final')), ...chatEvents(3).slice(1)]), 'build')
  const recalled = await h.recall(agentOf('sB', cwd, [system()]), 'c1t1')
  assert.equal(recalled.status, 'ok')
  assert.ok(estimateTokens(recalled.text) <= 2100, `${estimateTokens(recalled.text)} tokens without dsh's log`)
}))

test('a fork still gets an unrelated chat that only shares its first prompt (review of #52)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }))
  const parentEvents = chatEvents(4)
  await h.run(agentOf('sP', cwd, parentEvents), 'build')
  // Same first prompt as the parent, then its own text; its topic cites that later message (seq 3).
  const other = [...parentEvents.slice(0, 3), user('We rotate the deploy key every 90 days, decided today.'), assistant('ok'), ...parentEvents.slice(5)]
  // msgs [2] is the span's third message: seq 3, the text the fork does not have.
  await (await setup({}, scriptedLlm({ reply: topic('deploy key rotation', ['deploy key'], [2]) }))).run(agentOf('sU', cwd, other), 'build')
  const fork = agentOf('sF', cwd, [...parentEvents, user('in the fork')], { header: { isSeeded: true }, inheritedEventCount: parentEvents.length })
  const out = await h.step(fork, ask('what is the deploy key rotation schedule?'))
  const text = out.messages.at(-1).content[0].text
  assert.match(text, /- c2n1 deploy key rotation/, 'its topic is not in the fork')
  // A fork is not on its first turn (it inherited answers), so it gets no chat list.
  assert.doesNotMatch(text, /Earlier chats/)
}))

test('the inline budget is in tokens: a short Chinese source is listed, a short English one inlined (review of #39)', { skip }, () => inWorkspace(async (cwd) => {
  await writeCorpus(cwd, [1, 3])
  const h = await setup()
  const chat = agentOf('sN', cwd, [system()])
  await h.step(chat, ask('hello'))
  chat.session.append(assistant('hi'))
  const zh = (await h.step(chat, ask('暗色模式是怎么切换的'))).messages.at(-1).content[0].text
  assert.match(zh, /- c3n9 暗色模式实现/)
  assert.doesNotMatch(zh, /Source of/, '500 Chinese characters are about 500 tokens: over the 300-token budget')
  const en = (await h.step(chat, ask('do we cancel in-progress workflow runs on PRs'))).messages.at(-1).content[0].text
  assert.match(en, /Source of c1n9:/)
}))

test('#45 three failures skip only the failed span; turns that arrived meanwhile are indexed next (review)', { skip }, () => inWorkspace(async (cwd) => {
  const broken = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: '{"nodes":[{"label":"x","msgs":["zz"]}],"edges":[]}' }))
  const agent = agentOf('sS', cwd, chatEvents(4))
  for (let i = 0; i < 3; i++) {
    await quietly(() => broken.run(agent, 'build'))
    if (i < 2) for (const k of [0, 1]) { agent.session.append(user(`later turn ${i}-${k} about the release branch`)); agent.session.append(assistant('ok')) }
  }
  assert.equal((await metaOf(cwd, 'sS')).builtSeq, 8, 'only the failed span is skipped')
  const good = await setup({ buildMinChars: 1 })
  assert.equal((await good.run(agent, 'build')).kind, 'success')
  assert.match(good.llm.prompts[0], /later turn 0-0[\s\S]*later turn 1-1/)
}))

test('#38 a day digest lists only chats that have topics (review)', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  await h.run(agentOf('sQ', cwd, [system(), user('quick question')]), 'unshare')
  await h.run(agentOf('sQ', cwd, [system(), user('quick question')]), 'share')
  const text = (await h.recall(agentOf('sB', cwd, [system()]), day(new Date().toISOString()))).text
  assert.match(text, /\n- c1 /)
  assert.doesNotMatch(text, /\n- c2 /, 'the chat without topics is not listed')
}))

test('/context-graph find lists same-label topics from different chats separately (review of #43)', { skip }, () => inWorkspace(async (cwd) => {
  await (await setup({}, scriptedLlm({ reply: topic('Deploy process', ['deploy'], [0], 'deploys to fly.io') }))).run(agentOf('sA', cwd, chatEvents(4)), 'build')
  await (await setup({}, scriptedLlm({ reply: topic('Deploy process', ['deploy'], [0], 'deploys to kubernetes via helm upgrade') }))).run(agentOf('sB', cwd, chatEvents(4)), 'build')
  const found = await (await setup()).run(agentOf('sC', cwd, [system()]), 'find deploy process')
  assert.match(found.text, /^2 matching topics\n/)
}))

test('a v0.7 config block still applies: inlineMaxChars 0 and surfaceMaxChats 1 (review)', { skip }, () => inWorkspace(async (cwd) => {
  await writeCorpus(cwd, [1, 2])
  const h = await setup({ inlineMaxChars: 0, surfaceMaxChats: 1 })
  const chat = agentOf('sN', cwd, [system()])
  const first = (await h.step(chat, ask('do we cancel in-progress workflow runs on PRs'))).messages.at(-1).content[0].text
  assert.equal((first.match(/^c\d+ /gm) ?? []).length, 1, 'one chat line')
  assert.match(first, /… 1 more;/)
  assert.doesNotMatch(first, /Source of/, 'inlining stays off')
}))
