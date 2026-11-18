/**
 * Host tests for the third check of v0.10.0 (privacy lens): a steer in a private goal round never
 * becomes the title (T1); a recovered meta whose off stretches were lost keeps a goal set there
 * private (T2); a failed listing of dsh's sessions is tried again (T3); a fork's ancestor keys are
 * read once (T4). Each fails without its fix.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-check3.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'

import { chatDir, saveGraph, updateMeta } from '../../src/store/chats.js'
import { DEFAULT_REPLY, agentOf, ask, assistant, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4check3-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const T = (n, ...ev) => [{ type: 'turn/start', data: { turn: n } }, ...ev, { type: 'turn/end', data: { turn: n } }]
const goal = (objective, operation, revision) => ({ type: 'goal/change', data: { operation, goal: { id: 'G', revision, objective, phase: operation === 'pause' ? 'paused' : 'active' } } })
const round = (objective, n, revision) => ({ type: 'user/message', data: { source: { kind: 'goal', goalId: 'G', revision, round: n }, content: [{ type: 'text', text: `<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${n}/50\n</goal_round>` }] } })
const goalTyped = (objective) => ({ type: 'command/run', data: { name: 'goal', args: objective, source: { kind: 'user' } } })
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'release notes location', gist: 'release notes go in docs/release.md', aliases: [], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
const queryOf = (logs) => ({ async observeSession(sid) { const l = logs.get(sid); return l && { header: {}, events: l.map((e, seq) => ({ ...e, seq })), [Symbol.dispose]() {} } } })
/** Run a command once no build of the chat (on's own) is running. */
const done = (h, agent, cmd) => until(async () => { const out = await h.run(agent, cmd); return !/busy/.test(out.text) && out })

test('third check T1: a steer typed into a round of a goal set while off never becomes the chat\'s title', { skip }, () => inWorkspace(async (cwd) => {
  const SECRET = 'PRIVOBJ rotate the HR salary database credentials'
  const STEER = 'STEER use vault path hr/salary-prod for the creds'
  const h = await setup({ buildMinChars: 1 }, citesAll())
  // A chat turned off before anything was typed; /goal set while off, resumed after on.
  const a = agentOf('sA', cwd, [system()])
  await h.run(a, 'off')
  for (const e of [goalTyped(SECRET), goal(SECRET, 'create', 1), ...T(1, round(SECRET, 1, 1), assistant('Started rotating.')), goal(SECRET, 'pause', 1)]) a.session.append(e)
  await h.run(a, 'on')
  await done(h, a, 'stats')
  for (const e of [goal(SECRET, 'resume', 2), ...T(2, round(SECRET, 2, 2), assistant('Which vault path?'), user(STEER), assistant('Using it. Rotated.')), ...T(3, user('Separately: the release notes go in docs/release.md.'), assistant('ok'))]) a.session.append(e)
  assert.equal((await done(h, a, 'build')).kind, 'success')
  const meta = JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'meta.json'), 'utf8'))
  assert.doesNotMatch(String(meta.title), /STEER/)
  assert.doesNotMatch(h.llm.prompts.join('\n'), /STEER|PRIVOBJ/)
}))

