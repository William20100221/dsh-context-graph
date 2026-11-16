/**
 * End to end in dsh's own runtime (cycle 4, built from the audit's runtime harness): cordis,
 * dsh-llm, session, session projections, system prompt, tools, agent, agent loop, session query,
 * commands and goal, with a scripted provider and this plugin loaded the way dsh loads it. Each test
 * boots its own runtime in its own workspace. Skipped unless DSH_NODE_MODULES names a dsh install
 * that has all of these packages:
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/e2e/cycle4-real-dsh.test.js
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { NO_UPDATES, until } from '../helpers/harness.js'

const PACKAGES = ['cordis', 'cordis-plugin-timer', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt', 'dsh-tools', 'dsh-agent', 'dsh-agent-loop', 'dsh-session-query', 'dsh-commands', 'dsh-goal', 'dsh-goal-round-driver', 'dsh-command-goal']

const dsh = {}
const missing = []
if (process.env.DSH_NODE_MODULES) await Promise.all(PACKAGES.map((name) => import(`@deepseek-ai/${name}`).then((m) => { dsh[name] = m }, () => missing.push(name))))
const skip = !process.env.DSH_NODE_MODULES ? 'needs DSH_NODE_MODULES (a dsh install)' : missing.length > 0 && `needs ${missing.join(', ')} in DSH_NODE_MODULES`

// Every workspace of this file lives in one folder, removed when the process exits, when nothing is
// pending any more: the plugin's turn-end work (an index, the savings estimate) runs in the
// background and can still be writing when a test ends, so removing a workspace then would race it.
const root = skip ? undefined : mkdtempSync(join(tmpdir(), 'cg-e2e-'))
if (root) process.on('exit', () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 5 }) } catch { /* left to the OS */ } })

const ANSWER = 'Noted. We sign commits with the SSH key id_ed25519_signing and gpg.format ssh.'
const TOPIC = JSON.stringify({ summary: 'commit signing setup', nodes: [{ id: null, label: 'commit signing', gist: 'commits are signed with the SSH key id_ed25519_signing', aliases: ['gpg'], kind: 'decision', msgs: [0] }], edges: [] })

/**
 * A provider route for dsh-llm: `script(options)` answers the chats' own requests with `{ text }`
 * or `{ tool: { name, args } }`; the plugin's indexing call gets TOPIC. Every request is kept with
 * its text blocks.
 */
function scriptedProvider(llm, script) {
  const calls = []
  class Scripted extends llm.LlmAdapter {
    providerInfo(provider) { return { id: provider, name: provider } }
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: [{ id: 'off', name: 'off' }, { id: 'high', name: 'high' }] } } }
    async *stream(options) {
      const loop = llm.isAgentLoopRequest(options)
      const texts = options.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).map((b) => b.text ?? '')
      calls.push({ loop, purpose: options.purpose, sessionId: options.sessionId, effort: options.reasoningEffort, texts, text: texts.join('\n') })
      const out = loop ? script(options) : { text: TOPIC }
      let index = 0
      if (out.text) {
        yield { type: 'block-start', index, blockType: 'text' }
        yield { type: 'text-delta', index, text: out.text }
        yield { type: 'block-end', index, block: { type: 'text', text: out.text } }
        index++
      }
      if (out.tool) {
        const args = JSON.stringify(out.tool.args)
        const id = `call-${calls.length}`
        yield { type: 'block-start', index, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index, id, name: out.tool.name, argumentsDelta: args }
        yield { type: 'block-end', index, block: { type: 'tool-call', id, name: out.tool.name, arguments: args } }
      }
      yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 } }
      yield { type: 'finish', reason: { kind: out.tool ? 'tool-calls' : 'stop' } }
    }
  }
  return { calls, adapter: new Scripted() }
}

/** The plugin's [context-graph] blocks in one request, as one text ('' when it has none). */
const blocksOf = (call) => call.texts.filter((t) => t.startsWith('[context-graph]')).join('\n')

