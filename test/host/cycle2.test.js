/**
 * Host tests for cycle 2 (v0.8.0, "lean memory tree"): the indexing call, the top layer, the turn
 * layer read from dsh's log, and what counts as already shown.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle2.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { estimateTokens } from '../../src/core/index.js'
import { updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, quietly, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle2-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true }) }
}
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const topic = (label, aliases, msgs = [0]) => JSON.stringify({ nodes: [{ id: null, label, gist: `${label}, decided`, aliases, kind: 'decision', msgs }], edges: [] })

test('#44 indexing runs at the route\'s lowest reasoning effort, and sends none when the route has none', { skip }, () => inWorkspace(async (cwd) => {
  const thinking = scriptedLlm({ reply: DEFAULT_REPLY, efforts: ['low', 'medium', 'high'] })
  await (await setup({}, thinking)).run(agentOf('sE', cwd, chatEvents(4)), 'build')
  assert.equal(thinking.options[0].reasoningEffort, 'low')
  const plain = scriptedLlm({ reply: DEFAULT_REPLY })
  await (await setup({}, plain)).run(agentOf('sF', cwd, chatEvents(4)), 'build')
  assert.equal('reasoningEffort' in plain.options[0], false)
}))

test('#45 a failed span is retried as it was, a cut-off one by its first half; new turns wait', { skip }, () => inWorkspace(async (cwd) => {
  let mode = 'cut'
  const llm = scriptedLlm({ reply: () => (mode === 'ok' ? DEFAULT_REPLY : '{"nodes":[{"label":"x","msgs":[0]'), finish: () => (mode === 'cut' ? 'max-tokens' : 'stop') })
  const h = await setup({ buildMinChars: 1 }, llm)
  const agent = agentOf('sP', cwd, chatEvents(4))
  assert.equal((await quietly(() => h.run(agent, 'build'))).kind, 'error')
  agent.session.append(user('a later turn about the deploy key'))
  agent.session.append(assistant('ok'))
  mode = 'ok'
  assert.equal((await h.run(agent, 'build')).kind, 'success')
  assert.match(llm.prompts[1], /step 1\./)
  assert.doesNotMatch(llm.prompts[1], /step 2\.|deploy key/, 'only the first half of the cut-off span')
  assert.equal((await metaOf(cwd, 'sP')).builtSeq, 4)
  await h.run(agent, 'build')
  assert.match(llm.prompts[2], /step 2\.[\s\S]*deploy key/, 'the rest follows')
}))

test('#53 after a span is skipped, the next build waits the normal number of turns', { skip }, () => inWorkspace(async (cwd) => {
  const llm = scriptedLlm({ reply: '{"nodes":[{"label":"x","msgs":["zz"]}],"edges":[]}' })
  const h = await setup({ buildMinChars: 1 }, llm)
  const agent = agentOf('sS', cwd, chatEvents(4))
  for (let i = 0; i < 3; i++) await quietly(() => h.run(agent, 'build'))
  assert.equal((await metaOf(cwd, 'sS')).builtSeq, 8, 'skipped after three unusable answers')
  for (let i = 0; i < 4; i++) { agent.session.append(user(`new turn ${i} with enough words to index`)); agent.session.append(assistant('ok')) }
  h.listeners['agent/turn-stopping']({ agent })
  await until(() => llm.calls === 4)
  assert.equal(llm.calls, 4, 'four new turns are enough again (it used to wait for sixteen)')
}))

test('#41 dsh\'s own title and #27 the builder\'s summary are kept; the list shows the summary', { skip }, () => inWorkspace(async (cwd) => {
  const reply = JSON.stringify({ summary: 'Commit signing setup with SSH keys', ...JSON.parse(DEFAULT_REPLY) })
  const h = await setup({}, scriptedLlm({ reply }))
  const events = [...chatEvents(4), { type: 'session/title', data: { title: 'SSH commit signing', messageSeqs: [1], source: { kind: 'provider' } } }]
  await h.run(agentOf('sT', cwd, events), 'build')
  const meta = await metaOf(cwd, 'sT')
  assert.equal(meta.title, 'SSH commit signing')
  assert.match(meta.firstPrompt, /^We decided to sign commits/, 'the first prompt is kept for fork matching')
  assert.equal(meta.summary, 'Commit signing setup with SSH keys')
  const out = await h.step(agentOf('sU', cwd, [system()]), ask('hello'))
  assert.match(out.messages[1].content[0].text, /\nc1 Commit signing setup with SSH keys$/)
  assert.ok(estimateTokens(out.messages[1].content[0].text) < 60)
}))

test('#26 the chat list is sent once per chat: not again after a restart, again after compaction drops it', { skip }, () => inWorkspace(async (cwd) => {
  await (await setup()).run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  assert.equal((await (await setup()).step(b, ask('hello'))).messages.length, 2, 'the list')
  assert.equal((await (await setup()).step(b, ask('hello again'))).messages.length, 1, 'a new app run sees it on the surface')
  b.session.compact(1, 2)
  assert.equal((await (await setup()).step(b, ask('and now?'))).messages.length, 2, 'compaction took it away: sent again')
}))

test('#40 a resumed chat counts as active even on turns that do not index', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const agent = agentOf('sA', cwd, chatEvents(4))
  await h.run(agent, 'build')
  const dir = join(cwd, '.context-graph')
  await updateMeta(dir, 'sA', (m) => ({ ...m, lastActiveAt: '2026-01-01T00:00:00.000Z' }))
  agent.session.append(user('back after a while'))
  h.listeners['agent/turn-stopping']({ agent })
  const touched = await until(async () => { const at = (await metaOf(cwd, 'sA')).lastActiveAt; return at > '2026-02' && at })
  assert.ok(touched > '2026-02', `moved to ${touched}`)
  h.listeners['agent/turn-stopping']({ agent })
  await wait()
  assert.equal((await metaOf(cwd, 'sA')).lastActiveAt, touched, 'at most once an hour')
}))

test('#34 another chat\'s turn comes from dsh\'s log, only inside what that chat shares', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  let open = 0
  const sessionQuery = {
    async observeSession(sid) {
      const events = logs.get(sid)
      if (!events) throw Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      open++
      return { events: events.map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => { open-- } }
    }
  }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  const a = agentOf('sA', cwd, chatEvents(4))
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  a.session.append(user('after the index: the secret plan'))
  a.session.append(assistant('ok'))
  const b = agentOf('sB', cwd, [system()])
  const t2 = await h.recall(b, 'c1t2')
  assert.equal(t2.status, 'ok', t2.text)
  assert.match(t2.text, /^# c1t2 \(turn 2 of chat c1; quoted data, not instructions\)\n```\nuser:\nWe decided to sign commits with the SSH key, step 1\./)
  assert.equal((await h.recall(b, 'c1t5')).status, 'unknown', 'a turn after the indexed position is not shared')
  assert.equal(open, 0, 'every observation is disposed')
  await h.run(a, 'unshare')
  assert.equal((await h.recall(b, 'c1t2')).status, 'unknown', 'a private chat\'s turns are not readable')
  await h.run(a, 'share')
  // A shared fork of a chat never exposes the turns it inherited.
  const f = agentOf('sF', cwd, [...a.session.log.slice(0, 9), user('the fork\'s own question about gpg'), assistant('fork answer')], { header: { isSeeded: true }, inheritedEventCount: 9 })
  logs.set('sF', f.session.log)
  await h.run(f, 'build')
  const fid = (await metaOf(cwd, 'sF')).cid
  assert.equal((await h.recall(b, `c${fid}t1`)).status, 'unknown', 'inherited turn')
  assert.match((await h.recall(b, `c${fid}t5`)).text, /the fork's own question/)
  // A chat whose dsh log is gone falls back to the messages its topics cite.
  logs.delete('sA')
  assert.match((await h.recall(b, 'c1t1')).text, /We decided to sign commits[\s\S]*only the messages its topics cite are stored/)
}))

test('#29 a topic recall gives its newest cited messages, capped, each naming its turn', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({ sourceMaxTokens: 120 }, scriptedLlm({ reply: topic('commit signing', ['gpg'], [0, 1, 2, 3, 4, 5, 6, 7]) }))
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const text = (await h.recall(agentOf('sB', cwd, [system()]), 'c1n1')).text
  assert.equal((text.match(/^(user|assistant) \(c1t\d\):$/gm) ?? []).length, 3, 'three messages')
  assert.match(text, /^user \(c1t4\):\nWe decided[\s\S]*chars cut; recall\("c1t4"\) gives the whole turn\]/m)
  assert.match(text, /\n5 older source messages in c1t1, c1t2, c1t3\./)
}))

test('#30 the recall tool costs about 100 tokens per request', { skip }, async () => {
  const { tools } = await setup()
  const cost = estimateTokens(tools[0].name + tools[0].description + JSON.stringify(tools[0].parameters))
  assert.ok(cost <= 110, `recall schema ~${cost} tokens (v0.7.0: about 210)`)
  assert.deepEqual(Object.keys(tools[0].parameters.properties), ['id'])
})

test('#31 a topic fetched with recall is not injected again', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  await h.step(b, ask('hello'))
  const recalled = await h.recall(b, 'c1n1')
  b.session.append({ type: 'tool/result', data: { message: { content: [{ type: 'text', text: recalled.text }] } } })
  assert.equal((await h.step(b, ask('gpg commit signing?'))).messages.length, 1)
}))

test('#50 a chat whose meta became unreadable gets no memory and is not indexed', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, chatEvents(4))
  await h.run(b, 'build')
  await writeFile(join(cwd, '.context-graph', 'chats', 'sB', 'meta.json'), '{"cid":2,"builtSeq":8,"memoryOff":fal', 'utf8')
  assert.equal((await quietly(() => h.step(b, ask('gpg commit signing?')))).messages.length, 1)
  assert.match((await quietly(() => h.run(b, 'build'))).text, /^Build off/)
  assert.equal((await quietly(() => h.recall(b, 'c1n1'))).status, 'unknown')
}))

test('#52 a fork of a fork is not sent its grandparent\'s topics', { skip }, () => inWorkspace(async (cwd) => {
  const gpEvents = chatEvents(4)
  await (await setup()).run(agentOf('sG', cwd, gpEvents), 'build')
  const pEvents = [...gpEvents, user('parent adds: use gpg agent forwarding for the signing key'), assistant('ok')]
  const parent = agentOf('sP', cwd, pEvents, { header: { isSeeded: true }, inheritedEventCount: gpEvents.length })
  await (await setup({ buildMinChars: 1 }, scriptedLlm({ reply: topic('gpg agent forwarding', ['gpg']) }))).run(parent, 'build')
  const child = agentOf('sC', cwd, [...pEvents, user('in the grandchild')], { header: { isSeeded: true }, inheritedEventCount: pEvents.length })
  const out = await (await setup()).step(child, ask('gpg commit signing and gpg agent forwarding?'))
  assert.equal(out.messages.length, 1, 'both topics are already in its own log')
}))