test('third check T2: a recovered meta whose off stretches were lost keeps a goal set there private after on', { skip }, () => inWorkspace(async (cwd) => {
  const SECRET = 'PRIVOBJ draft the acquisition offer for Northwind'
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = agentOf('sA', cwd, [system(), ...T(1, user('Ops notes for the quarter.'), assistant('ok'))])
  logs.set('sA', a.session.log)
  await done(h, a, 'build')
  await h.run(a, 'off')
  for (const e of [goalTyped(SECRET), goal(SECRET, 'create', 1), ...T(2, round(SECRET, 1, 1), assistant('Drafting the offer.')), goal(SECRET, 'pause', 1)]) a.session.append(e)
  await h.run(a, 'on')
  await done(h, a, 'stats')
  for (const e of T(3, user('Ops: the backup window moves to 02:00.'), assistant('noted'))) a.session.append(e)
  await done(h, a, 'build')
  // A write cut off where the gaps start: they cannot be read back (turnsClosed).
  const file = join(cwd, '.context-graph', 'chats', 'sA', 'meta.json')
  const before = await readFile(file, 'utf8')
  await writeFile(file, before.slice(0, before.indexOf('"gaps"') + 9))
  await h.run(a, 'stats')
  await h.run(a, 'on')
  await done(h, a, 'stats')
  h.llm.prompts.length = 0
  for (const e of [goal(SECRET, 'resume', 2), ...T(4, round(SECRET, 2, 2), assistant('Offer drafted at 41M.')), ...T(5, user('Ops: rotate the on-call on Mondays.'), assistant('noted'))]) a.session.append(e)
  assert.equal((await done(h, a, 'build')).kind, 'success')
  assert.doesNotMatch(h.llm.prompts.join('\n'), /PRIVOBJ|41M/)
  assert.doesNotMatch(await readFile(join(cwd, '.context-graph', 'chats', 'sA', 'msgs.json'), 'utf8'), /PRIVOBJ|41M/)
  await h.run(a, 'share')
  const { cid } = JSON.parse(await readFile(file, 'utf8'))
  assert.equal((await h.recall(agentOf('sB', cwd, [system()]), `c${cid}t4`)).status, 'unknown')
}))

test('third check T3: a listing of dsh\'s sessions that failed is tried again later, so an ordinary old chat comes back', { skip }, () => inWorkspace(async (cwd) => {
  let listings = 0
  const sessionQuery = {
    async listSessions() { listings++; if (listings === 1) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); return [] },
    // Its dsh session is gone: its fork point cannot be learned from its log.
    async observeSession(sid) { throw new Error(`session ${sid} not found`) }
  }
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery })
  const dir = join(cwd, '.context-graph')
  const t = new Date().toISOString()
  await updateMeta(dir, 'sOld', (m) => m, () => ({ title: 'payments', startedAt: t, lastActiveAt: t, builtSeq: 12 }))
  await saveGraph(chatDir(dir, 'sOld'), { version: 2, nextId: 2, nodes: { n1: { label: 'stripe webhook secret rotation', gist: 'rotates every 90 days', aliases: ['stripe webhook'], kind: 'decision', refs: [3], at: t, updated: t } }, edges: [] })
  const found = async (i) => /stripe webhook secret rotation/.test((await h.step(agentOf(`sR${i}`, cwd, [system()]), ask('how often does the stripe webhook secret rotate?'))).messages.slice(1).map((m) => m.content[0].text).join('\n'))
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    assert.equal(await found(1), false, 'held back while the listing failed (fail closed)')
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
    mock.timers.tick(30000)
    assert.equal(await found(2), true, 'listed again: not a fork')
    assert.equal(listings, 2)
  } finally {
    mock.timers.reset()
  }
}))

test('third check T4: a fork with a long first prompt reads its ancestor keys once, not once per chat', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }))
  const dir = join(cwd, '.context-graph')
  const t = new Date().toISOString()
  for (let c = 0; c < 150; c++) {
    await updateMeta(dir, `s${c}`, (m) => m, () => ({ title: `chat ${c}`, firstKey: `k${c}`, startedAt: t, lastActiveAt: t, builtSeq: 3 }))
    await saveGraph(chatDir(dir, `s${c}`), { version: 2, nextId: 2, nodes: { n1: { label: `topic ${c}`, gist: 'g', aliases: [], kind: 'fact', refs: [1], at: t, updated: t } }, edges: [] })
  }
  const paste = `review this log ${'x'.repeat(10)} `.repeat(4000)
  const parent = [system(), user(paste), assistant('ok')]
  const f = agentOf('sF', cwd, [...parent, user('and now?')], { header: { isSeeded: true, parentSession: 'sNone' }, inheritedEventCount: parent.length })
  await h.step(f, ask('hello'))
  const started = performance.now()
  await h.step(f, ask('what did we work on yesterday?'))
  const ms = performance.now() - started
  assert.ok(ms < 200, `${Math.round(ms)} ms`)
}))
