/**
 * Host tests for the review of v0.10.0 (privacy lens): a fork that resumes a goal set in an
 * ancestor's off stretch (K0); a chat driven only by /goal gets a fingerprint, and a failed listing
 * of dsh's sessions is not retried on every message (K10). Each fails without its fix.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-review-privacy.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { saveGraph, updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4review-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const chat = (cwd, sid) => join(cwd, '.context-graph', 'chats', sid)
const metaOf = (cwd, sid) => readFile(join(chat(cwd, sid), 'meta.json'), 'utf8').then(JSON.parse)
const storedOf = (cwd, sid) => readFile(join(chat(cwd, sid), 'msgs.json'), 'utf8').catch(() => '')

const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
// As dsh-goal-round-driver and dsh-goal write them.
const round = (objective, n, revision = 1) => ({ type: 'user/message', data: { source: { kind: 'goal', goalId: 'g1', revision, round: n }, content: [{ type: 'text', text: `<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${n}/256\n\nContinue working toward the objective in this same session.\n</goal_round>` }] } })
const goal = (objective, operation, revision = 1) => ({ type: 'goal/change', data: { kind: 'goal/change', version: 1, operation, goal: { id: 'g1', revision, objective, phase: operation === 'pause' ? 'paused' : 'active', maxGoalRounds: 256 }, roundsStarted: 0 } })
/** A builder model that cites every message it is shown, so anything it reads would be stored. */
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'all of it', aliases: ['deploy'], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
/** dsh's sessionQuery over the test's own logs: other chats' turns are read from there. */
const queryOf = (logs) => ({ async observeSession(sid) { return { header: {}, events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } })
const lastTurn = (log) => Math.max(0, ...log.filter((e) => e.type === 'turn/start').map((e) => e.data.turn))

const SECRET = 'move the SECRET-VAULT keys'

/** Chat A: one indexed turn; then memory off, `/goal` typed and one round run while off, the goal paused. */
async function offStretchGoal(h, cwd, logs) {
  const a = agentOf('sA', cwd, [system(), ...turn(1, user('We deploy on Fridays, decided.'), assistant('ok'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  await h.run(a, 'off')
  for (const e of [{ type: 'command/run', data: { name: 'goal', args: SECRET, source: { kind: 'user' } } }, goal(SECRET, 'create'), ...turn(2, round(SECRET, 1), assistant('Moved one SECRET-VAULT key.')), goal(SECRET, 'pause')]) a.session.append(e)
  return a
}

/** A fork of `parent` as dsh makes one (its log so far, isSeeded, the parent named), seen by the plugin. */
async function forkOf(h, cwd, logs, parent, sid) {
  const n = parent.session.log.length
  const f = agentOf(sid, cwd, parent.session.log.slice(), { header: { isSeeded: true, parentSession: parent.session.id }, inheritedEventCount: n })
  logs.set(sid, f.session.log)
  // dsh gives a fork its meta when it is first seen (runtime.js metaFor).
  await h.run(f, 'stats')
  return f
}

/** Index a chat by command once no build of it (on's own) is running. */
const index = (h, agent) => until(async () => { const out = await h.run(agent, 'build'); return !/busy/.test(out.text) && out })

const ancestors = [
  ['forked after on', async (h, a) => { await h.run(a, 'on'); return a }],
  ['forked while memory is still off there', async (h, a) => a],
  ['forked from a fork of it whose meta came before this fix', async (h, a, cwd, logs) => {
    await h.run(a, 'on')
    const n = a.session.log.length
    await updateMeta(join(cwd, '.context-graph'), 'sB', (m) => m, () => ({ builtSeq: n - 1, forkSeq: n, parent: 'sA', startedAt: 'T', lastActiveAt: 'T' }))
    const b = agentOf('sB', cwd, [...a.session.log, ...turn(lastTurn(a.session.log) + 1, user('Fork B: the CI runners move to arm64.'), assistant('ok'))], { header: { isSeeded: true, parentSession: 'sA' }, inheritedEventCount: n })
    logs.set('sB', b.session.log)
    return b
  }],
  ['forked after its meta lost its stretches (damaged, then on)', async (h, a, cwd) => {
    await h.run(a, 'on')
    const end = a.session.log.length - 1
    await updateMeta(join(cwd, '.context-graph'), 'sA', ({ gaps, ...m }) => ({ ...m, turnsClosed: true, closedThrough: end }))
    return a
  }]
]

for (const [name, ancestorOf] of ancestors) {
  test(`K0 a goal set in an ancestor's off stretch stays private when a fork resumes it: ${name}`, { skip }, () => inWorkspace(async (cwd) => {
    const logs = new Map()
    const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
    const parent = await ancestorOf(h, await offStretchGoal(h, cwd, logs), cwd, logs)
    const f = await forkOf(h, cwd, logs, parent, 'sF')
    // on indexes in the background: settled before the fork goes on, so the build below reads its turns.
    if ((await metaOf(cwd, 'sF')).memoryOff === true) {
      await h.run(f, 'on')
      await index(h, f)
    }
    const t = lastTurn(f.session.log)
    for (const e of [goal(SECRET, 'resume', 2), ...turn(t + 1, round(SECRET, 2, 2), assistant('Moved more SECRET-VAULT keys.')), ...turn(t + 2, user('Unrelated: the CI cache key is now v2.'), assistant('ok'))]) f.session.append(e)
    assert.equal((await index(h, f)).kind, 'success')
    assert.match(h.llm.prompts.at(-1), /CI cache key is now v2/, 'the fork\'s own typed turn is indexed')
    assert.doesNotMatch(h.llm.prompts.join('\n'), /SECRET-VAULT/, 'no build reads the goal\'s rounds')
    assert.doesNotMatch(await storedOf(cwd, 'sF'), /SECRET-VAULT/)
    const { cid } = await metaOf(cwd, 'sF')
    const b = agentOf('sR', cwd, [system()])
    assert.equal((await h.recall(b, `c${cid}t${t + 1}`)).status, 'unknown', 'nor does recall serve them')
    assert.match((await h.recall(b, `c${cid}t${t + 2}`)).text, /CI cache key is now v2/)
  }))
}

test('K0 a fork whose own meta came before this fix takes its ancestors\' off stretches before its next index (second review)', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = await offStretchGoal(h, cwd, logs)
  await h.run(a, 'on')
  // The fork's meta as 0.9.0 wrote it when the fork was first seen: no gaps, no offsInherited.
  const n = a.session.log.length
  await updateMeta(join(cwd, '.context-graph'), 'sF', (m) => m, () => ({ builtSeq: n - 1, forkSeq: n, parent: 'sA', startedAt: 'T', lastActiveAt: 'T' }))
  const f = agentOf('sF', cwd, a.session.log.slice(), { header: { isSeeded: true, parentSession: 'sA' }, inheritedEventCount: n })
  logs.set('sF', f.session.log)
  const t = lastTurn(f.session.log)
  for (const e of [goal(SECRET, 'resume', 2), ...turn(t + 1, round(SECRET, 2, 2), assistant('Moved more SECRET-VAULT keys.')), ...turn(t + 2, user('Unrelated: the CI cache key is now v2.'), assistant('ok'))]) f.session.append(e)
  assert.equal((await index(h, f)).kind, 'success')
  assert.match(h.llm.prompts.at(-1), /CI cache key is now v2/, 'the fork\'s own typed turn is indexed')
  assert.doesNotMatch(h.llm.prompts.join('\n'), /SECRET-VAULT/, 'no build reads the goal\'s rounds')
  assert.doesNotMatch(await storedOf(cwd, 'sF'), /SECRET-VAULT/)
  const meta = await metaOf(cwd, 'sF')
  assert.equal(meta.offsInherited, true)
  const b = agentOf('sR', cwd, [system()])
  assert.equal((await h.recall(b, `c${meta.cid}t${t + 1}`)).status, 'unknown', 'nor does recall serve them')
}))

const OBJECTIVE = 'move the CI cache to the new bucket'
const work = (i) => `Round ${i}: moved part ${i} of the CI cache to the new bucket and checked the hit rate, which held at 92 percent.`

test('K10 a chat driven only by /goal gets a fingerprint, so the next run lists no dsh sessions for it; a typed prompt takes the fingerprint over', { skip }, () => inWorkspace(async (cwd) => {
  let listings = 0
  const sessionQuery = { async listSessions() { listings++; return [] }, async observeSession() { return { header: {}, inheritedEventCount: 0, events: [], [Symbol.dispose]() {} } } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  const g = agentOf('sG', cwd, [system(), goal(OBJECTIVE, 'create'), ...[1, 2, 3, 4].flatMap((i) => turn(i, round(OBJECTIVE, i), assistant(work(i))))])
  h.listeners['agent/turn-stopping']({ agent: g })
  const before = (await until(() => metaOf(cwd, 'sG').catch(() => undefined))).firstKey
  assert.equal(typeof before, 'string')
  // The next app run: its first message in another chat does not wait for a listing of every dsh session.
  const next = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  await next.step(agentOf('sB', cwd, [system()]), ask('how did we move the CI cache to the new bucket?'))
  assert.equal(listings, 0)
  // Typed later: the fingerprint is the one a chat that began with that prompt has, which forks are matched by.
  for (const e of turn(5, user('Also purge the old bucket once the cache is warm.'), assistant('Purged.'))) g.session.append(e)
  await next.run(g, 'build')
  await next.run(agentOf('sT', cwd, [system(), ...turn(1, user('Also purge the old bucket once the cache is warm.'), assistant('ok'))]), 'build')
  const after = (await metaOf(cwd, 'sG')).firstKey
  assert.notEqual(after, before)
  assert.equal(after, (await metaOf(cwd, 'sT')).firstKey)
}))

test('K10 a listing of dsh\'s sessions that failed is not tried again on every message', { skip }, () => inWorkspace(async (cwd) => {
  let listings = 0
  const sessionQuery = { async listSessions() { listings++; throw new Error('cannot list sessions') }, async observeSession() { return undefined } }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  // A chat as 0.4-0.7 wrote it: its meta cannot say whether it is a fork.
  const dir = join(cwd, '.context-graph')
  await updateMeta(dir, 'sL', (m) => m, () => ({ title: 'deploys', startedAt: 'T', lastActiveAt: new Date().toISOString(), builtSeq: 12 }))
  await saveGraph(chat(cwd, 'sL'), { version: 2, nextId: 2, nodes: { n1: { label: 'deploy key rotation', gist: 'rotated every 90 days', aliases: [], kind: 'decision', refs: [1], at: 'T', updated: 'T' } }, edges: [] })
  for (let i = 0; i < 3; i++) await h.step(agentOf(`sR${i}`, cwd, [system()]), ask('how often is the deploy key rotation?'))
  assert.equal(listings, 1)
}))
