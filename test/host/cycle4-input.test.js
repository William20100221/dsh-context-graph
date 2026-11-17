/**
 * Host tests for the cycle-4 input fixes (v0.10.0): /goal rounds and reminders (#69), plans and
 * answers (#70), dsh's turn numbers (#71), shown ids (#73), the chat list (#76), quiet chats (#42).
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/cycle4-input.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DEFAULT_REPLY, agentOf, ask, assistant, chatEvents, scriptedLlm, setup, skip, system, until, user, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-cycle4-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}
const chat = (cwd, sid) => join(cwd, '.context-graph', 'chats', sid)
const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(chat(cwd, sid), 'meta.json'), 'utf8'))
const storedOf = async (cwd, sid) => JSON.parse(await readFile(join(chat(cwd, sid), 'msgs.json'), 'utf8'))
const blockOf = (out) => out.messages.at(-1).content[0].text

const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
const says = (text, calls = []) => ({ type: 'assistant/message', data: { message: { content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(([name, args, id]) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))] } } })
const result = (id, value) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } })
// As dsh-goal-round-driver and dsh-goal write them.
const roundMessage = (objective, n, { goalId = 'g1', revision = 1 } = {}) => ({ source: { kind: 'goal', goalId, revision, round: n }, content: [{ type: 'text', text: `<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${n}/256\n\nContinue working toward the objective in this same session.\n</goal_round>` }] })
const round = (...args) => ({ type: 'user/message', data: roundMessage(...args) })
const goalSet = (objective, { goalId = 'g1', revision = 1 } = {}) => ({ type: 'goal/change', data: { kind: 'goal/change', version: 1, operation: 'create', goal: { id: goalId, revision, objective, phase: 'active', maxGoalRounds: 256 }, roundsStarted: 0 } })
/** A builder model that cites every message it is shown, so anything it reads would be stored. */
const citesAll = () => scriptedLlm({ reply: (o) => { const n = (o.messages[0].content[0].text.match(/\[m\d+ /g) ?? []).length; return JSON.stringify({ nodes: [{ label: 'everything said', gist: 'all of it', aliases: ['deploy'], kind: 'fact', msgs: Array.from({ length: n }, (_, i) => i) }], edges: [] }) } })
/** dsh's sessionQuery over the test's own logs: other chats' turns are read from there. */
const queryOf = (logs) => ({ async observeSession(sid) { return { events: logs.get(sid).map((e, seq) => ({ ...e, seq })), [Symbol.dispose]: () => {} } } })

test('#69 a /goal chat gets memory: a round is matched by its objective, once per goal revision', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const g = agentOf('sG', cwd, [system(), goalSet('x')])
  const objective = 'set up commit signing with gpg for this repo, like we did before'
  const first = await h.step(g, { kind: 'enter', messages: [roundMessage(objective, 1)] })
  assert.match(blockOf(first), /- c1n1 commit signing/)
  // Compaction drops the block but keeps the round: the next round of that revision is not matched again.
  const block = g.session.log.length - 1
  g.session.compact(block, block)
  g.session.append(assistant('Signing configured.'))
  assert.equal((await h.step(g, { kind: 'enter', messages: [roundMessage(objective, 2)] })).messages.length, 1)
  assert.match(blockOf(await h.step(g, { kind: 'enter', messages: [roundMessage(objective, 3, { revision: 2 })] })), /- c1n1 commit signing/, 'a new revision is')
}))

test('#69 goal rounds count as turns: a goal-only chat is indexed, its objective read once', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  const objective = 'move the CI cache to the new bucket'
  const work = (i) => `Round ${i}: moved part ${i} of the CI cache to the new bucket and checked the hit rate, which held at 92 percent.`
  const g = agentOf('sG', cwd, [system(), goalSet(objective), ...[1, 2, 3, 4].flatMap((i) => turn(i, round(objective, i), says(work(i))))])
  h.listeners['agent/turn-stopping']({ agent: g })
  await until(() => h.llm.calls === 1)
  const prompt = h.llm.prompts[0]
  assert.equal(prompt.split(objective).length - 1, 1, 'the objective once, not once per round')
  assert.match(prompt, /\[m0 user\]\nmove the CI cache[\s\S]*Round 4: moved part 4/)
}))

