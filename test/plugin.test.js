/**
 * Wiring check of index.js against a fake harness: build via the command, matcher injection for a
 * second session, recall, and the meter. Needs the dsh peer packages:
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/resolve-dsh.mjs --test test/plugin.test.js
 * Skipped when DSH_NODE_MODULES is unset.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const skip = !process.env.DSH_NODE_MODULES

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

test('plugin: build, inject for a later session, recall, meter', { skip }, async () => {
  const { apply } = await import('../index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'context-graph-plugin-'))
  try {
    const llm = fakeLlm(BUILDER_REPLY)
    const ctx = fakeCtx(llm)
    apply(ctx, { buildEveryTurns: 1, buildMinChars: 1 })
    assert.ok(ctx.listeners['agent/pre-step'] && ctx.listeners['agent/turn-stopping'] && ctx.listeners['llm/stream'])
    assert.equal(ctx.registered[0].name, 'recall')
    assert.equal(ctx.commands[0].name, 'context-graph')

    // Session A: two messages, then an explicit build through the command.
    const sessionA = fakeSession('sA', cwd, [
      { type: 'system/message', data: {} },
      user('We decided to sign commits with the SSH key id_ed25519_signing'),
      assistant('Noted: commit signing uses that SSH key.')
    ])
    const agentA = { options: { cwd }, session: sessionA, runMaintenance: (fn) => fn() }
    const built = await ctx.commands[0].handler({ rawInput: 'build', agent: agentA })
    assert.equal(built.kind, 'success', built.text)
    assert.match(built.text, /Indexed 1 nodes \(1 new\)/)
    assert.equal(llm.calls.length, 1)
    assert.equal(llm.calls[0].purpose, 'context-graph')
    assert.equal(llm.calls[0].model, 'deepseek-chat')
    assert.match(llm.calls[0].messages[0].content[0].text, /\[m0 user\]\nWe decided to sign commits/)
    const graph = JSON.parse(await readFile(join(cwd, '.context-graph', 'graph.json'), 'utf8'))
    assert.equal(graph.nodes.n1.label, 'commit signing')
    assert.match(await readFile(join(cwd, '.context-graph', 'src', 'n1.md'), 'utf8'), /id_ed25519_signing/)

    // Session A again: its own nodes are still in context, so nothing is injected.
    const enter = { kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'how do we sign commits?' }] }] }
    const sameSession = await ctx.listeners['agent/pre-step']({ agent: agentA, messages: enter.messages }, async () => enter)
    assert.equal(sameSession.messages.length, 1)

    // Session B in the same workspace: surface layer + hit, inline because the source is short.
    const sessionB = fakeSession('sB', cwd, [{ type: 'system/message', data: {} }])
    const agentB = { options: { cwd }, session: sessionB, runMaintenance: (fn) => fn() }
    const first = await ctx.listeners['agent/pre-step']({ agent: agentB, messages: enter.messages }, async () => enter)
    assert.equal(first.messages.length, 2)
    const injected = first.messages[1]
    assert.equal(injected.role, 'user')
    assert.deepEqual(injected.source, { kind: 'context-graph', layer: 'surface' })
    const text = injected.content[0].text
    assert.match(text, /Memory of earlier sessions in this project \(1 nodes\)/)
    assert.match(text, /- n1 commit signing: commits are signed/)
    assert.match(text, /Verbatim source of n1:[\s\S]*id_ed25519_signing/)

    // Second human turn in B: no surface layer, hit still shown; unrelated prompt injects nothing.
    const second = await ctx.listeners['agent/pre-step']({ agent: agentB, messages: enter.messages }, async () => enter)
    assert.equal(second.messages[1].source.layer, undefined)
    const unrelated = { kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text: 'what is the weather' }] }] }
    const none = await ctx.listeners['agent/pre-step']({ agent: agentB, messages: unrelated.messages }, async () => unrelated)
    assert.equal(none.messages.length, 1)
    // Tool-continuation steps carry no human message and are left alone.
    const cont = { kind: 'enter', messages: [] }
    assert.equal((await ctx.listeners['agent/pre-step']({ agent: agentB, messages: [] }, async () => cont)).messages.length, 0)

    // recall
    const ok = await ctx.registered[0].execute({ id: 'n1' }, { agent: agentB })
    assert.equal(ok.status, 'ok')
    assert.match(ok.text, /# n1 commit signing[\s\S]*id_ed25519_signing/)
    const unknown = await ctx.registered[0].execute({ id: 'n9' }, { agent: agentB })
    assert.equal(unknown.status, 'unknown')
    await assert.rejects(ctx.registered[0].execute({}, { agent: agentB }), 'missing id is rejected by the schema')

    // meter: one main request flows through llm/stream untouched
    const chunks = [{ type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 90, cacheWriteTokens: 0, outputTokens: 5 } }]
    const out = []
    for await (const c of ctx.listeners['llm/stream']({ purpose: undefined }, () => (async function* () { yield* chunks })())) out.push(c)
    assert.deepEqual(out, chunks)
    const stats = await ctx.commands[0].handler({ rawInput: '', agent: agentB })
    assert.match(stats.text, /Graph: 1 nodes, 0 edges/)
    assert.match(stats.text, /This chat: 0 human turns not indexed yet/)
    assert.match(stats.text, /Main requests: 1; input 10 uncached \+ 90 cache-read \+ 0 cache-write; cache-hit 90%/)
    assert.match(stats.text, /recalls: 1/)
    const find = await ctx.commands[0].handler({ rawInput: 'find gpg', agent: agentB })
    assert.match(find.text, /- n1 commit signing/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('plugin: builder failures are contained', { skip }, async () => {
  const { apply } = await import('../index.js')
  const cwd = await mkdtemp(join(tmpdir(), 'context-graph-plugin-'))
  try {
    const ctx = fakeCtx(fakeLlm('not json at all'))
    apply(ctx, {})
    const session = fakeSession('sC', cwd, [user('hello there, this is long enough to matter for the build threshold')])
    const agent = { options: { cwd }, session, runMaintenance: (fn) => fn() }
    const skipped = await ctx.commands[0].handler({ rawInput: 'stats', agent })
    assert.match(skipped.text, /Graph: 0 nodes/)
    assert.match(skipped.text, /This chat: 1 human turns not indexed yet; auto-index at 4/)
    const failed = await ctx.commands[0].handler({ rawInput: 'build', agent })
    assert.equal(failed.kind, 'error')
    assert.match(failed.text, /not the expected JSON/)
    // turn-stopping never throws and never blocks
    assert.equal(ctx.listeners['agent/turn-stopping']({ agent, turn: 1 }), undefined)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
