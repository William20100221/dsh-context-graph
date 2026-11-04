/**
 * Wiring check of index.js against a fake harness: memory on by default, /context-graph off + on + share,
 * injection into a second chat, recall by topic / chat / day / turn, and the meter. Needs the dsh peer packages:
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/resolve-dsh.mjs --test test/plugin.test.js
 * Skipped when DSH_NODE_MODULES is unset.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { day } from '../graph.js'

const skip = !process.env.DSH_NODE_MODULES
const NO_UPDATES = { current: () => undefined }
const USAGE = '[on|off|share|unshare|stats|build|map|find <words>]'

const BUILDER_REPLY = JSON.stringify({
  nodes: [{ id: null, label: 'commit signing', gist: 'commits are signed with the SSH key id_ed25519_signing', aliases: ['gpg', 'signed commits', '签名'], kind: 'decision', msgs: [0, 1] }],
  edges: []
})

function fakeLlm(reply) {
  const calls = []
  return {
    calls,
    async *stream(options) {
      calls.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'usage', usage: { inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 50 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
}

function fakeSession(id, cwd, events) {
  return {
    id,
    header: { id, cwd },
    surface: { nodes: events.map((_, i) => i), replaceGeneration: 0 },
    eventAt: (seq) => events[seq],
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } })
  }
}

const user = (text) => ({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
const ask = (text) => ({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] })

function fakeCtx(llm) {
  const listeners = {}
  const registered = []
  const commands = []
  const ctx = {
    listeners, registered, commands,
    on: (event, fn) => { listeners[event] = fn },
    get: (service) => (service === 'llm' ? llm : undefined),
    tools: { register: (tool) => registered.push(tool) },
    plugin: (nested) => nested.apply({
      effect: (gen) => { for (const _ of gen()) { /* registrations only */ } },
      commands: { register: (command) => { commands.push(command); return () => {} } }
    })
  }
  return ctx
}