test('#69 a goal set while memory was off stays private, rounds included, also when they run after on', { skip }, () => inWorkspace(async (cwd) => {
  const { updateMeta } = await import('../../src/store/chats.js')
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = agentOf('sA', cwd, [system(), ...turn(1, user('We deploy on Fridays, decided.'), assistant('ok'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  a.session.append({ type: 'command/run', data: { commandId: 'k1', name: 'goal', args: 'move the SECRET-VAULT keys', source: { kind: 'user' } } })
  a.session.append(goalSet('move the SECRET-VAULT keys'))
  // What `off` then `on` record: the /goal command lies in an off stretch.
  await updateMeta(join(cwd, '.context-graph'), 'sA', (m) => ({ ...m, gaps: [[5, 6]] }))
  for (const e of [...turn(2, round('move the SECRET-VAULT keys', 1), assistant('Moved one SECRET-VAULT key.')), ...turn(3, round('move the SECRET-VAULT keys', 2), assistant('Moved the rest.')), ...turn(4, user('Unrelated: the CI cache key is now v2.'), assistant('ok'))]) a.session.append(e)
  assert.equal((await h.run(a, 'build')).kind, 'success')
  assert.doesNotMatch(h.llm.prompts.at(-1), /SECRET-VAULT|Moved the rest/, 'the model never sees the rounds')
  assert.match(h.llm.prompts.at(-1), /CI cache key is now v2/)
  assert.doesNotMatch(JSON.stringify(await storedOf(cwd, 'sA')), /SECRET-VAULT/)
  assert.deepEqual((await metaOf(cwd, 'sA')).gaps, [[5, 14]], 'the rounds join the stretch they come from')
  const b = agentOf('sB', cwd, [system()])
  assert.equal((await h.recall(b, 'c1t2')).status, 'unknown', 'nor are they served to other chats')
  assert.match((await h.recall(b, 'c1t4')).text, /CI cache key is now v2/)
}))

test('#70 the approved plan and the user\'s answers reach the builder and a recalled turn', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, scriptedLlm({ reply: DEFAULT_REPLY }), { sessionQuery: queryOf(logs) })
  const plan = '# Database layer\n1. Postgres 16 behind pgbouncer in transaction mode\n2. Migrations with sqitch'
  const a = agentOf('sA', cwd, [system(), ...turn(1,
    user('/plan Design the database layer'),
    says('', [['ask_user_question', { questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres 16 with pgbouncer in transaction mode' }, { label: 'MySQL 8' }] }] }, 'q1']]),
    result('q1', { answers: [{ id: 'db', selected: ['Postgres 16 with pgbouncer in transaction mode'] }] }),
    says('', [['exit_plan_mode', { plan }, 'p1']]),
    result('p1', 'Plan approved — plan mode exited; carry out the plan starting with your next step.'),
    says('OK.'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  assert.match(h.llm.prompts[0], /\[m1 user\]\nWhich database\? → Postgres 16 with pgbouncer in transaction mode\n\n\[m2 assistant\]\nPlan:\n# Database layer\n1\. Postgres 16/)
  const recalled = (await h.recall(agentOf('sB', cwd, [system()]), 'c1t1')).text
  assert.match(recalled, /user:\nWhich database\? → Postgres 16[\s\S]*assistant:\nPlan:\n# Database layer[\s\S]*Migrations with sqitch/)
}))

test('#71 turn ids are dsh\'s turn numbers; ids stored by an older count are relabelled at the next build', { skip }, () => inWorkspace(async (cwd) => {
  const logs = new Map()
  const h = await setup({ buildMinChars: 1 }, citesAll(), { sessionQuery: queryOf(logs) })
  const a = agentOf('sA', cwd, [system(),
    ...turn(1, user('pick the signing key type'), assistant('ed25519?')),
    ...turn(2, user('yes'), assistant('Creating it.'), user('and name it id_signing'), assistant('Named it id_signing.'))])
  logs.set('sA', a.session.log)
  await h.run(a, 'build')
  const turns = async () => Object.values((await storedOf(cwd, 'sA')).m).map((m) => m.t)
  assert.deepEqual(await turns(), [1, 1, 2, 2, 2, 2], 'the steer stays in turn 2')
  assert.match((await h.recall(agentOf('sB', cwd, [system()]), 'c1t2')).text, /yes[\s\S]*and name it id_signing[\s\S]*Named it id_signing\./)
  // Ids as 0.9 stored them: every typed prompt counted as a turn.
  const store = await storedOf(cwd, 'sA')
  for (const [i, m] of Object.values(store.m).entries()) m.t = [1, 1, 2, 2, 3, 3][i]
  await writeFile(join(chat(cwd, 'sA'), 'msgs.json'), JSON.stringify(store))
  for (const e of turn(3, user('and the expiry?'), assistant('One year.'))) a.session.append(e)
  await h.run(a, 'build')
  assert.deepEqual(await turns(), [1, 1, 2, 2, 2, 2, 3, 3])
}))

test('#73 a file the model read that lists topic ids does not hide those topics', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system(), user('show me the notes file'), says('', [['bash', { command: 'cat NOTES.md' }, 'b1']]), result('b1', 'Memory export:\n- c1n1 commit signing: an example line'), assistant('Here it is.')])
  assert.match(blockOf(await h.step(b, ask('how do we do commit signing with gpg?'))), /- c1n1 commit signing/)
}))

test('#76 a first message whose words are in no earlier chat gets no chat list; a question about earlier work does', { skip }, () => inWorkspace(async (cwd) => {
  const h = await setup()
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  assert.equal((await h.step(agentOf('sB', cwd, [system()]), ask('what is a good name for my new puppy'))).messages.length, 1, 'nothing at all')
  assert.match(blockOf(await h.step(agentOf('sC', cwd, [system()]), ask('what did we decide about the puppy name?'))), /^\[context-graph\] Earlier chats in this workspace/)
  const related = blockOf(await h.step(agentOf('sD', cwd, [system()]), ask('how do we do commit signing with gpg?')))
  assert.match(related, /^\[context-graph\] Earlier chats in this workspace[\s\S]*- c1n1 commit signing/, 'with the chat\'s first block')
}))

test('#42 a chat left below the build threshold is indexed once quiet, or when a new chat starts', { skip }, () => inWorkspace(async (cwd) => {
  const timers = []
  const timer = { timeout(fn, ms) { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false } } }
  const live = () => timers.filter((t) => t.live)
  const h = await setup({}, scriptedLlm({ reply: DEFAULT_REPLY }), { timer })
  const a = agentOf('sA', cwd, chatEvents(2))
  h.listeners['agent/turn-stopping']({ agent: a })
  const [armed] = await until(() => live().length === 1 && live())
  assert.equal(armed.ms, 1800000)
  assert.equal(h.llm.calls, 0, 'two turns: below the threshold')
  armed.live = false
  armed.fn()
  await until(() => h.llm.calls === 1)
  await until(async () => (await metaOf(cwd, 'sA')).builtSeq === a.session.log.length - 1)

  // A turn starting in the chat cancels the wait. Chat C: chat A waits for its next regular build
  // before it is indexed once quiet again (review of #42, cycle4-review-host.test.js).
  const more = 'One more decision: the signing key is rotated every year in January, by whoever is on call. '.repeat(5)
  const c = agentOf('sC', cwd, [system(), user(more), assistant('Noted.')])
  h.listeners['agent/turn-stopping']({ agent: c })
  await until(() => live().length === 1)
  h.listeners['agent/status']({ agent: c, status: 'running' })
  assert.equal(live().length, 0)

  // A new chat of the workspace starting its first turn: the user has moved on.
  h.listeners['agent/turn-stopping']({ agent: c })
  await until(() => live().length === 1)
  h.listeners['agent/status']({ agent: agentOf('sB', cwd, [system()]), status: 'running' })
  assert.equal(live().length, 0)
  await until(() => h.llm.calls === 2)
  assert.match(h.llm.prompts[1], /rotated every year in January/)
}))
