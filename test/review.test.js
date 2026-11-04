/**
 * Regression tests for the bugs found in the v0.6.0 review (GitHub issues #1-#7).
 * Uses a session that commits the messages a pre-step returns, like dsh's agent loop does.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/resolve-dsh.mjs --test test/review.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { shownContext, tailWithin } from '../graph.js'

const skip = !process.env.DSH_NODE_MODULES
const NO_UPDATES = { current: () => undefined }
const REPLY = JSON.stringify({ nodes: [{ id: null, label: 'commit signing', gist: 'signed with id_ed25519_signing', aliases: ['gpg'], kind: 'decision', msgs: [0] }], edges: [] })

const user = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const chat = (turns, reply = 'Noted, signing configured.') => [
  { type: 'system/message', data: {} },
  ...Array.from({ length: turns }, (_, i) => [user(`We decided to sign commits with the SSH key, step ${i}. `.repeat(4)), assistant(reply)]).flat()
]
const ask = (text) => ({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

/** A session whose log grows: `commit` appends what a pre-step decided to send. */
function liveSession(id, cwd, events) {
  const log = [...events]
  const surface = { nodes: log.map((_, i) => i), replaceGeneration: 0 }
  return {
    id, header: { id, cwd }, surface,
    eventAt: (seq) => log[seq],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    commit(messages) {
      for (const m of messages) { surface.nodes.push(log.push({ type: 'user/message', data: m }) - 1) }
    }
  }
}

function harness({ reply = REPLY, gate } = {}) {
  const listeners = {}
  const tools = []
  const commands = []
  const llm = {
    calls: 0,
    promptChars: 0,
    async *stream(options) {
      llm.calls++
      llm.promptChars = options.messages[0].content[0].text.length
      if (gate) await gate
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const ctx = {
    on: (event, fn) => { listeners[event] = fn },
    get: (service) => (service === 'llm' ? llm : undefined),
    tools: { register: (tool) => tools.push(tool) },
    plugin: (nested) => nested.apply({ effect: (gen) => { for (const _ of gen()); }, commands: { register: (c) => { commands.push(c); return () => {} } } })
  }
  return { ctx, listeners, tools, commands, llm }
}

async function setup(config = {}, h = harness()) {
  const { apply } = await import('../index.js')
  apply(h.ctx, { _updates: NO_UPDATES, ...config })
  const run = (agent, rawInput) => h.commands[0].handler({ rawInput, agent })
  const step = async (agent, decision) => {
    const out = await h.listeners['agent/pre-step']({ agent, messages: decision.messages }, async () => decision)
    agent.session.commit(out.messages)
    return out
  }
  return { ...h, run, step }
}

const agentOf = (sid, cwd, events) => ({ options: { cwd }, session: liveSession(sid, cwd, events), runMaintenance: (fn) => fn() })
const quietly = async (fn) => {
  const original = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = original }
}

test('#1 a fresh chat builds without running any command first', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const h = await setup()
    const agent = agentOf('sA', cwd, chat(4))
    const built = await h.run(agent, 'build')
    assert.equal(built.kind, 'success', built.text)
    h.listeners['agent/turn-stopping']({ agent, turn: 4 })
    await wait()
    assert.equal(h.llm.calls, 1, 'the same span is not sent to the model twice')
    const src = await readFile(join(cwd, '.context-graph/chats/sA/src/n1.md'), 'utf8')
    assert.equal(src.match(/^## /gm).length, 1, 'one copy of the source')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#2 the index position survives an app restart', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const events = chat(4)
    await (await setup()).run(agentOf('sB', cwd, events), 'build')
    const restarted = await setup()
    const agent = agentOf('sB', cwd, events)
    assert.match((await restarted.run(agent, '')).text, /· 0 turns waiting to be indexed/)
    restarted.listeners['agent/turn-stopping']({ agent, turn: 5 })
    await wait()
    assert.equal(restarted.llm.calls, 0)
    assert.equal((await readFile(join(cwd, '.context-graph/chats/sB/src/n1.md'), 'utf8')).match(/^## /gm).length, 1)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#3 a failed build waits for new turns before trying again', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const h = await setup({}, harness({ reply: 'not json' }))
    const agent = agentOf('sC', cwd, chat(4))
    assert.equal((await quietly(() => h.run(agent, 'build'))).kind, 'error')
    const before = h.llm.calls
    await quietly(async () => { for (let t = 5; t < 8; t++) { h.listeners['agent/turn-stopping']({ agent, turn: t }); await wait() } })
    assert.equal(h.llm.calls, before, 'no retry without new turns')
    assert.equal((await quietly(() => h.run(agent, 'build'))).kind, 'error', 'an explicit build still runs')
    assert.equal(h.llm.calls, before + 1)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#4 the first build of a long chat reads only its newest messages', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const h = await setup()
    const agent = agentOf('sG', cwd, chat(300, 'Noted, signing configured. '.repeat(90)))
    assert.equal((await h.run(agent, 'build')).kind, 'success')
    assert.ok(h.llm.promptChars < 70000, `builder prompt was ${h.llm.promptChars} chars`)
    assert.match((await h.run(agent, '')).text, /· 0 turns waiting/, 'the skipped older part is not retried later')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#5 a topic already sent to this chat is not sent again', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const h = await setup()
    await h.run(agentOf('sA', cwd, chat(1)), 'build')
    const b = agentOf('sB', cwd, [{ type: 'system/message', data: {} }])
    const first = await h.step(b, ask('gpg commit signing?'))
    assert.match(first.messages.at(-1).content[0].text, /c1n1 commit signing/)
    const again = await h.step(b, ask('gpg commit signing, again?'))
    assert.equal(again.messages.length, 1, 'nothing new to add')
    const today = await h.step(b, ask('what did we do today?'))
    assert.equal(today.messages.length, 1, 'a day list of topics already shown is not sent')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#6 recall and the on card say the right thing', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const h = await setup()
    const fresh = agentOf('sE', cwd, [{ type: 'system/message', data: {} }])
    const r = await h.tools[0].execute({ id: 'n1' }, { agent: fresh })
    assert.equal(r.status, 'unknown')
    assert.ok(!r.text.includes('undefined'), r.text)
    const on = await h.run(agentOf('sF', cwd, chat(1)), 'on')
    assert.ok(!/share lets other chats/.test(on.text), on.text)
    assert.match(on.text, /unshare keeps it private/)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('#7 off or unshare during a build is not undone when the build finishes', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const h = await setup({}, harness({ gate }))
    const agent = agentOf('sR', cwd, chat(4))
    await h.run(agent, 'share')
    const building = h.run(agent, 'build')
    await wait()
    await h.run(agent, 'unshare')
    await h.run(agent, 'off')
    release()
    assert.equal((await building).kind, 'success')
    const meta = JSON.parse(await readFile(join(cwd, '.context-graph/chats/sR/meta.json'), 'utf8'))
    assert.equal(meta.memoryOff, true)
    assert.equal(meta.private, true)
  } finally { await rm(cwd, { recursive: true, force: true }) }
})

test('shownContext reads ids and block texts from plugin messages only', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'c9n9 typed by the user' }] } },
    { type: 'user/message', data: { source: { kind: 'context-graph' }, content: [{ type: 'text', text: '- c1n1 a\n- c2n14 b' }] } }
  ]
  const shown = shownContext([0, 1], (seq) => events[seq])
  assert.deepEqual([...shown.ids], ['c1n1', 'c2n14'])
  assert.ok(shown.texts.has('- c1n1 a\n- c2n14 b'))
})