test('plugin: on by default; off/on + share; a second chat gets the list, hits, time slices and recall', { skip }, async () => {
  const { apply } = await import('../index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'context-graph-plugin-'))
  try {
    const llm = fakeLlm(BUILDER_REPLY)
    const ctx = fakeCtx(llm)
    apply(ctx, { _updates: NO_UPDATES, buildEveryTurns: 1, buildMinChars: 1 })
    assert.ok(ctx.listeners['agent/pre-step'] && ctx.listeners['agent/turn-stopping'] && ctx.listeners['llm/stream'])
    assert.equal(ctx.registered[0].name, 'recall')
    assert.equal(ctx.commands[0].name, 'context-graph')
    assert.equal(ctx.commands[0].input?.hint, USAGE, 'declares arguments so clients pass them through')
    const run = (agent, rawInput) => ctx.commands[0].handler({ rawInput, agent })
    const step = (agent, decision) => ctx.listeners['agent/pre-step']({ agent, messages: decision.messages }, async () => decision)

    // Chat A: memory is on with no command; off stops building, on resumes.
    const sessionA = fakeSession('sA', cwd, [
      { type: 'system/message', data: {} },
      user('We decided to sign commits with the SSH key id_ed25519_signing'),
      assistant('Noted: commit signing uses that SSH key.')
    ])
    const agentA = { options: { cwd }, session: sessionA, runMaintenance: (fn) => fn() }
    assert.match((await run(agentA, '')).text, /^Memory on · 0 topics in this chat · shared · 0 shared chats · 1 turns waiting/)
    assert.equal((await step(agentA, ask('how do we sign commits?'))).messages.length, 1, 'empty graph injects nothing')
    assert.match((await run(agentA, 'off')).text, /^Memory off for this chat[\s\S]*Plugins page/)
    assert.equal((await run(agentA, 'build')).kind, 'error', 'off chats do not build')
    assert.equal(llm.calls.length, 0)

    // /context-graph on resumes and indexes right away.
    const on = await run(agentA, 'on')
    assert.equal(on.kind, 'success', on.text)
    assert.match(on.text, /^Memory on · 1 topics in this chat · 0 shared chats to draw on/)
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].purpose, 'context-graph')
    assert.equal(llm.calls[0].model, 'deepseek-chat')
    assert.match(llm.calls[0].messages[0].content[0].text, /\[m0 user\]\nWe decided to sign commits/)
    const chatA = join(cwd, '.context-graph', 'chats', 'sA')
    assert.equal(JSON.parse(await readFile(join(chatA, 'graph.json'), 'utf8')).nodes.n1.label, 'commit signing')
    assert.match(await readFile(join(chatA, 'src', 'n1.md'), 'utf8'), /id_ed25519_signing/)
    const metaA = JSON.parse(await readFile(join(chatA, 'meta.json'), 'utf8'))
    assert.equal(metaA.cid, 1)
    assert.equal(metaA.memoryOff, false)
    assert.equal(metaA.title, 'We decided to sign commits with the SSH key id_ed25519_sign…', 'title is the first message, shortened')
    // Its own topics are still in its context: nothing injected, no chats to announce.
    assert.equal((await step(agentA, ask('how do we sign commits?'))).messages.length, 1)
    assert.equal(metaA.private, undefined, 'nobody ran share: the chat is shared by default')

    // Chat B: on and shared by default, so its very first turn already gets chat A's memory.
    const sessionB = fakeSession('sB', cwd, [{ type: 'system/message', data: {} }])
    const agentB = { options: { cwd }, session: sessionB, runMaintenance: (fn) => fn() }
    const untouched = await step(agentB, ask('how do we sign commits?'))
    assert.equal(untouched.messages.length, 2)
    assert.match(untouched.messages[1].content[0].text, /Earlier chats in this workspace[\s\S]*- c1n1 commit signing/)
    assert.match((await run(agentB, 'on')).text, /^Memory on · nothing indexed yet \(no new messages since the last build\) · 1 shared chat to draw on/)
    // First human turn after on: chat list + hit, inline because the source is short.
    const first = await step(agentB, ask('how do we sign commits?'))
    assert.equal(first.messages.length, 2)
    const injected = first.messages[1]
    assert.equal(injected.role, 'user')
    assert.deepEqual(injected.source, { kind: 'context-graph', layer: 'surface' })
    const text = injected.content[0].text
    assert.match(text, /Memory is on\. Earlier chats in this workspace[\s\S]*- c1 \d{4}-\d{2}-\d{2} We decided to sign commits with the SSH key id_ed25519_sign… \(1 topics\)/)
    assert.match(text, /- c1n1 commit signing: commits are signed/)
    assert.match(text, /Verbatim source of c1n1:[\s\S]*id_ed25519_signing/)
    // Second turn: no list, hit still shown; unrelated prompt injects nothing; a named day with no hit lists that day.
    const second = await step(agentB, ask('how do we sign commits?'))
    assert.equal(second.messages[1].source.layer, undefined)
    assert.equal((await step(agentB, ask('what is the weather'))).messages.length, 1)
    const today = await step(agentB, ask('what did we do today?'))
    assert.match(today.messages[1].content[0].text, /^\[context-graph\] Chats from today:\n- c1 .*\(1 topics\)\n  - c1n1 commit signing/)
    assert.equal((await step(agentB, ask('what did we do 2 days ago?'))).messages[1].content[0].text, '[context-graph] No chats from 2 days ago.')
    // Tool-continuation steps carry no human message and are left alone.
    assert.equal((await step(agentB, { kind: 'enter', messages: [] })).messages.length, 0)

    // recall by topic, chat, day, turn; unknown ids.
    const recall = (id, agent = agentB) => ctx.registered[0].execute({ id }, { agent })
    const topic = await recall('c1n1')
    assert.equal(topic.status, 'ok')
    assert.match(topic.text, /# c1n1 commit signing[\s\S]*id_ed25519_signing/)
    assert.match((await recall('c1')).text, /^# c1 We decided[\s\S]*- c1n1 commit signing/)
    assert.match((await recall(day(new Date().toISOString()))).text, /Chats from \d{4}-\d{2}-\d{2}:\n- c1 /)
    assert.match((await recall('t1', agentA)).text, /# t1 \(verbatim\)[\s\S]*id_ed25519_signing[\s\S]*Noted: commit signing/)
    assert.equal((await recall('t1')).status, 'unknown')
    assert.equal((await recall('c1n9')).status, 'unknown')
    assert.equal((await recall('c7')).status, 'unknown')
    assert.equal((await recall('bogus')).status, 'unknown')
    await assert.rejects(ctx.registered[0].execute({}, { agent: agentB }), 'missing id is rejected by the schema')

    // meter: one main request flows through llm/stream untouched
    const chunks = [{ type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 } }]
    const out = []
    for await (const c of ctx.listeners['llm/stream']({ purpose: undefined }, () => (async function* () { yield* chunks })())) out.push(c)
    assert.deepEqual(out, chunks)
    const stats = await run(agentB, '')
    assert.match(stats.text, /^Memory on · 0 topics in this chat · shared · 1 shared chat · 0 turns waiting to be indexed/)
    assert.match(stats.text, /Main requests: 1; input 10 uncached \+ 90 cache-read \+ 0 cache-write; cache-hit 90%/)
    assert.match(stats.text, /recalls: 4/)
    assert.match((await run(agentB, 'find gpg')).text, /^1 matching topic\nc1n1 commit signing: /)
    assert.match((await run(agentB, 'map')).text, /^2 chats in [\s\S]*c2 .*· 0 topics · this chat, memory on, shared\nc1 .*· 1 topics · memory on, shared\n  - c1n1 /)
    assert.match((await run(agentA, 'unshare')).text, /^No longer shared · 1 topics/)
    assert.equal((await step(agentB, ask('how do we sign commits?'))).messages.length, 1, 'unshared chat is invisible')
    assert.match((await run(agentA, 'share')).text, /^Shared with the workspace · 1 topics/)
    assert.equal((await step(agentB, ask('how do we sign commits?'))).messages.length, 2, 'share makes it visible again')
    assert.match((await run(agentA, 'off')).text, /^Memory off/)
    assert.equal(ctx.listeners['agent/turn-stopping']({ agent: agentA, turn: 2 }), undefined)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('plugin: builder failures are contained', { skip }, async () => {
  const { apply } = await import('../index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'context-graph-plugin-'))
  try {
    const ctx = fakeCtx(fakeLlm('not json at all'))
    apply(ctx, { _updates: NO_UPDATES })
    const session = fakeSession('sC', cwd, [user('hello there, this is long enough to matter for the build threshold')])
    const agent = { options: { cwd }, session, runMaintenance: (fn) => fn() }
    const on = await ctx.commands[0].handler({ rawInput: 'on', agent })
    assert.equal(on.kind, 'success')
    assert.match(on.text, /nothing indexed yet \(builder output was not the expected JSON/)
    const failed = await ctx.commands[0].handler({ rawInput: 'build', agent })
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /not the expected JSON/)
    assert.match(await readFile(join(cwd, '.context-graph', 'chats', 'sC', 'last-builder-output.txt'), 'utf8'), /--- answer ---\nnot json at all/)
    assert.match((await ctx.commands[0].handler({ rawInput: 'stats', agent })).text, /^Memory on · 0 topics[\s\S]*1 turns waiting to be indexed/)
    // turn-stopping never throws and never blocks
    assert.equal(ctx.listeners['agent/turn-stopping']({ agent, turn: 1 }), undefined)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('plugin: an available update is mentioned once per app start and in stats', { skip }, async () => {
  const { apply } = await import('../index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'context-graph-update-'))
  try {
    const ctx = fakeCtx(fakeLlm(BUILDER_REPLY))
    apply(ctx, { _updates: { current: () => 'dsh-context-graph 9.9.9 is available (you have 0.2.3).' } })
    const agent = { options: { cwd }, session: fakeSession('sU', cwd, [{ type: 'system/message', data: {} }]), runMaintenance: (fn) => fn() }
    const first = await ctx.listeners['agent/pre-step']({ agent, messages: ask('hello').messages }, async () => ask('hello'))
    assert.equal(first.messages.length, 2)
    assert.match(first.messages[1].content[0].text, /9\.9\.9 is available.*tell the user this in one short line/)
    const second = await ctx.listeners['agent/pre-step']({ agent, messages: ask('hello').messages }, async () => ask('hello'))
    assert.equal(second.messages.length, 1, 'only once')
    const stats = await ctx.commands[0].handler({ rawInput: 'stats', agent })
    assert.match(stats.text, /update available\nVersion \d+\.\d+\.\d+: dsh-context-graph 9\.9\.9 is available/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
