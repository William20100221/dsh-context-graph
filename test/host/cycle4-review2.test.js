/**
 * Host tests for the second review of v0.10.0: what dsh drives from an off stretch is found from
 * the log, not stored as gaps, so a reminder that fires every day leaves shared turns readable (P5);
 * a fork holds its parent's topics that cite a plan, an answer or a goal round (P1).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-review2.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { updateMeta } from '../../src/store/chats.js'
import { agentOf, ask, assistant, scriptedLlm, setup, skip, system, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-c4review2-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const metaOf = (cwd, sid) => readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8').then(JSON.parse)
const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
const scheduled = (prompt) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', id: 'sc1', name: 'schedule_create', arguments: JSON.stringify({ prompt, cron: '0 9 * * *' }) }] } } })
const fired = (prompt) => ({ type: 'user/message', data: { source: { kind: 'schedule' }, content: [{ type: 'text', text: `[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-11-18T09:00:00.000Z\nreminder_prompt_json: ${JSON.stringify(prompt)}` }] } })
const queryOf = (logs) => ({ async observeSession(sid) { return { events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } })
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'all of it', aliases: [], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })

const PRIVATE = 'check the SECRET-VAULT balance'

test('second review P5: a reminder scheduled while off fires 60 times; meta.gaps stays its one off stretch and every shared turn stays readable', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = agentOf('sA', cwd, [system(), ...turn(1, user('We deploy on Fridays, decided.'), assistant('ok'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  const from = a.session.log.length
  for (const e of turn(2, user(PRIVATE), scheduled(PRIVATE))) a.session.append(e)
  // What off, then on, record: the reminder was scheduled in an off stretch.
  await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, gaps: [[from, a.session.log.length - 1]] }))
  let t = 2
  const shared = []
  for (let day = 1; day <= 60; day++) {
    for (const e of turn(++t, user(`Day ${day}: shared note number ${day}.`), assistant('noted'))) a.session.append(e)
    shared.push(t)
    for (const e of turn(++t, fired(PRIVATE), assistant(`The SECRET-VAULT balance on day ${day}.`))) a.session.append(e)
    if (day % 4 === 0) await h.run(a, 'build')
  }
  await h.run(a, 'build')
  const meta = await metaOf(cwd, 'sA')
  assert.equal(meta.gaps.length, 1, JSON.stringify(meta.gaps))
  assert.doesNotMatch(h.llm.prompts.join('\n'), /SECRET-VAULT/)
  const b = agentOf('sB', cwd, [system()])
  for (const n of [shared[0], shared[29], shared[59]]) assert.match((await h.recall(b, `c${meta.cid}t${n}`)).text, /shared note number/, `t${n}`)
  for (const n of [shared[0] + 1, shared[59] + 1]) assert.equal((await h.recall(b, `c${meta.cid}t${n}`)).status, 'unknown', `t${n} is the reminder`)
}))

const says = (text, calls = []) => ({ type: 'assistant/message', data: { message: { content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(([name, args, id]) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))] } } })
const result = (id, value) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } })
const round = (objective, n) => ({ type: 'user/message', data: { source: { kind: 'goal', goalId: 'g1', revision: 1, round: n }, content: [{ type: 'text', text: `<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${n}/256\n\nContinue working toward the objective in this same session.\n</goal_round>` }] } })
const goalSet = (objective) => ({ type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: 'g1', revision: 1, objective, phase: 'active', maxGoalRounds: 256 }, roundsStarted: 0 } })
const APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const OBJECTIVE = 'set up the billing database: Postgres 16 behind pgbouncer in transaction mode'
/** A builder model that files one topic citing the messages `pick` chooses. */
const builder = (pick) => scriptedLlm({ reply: (o) => {
  const lines = [...o.messages[0].content[0].text.matchAll(/\[m(\d+) (\w+)/g)].map((m) => ({ i: Number(m[1]), role: m[2] }))
  return JSON.stringify({ nodes: [{ label: 'billing database pgbouncer', gist: 'billing runs Postgres 16 behind pgbouncer in transaction mode', aliases: ['pgbouncer', 'billing database'], kind: 'decision', msgs: pick(lines) }], edges: [] })
} })
const FORK_CASES = {
  typed: [[system(), ...turn(1, user('For the billing database we run Postgres 16 behind pgbouncer in transaction mode.'), assistant('Noted: Postgres 16, pgbouncer, transaction mode.'))], () => [0, 1]],
  plan: [[system(), ...turn(1, user('Plan the billing database setup.'), says('', [['exit_plan_mode', { plan: '# Billing database\nPostgres 16 behind pgbouncer in transaction mode.' }, 'p1']]), result('p1', APPROVED), says('Implementing the plan: Postgres 16 behind pgbouncer.'))], (lines) => lines.filter((l) => l.role === 'assistant').map((l) => l.i)],
  answer: [[system(), ...turn(1, user('Set up the billing database.'), says('', [['ask_user_question', { questions: [{ id: 'pool', question: 'Which pooler for the billing database?' }] }, 'q1']]), result('q1', { answers: [{ id: 'pool', selected: ['pgbouncer in transaction mode'] }] }), says('Postgres 16 behind pgbouncer, transaction mode.'))], (lines) => lines.filter((l) => l.role === 'user').map((l) => l.i)],
  goal: [[system(), goalSet(OBJECTIVE), ...turn(1, round(OBJECTIVE, 1), assistant('Installed Postgres 16 and pgbouncer for billing.'))], () => [0, 1]]
}

for (const [name, [log, pick]] of Object.entries(FORK_CASES)) {
  test(`second review: a fork holds its parent's topic that cites ${name === 'typed' ? 'typed messages' : `${name === 'answer' ? 'an' : 'a'} ${name}`}, so it is not sent again`, { skip }, () => inWorkspace(async (cwd) => {
    const h = await setup({ buildMinChars: 1 }, builder(pick))
    const a = agentOf('sA', cwd, log)
    assert.equal((await h.run(a, 'build')).kind, 'success')
    const n = a.session.log.length
    const f = agentOf('sF', cwd, a.session.log.slice(), { header: { isSeeded: true, parentSession: 'sA' }, inheritedEventCount: n })
    const out = await h.step(f, ask('how is pgbouncer set up for the billing database again?'))
    assert.equal(out.messages.length, 1, out.messages.slice(1).map((m) => m.content[0].text).join('\n'))
  }))
}

test('second review: after a failed listing of dsh\'s sessions, a 0.4-0.6 fork\'s inherited topics are held back while its fork point is learned', { skip }, () => inWorkspace(async (cwd) => {
  const { saveGraph } = await import('../../src/store/chats.js')
  let listings = 0
  const sessionQuery = {
    async listSessions() { listings++; throw new Error('SQLITE_BUSY') },
    async observeSession(sid) { return sid === 'sL' ? { header: { isSeeded: true }, inheritedEventCount: 5, events: [], [Symbol.dispose]() {} } : undefined }
  }
  const h = await setup({}, scriptedLlm({ reply: '{}' }), { sessionQuery })
  // A fork as 0.4-0.6 left it: no fork point, no fingerprint; its topic cites only an inherited message.
  const dir = join(cwd, '.context-graph')
  await updateMeta(dir, 'sL', (m) => m, () => ({ title: 'deploys', startedAt: 'T', lastActiveAt: new Date().toISOString(), builtSeq: 12 }))
  await saveGraph(join(dir, 'chats', 'sL'), { version: 2, nextId: 2, nodes: { n1: { label: 'deploy key rotation', gist: 'rotated every 90 days', aliases: [], kind: 'decision', refs: [1], at: 'T', updated: 'T' } }, edges: [] })
  for (let i = 0; i < 3; i++) {
    const out = await h.step(agentOf(`sR${i}`, cwd, [system()]), ask('how often is the deploy key rotation?'))
    assert.doesNotMatch(out.messages.slice(1).map((m) => m.content[0].text).join('\n'), /deploy key rotation/, `message ${i + 1}`)
  }
  assert.equal(listings, 1)
}))