/** Boot dsh with the plugin in a new workspace, run `fn`, then shut dsh down. */
async function withDsh({ script = () => ({ text: ANSWER }) }, fn) {
  const llm = dsh['dsh-llm']
  const { calls, adapter } = scriptedProvider(llm, script)
  const workspace = await mkdtemp(join(root, 'ws-'))
  const ctx = new dsh.cordis.Context()
  try {
    const plugins = [
      [dsh['cordis-plugin-timer'].default],
      [llm.default],
      [dsh['dsh-session'].default],
      [dsh['dsh-session-projection'].default],
      [dsh['dsh-system-prompt'].default, { personaPrefix: 'Test agent.', includeHarnessIdentity: false, includeRuntimeContext: false }],
      [dsh['dsh-tools'].default],
      [dsh['dsh-agent'].default],
      [dsh['dsh-agent-loop'].default, { agents: [] }],
      [{ name: 'scripted-provider', inject: ['llm'], apply: (c) => c.effect(() => c.llm.registerAdapter(['scripted'], adapter)) }],
      [dsh['dsh-session-query'].default],
      [dsh['dsh-commands'].default],
      // Four rounds: as many turns as the plugin waits for between indexes.
      [dsh['dsh-goal'].default, { defaultMaxGoalRounds: 4 }],
      [dsh['dsh-goal-round-driver']],
      [dsh['dsh-command-goal']],
      [await import('../../index.js'), { _updates: NO_UPDATES }]
    ]
    for (const [plugin, config] of plugins) await ctx.plugin(plugin, config)
    const chat = async (sessionId) => (await ctx.agents.create({ sessionId, meta: { cwd: workspace }, agentOptions: { provider: 'scripted', model: 'm1' } })).agent
    const command = async (agent, line) => (await ctx.commands.execute(agent, line, [], new AbortController().signal))?.result
    await fn({ ctx, calls, workspace, chat, command })
  } finally {
    await ctx.fiber.dispose()
  }
}