test('tailWithin keeps the newest messages that fit, and always the last one', () => {
  const m = (n) => ({ text: 'x'.repeat(n) })
  assert.equal(tailWithin([m(100), m(100), m(100)], 250).length, 2)
  assert.equal(tailWithin([m(100)], 10).length, 1)
  assert.equal(tailWithin([m(5000), m(5000)], 3000).length, 1, 'each message counts at most 2000')
  assert.deepEqual(tailWithin([], 100), [])
})

test('a time word with no topic match sends a small capped day list; recall gives the full day', { skip }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-review-'))
  try {
    const { saveMeta, saveGraph, chatDir } = await import('../store.js')
    const { estimateTokens, renderRange, parseTimeRange, day } = await import('../graph.js')
    const dir = join(cwd, '.context-graph')
    const now = new Date().toISOString()
    for (let c = 1; c <= 10; c++) {
      const nodes = {}
      for (let n = 1; n <= 10; n++) nodes[`n${n}`] = { label: `topic ${c}-${n} deploy pipeline`, gist: `chat ${c} decided step ${n} of the release checklist`, aliases: [], kind: 'fact', src: [], updated: now }
      await saveMeta(dir, `s${c}`, { cid: c, title: `chat number ${c}`, startedAt: now, lastActiveAt: now, turns: 4 })
      await saveGraph(chatDir(dir, `s${c}`), { version: 1, nextId: 11, nodes, edges: [] })
    }
    const h = await setup()
    const agent = agentOf('sNew', cwd, [{ type: 'system/message', data: {} }])
    await h.step(agent, ask('hello'))
    const out = await h.step(agent, ask('please fix this typo today'))
    const block = out.messages.at(-1).content[0].text
    assert.match(block, /^\[context-graph\] Chats from today:/)
    assert.equal((block.match(/^- c\d+ /gm) ?? []).length, 3, 'three chats')
    assert.equal((block.match(/^ {2}- c\d+n\d+ /gm) ?? []).length, 9, 'three topics each')
    assert.equal((block.match(/- \.\.\. 7 more topics: recall\("c\d+"\)/g) ?? []).length, 3)
    assert.match(block, /- \.\.\. 7 more chats \(c\d+(, c\d+){6}\): recall a chat id or a day/)
    const views = []
    for (let c = 1; c <= 10; c++) views.push({ sid: `s${c}`, cid: c, own: false, meta: { cid: c, title: `chat number ${c}`, startedAt: now, lastActiveAt: now }, graph: { nodes: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`n${i + 1}`, { label: `topic ${c}-${i + 1} deploy pipeline`, gist: `chat ${c} decided step ${i + 1} of the release checklist`, updated: now }])), edges: [] } })
    const before = estimateTokens(renderRange(views, parseTimeRange('today')))
    const after = estimateTokens(block)
    console.log(`day list: ~${before} tokens uncapped, ~${after} tokens capped`)
    assert.ok(after * 4 < before, `capped ${after} vs uncapped ${before}`)
    const full = await h.tools[0].execute({ id: day(now) }, { agent })
    assert.equal((full.text.match(/^- c\d+ /gm) ?? []).length, 10, 'recall by day lists every chat')
  } finally { await rm(cwd, { recursive: true, force: true }) }
})