/** One typed prompt, answered: a follow-up as dsh's composer sends it, then idle again. */
async function say(agent, text) {
  agent.followup(dsh['dsh-llm'].createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await agent.whenIdle()
}

/** Four typed turns about commit signing: the plugin indexes the chat at the fourth turn end. */
async function typeTurns(agent) {
  for (let i = 1; i <= 4; i++) await say(agent, `We decided to sign commits with the SSH key, step ${i}. `.repeat(4))
}

function events(agent) {
  const out = []
  for (let event; (event = agent.session.eventAt(out.length));) out.push(event)
  return out
}

const chatDir = (workspace, sid) => join(workspace, '.context-graph', 'chats', sid)
const metaOf = (workspace, sid) => readFile(join(chatDir(workspace, sid), 'meta.json'), 'utf8').then(JSON.parse, () => undefined)
/** The chat's meta, once the chat has been indexed. */
const indexed = (workspace, sid) => until(async () => {
  const meta = await metaOf(workspace, sid)
  return Number.isInteger(meta?.builtSeq) && meta
})

test('e2e: typed prompts are indexed at dsh\'s turn end, with one call through its llm service', { skip }, () => withDsh({}, async ({ calls, workspace, chat }) => {
  const a = await chat('chat-a')
  await typeTurns(a)
  const meta = await indexed(workspace, 'chat-a')
  assert.deepEqual(calls.map((c) => (c.purpose === 'context-graph' ? 'index' : c.sessionId)), ['chat-a', 'chat-a', 'chat-a', 'chat-a', 'index'], 'four turns, then one indexing call')
  const build = calls.at(-1)
  assert.equal(build.loop, false, 'not a request of the chat itself')
  assert.equal(build.sessionId, 'chat-a')
  assert.equal(build.effort, 'off', 'the route\'s lowest reasoning effort')
  for (let i = 1; i <= 4; i++) assert.match(build.text, new RegExp(`step ${i}\\.`), `turn ${i} is read`)
  const log = events(a)
  assert.ok(meta.builtSeq >= log.findLast((e) => e.type === 'assistant/message').seq, 'indexed through the last answer')
  assert.equal(meta.cid, 1)
  assert.equal(meta.summary, 'commit signing setup')
  const topics = JSON.parse(await readFile(join(chatDir(workspace, 'chat-a'), 'topics.json'), 'utf8'))
  assert.deepEqual(Object.values(topics.nodes).map((n) => [n.label, n.refs]), [['commit signing', [log.find((e) => e.type === 'user/message').seq]]])
}))

test('e2e: a second chat gets the topic for a related question, then recalls it and its turn through sessionQuery', { skip }, async () => {
  // Chat B's model follows the ids it is shown: the topic, then the turn its source names.
  const steps = [{ tool: { name: 'recall', args: { id: 'c1n1' } } }, { tool: { name: 'recall', args: { id: 'c1t1' } } }, { text: 'We use id_ed25519_signing.' }]
  const script = (options) => (options.sessionId === 'chat-b' ? steps.shift() : undefined) ?? { text: ANSWER }
  await withDsh({ script }, async ({ calls, workspace, chat }) => {
    await typeTurns(await chat('chat-a'))
    await indexed(workspace, 'chat-a')
    const b = await chat('chat-b')
    await say(b, 'How do we set up commit signing with the SSH key again?')
    const first = calls.find((c) => c.loop && c.sessionId === 'chat-b')
    assert.match(blocksOf(first), /^- c1n1 commit signing: commits are signed with the SSH key id_ed25519_signing$/m)
    const results = events(b).filter((e) => e.type === 'tool/result').map((e) => e.data.message.content.map((x) => x.text).join(''))
    assert.equal(results.length, 2)
    assert.match(results[0], /^# c1n1 commit signing\n/)
    assert.match(results[0], /user \(c1t1\):\nWe decided to sign commits with the SSH key, step 1\./)
    assert.match(results[1], /^# c1t1 /)
    // Only the prompt is a stored message (the topic cites it): the answer came from dsh's log.
    assert.match(results[1], /user:\nWe decided to sign commits with the SSH key, step 1\.[^]*assistant:\nNoted\. We sign commits/)
    assert.doesNotMatch(results[1], /step 2\./, 'turn 1 only')
  })
})

test('e2e: /context-graph off then on, through dsh\'s command service, records a gap the builder never reads', { skip }, () => withDsh({}, async ({ calls, workspace, chat, command }) => {
  const a = await chat('chat-a')
  await say(a, 'Before off: we deploy on Fridays from now on, after the release checklist is signed. '.repeat(3))
  assert.match((await command(a, '/context-graph off')).text, /^Memory off for this chat/)
  await say(a, 'While off: the staging password rotation plan. '.repeat(3))
  const off = events(a).filter((e) => e.type === 'user/message' || e.type === 'assistant/message').slice(-2).map((e) => e.seq)
  assert.match((await command(a, '/context-graph on')).text, /^Memory on/)
  // on indexes the chat in the background: everything but the gap.
  const meta = await indexed(workspace, 'chat-a')
  assert.equal(meta.memoryOff, false)
  assert.equal(meta.gaps?.length, 1)
  const [from, to] = meta.gaps[0]
  assert.ok(from <= off[0] && off[1] <= to, `gap ${from}-${to} covers the turn typed while off (${off})`)
  const builds = calls.filter((c) => c.purpose === 'context-graph')
  assert.equal(builds.length, 1)
  assert.match(builds[0].text, /we deploy on Fridays/)
  assert.doesNotMatch(builds[0].text, /staging password/)
  assert.deepEqual(events(a).filter((e) => e.type === 'command/run').map((e) => e.data.name), ['context-graph', 'context-graph'], 'dsh logged both commands')
}))

const OBJECTIVE = 'set up commit signing with gpg for this repo, like we did before'
const ROUND = 'Configured gpg.format ssh with the signing key id_ed25519_signing and checked a signed commit on main; more checks remain for the next round.'

test('e2e: a /goal chat gets memory in its first round, and its rounds count toward indexing (#69)', { skip }, async () => {
  // Chat G has no typed prompt: every request it makes is a goal round.
  const script = (options) => ({ text: options.sessionId === 'chat-g' ? ROUND : ANSWER })
  await withDsh({ script }, async ({ ctx, calls, workspace, chat, command }) => {
    await typeTurns(await chat('chat-a'))
    await indexed(workspace, 'chat-a')
    const g = await chat('chat-g')
    assert.match((await command(g, `/goal ${OBJECTIVE}`)).text, /^Goal created/)
    // dsh runs the rounds as follow-ups (source kind 'goal') until its round limit stops the goal.
    await until(() => ctx.goals.get(g)?.phase === 'blocked' && g.status === 'idle')
    const rounds = calls.filter((c) => c.loop && c.sessionId === 'chat-g')
    assert.equal(rounds.length, 4)
    assert.match(rounds[0].text, /<goal_round>\nObjective: "set up commit signing/)
    assert.match(blocksOf(rounds[0]), /^- c1n1 commit signing: /m, 'the first round gets the topic its objective names')
    // Four rounds are four turns: the chat is indexed at the last round's end, its objective included.
    await indexed(workspace, 'chat-g')
    const build = calls.find((c) => c.purpose === 'context-graph' && c.sessionId === 'chat-g')
    assert.match(build.text, /set up commit signing with gpg for this repo/)
  })
})
