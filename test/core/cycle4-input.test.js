/**
 * Core tests for the cycle-4 input fixes (v0.10.0): what dsh drives besides typed prompts (#69, #70),
 * dsh's own turn numbers (#71), what counts as shown (#73), the chat list's evidence (#76).
 *   node --test test/core/cycle4-input.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { emptyGraph, mergeDelta } from '../../src/core/graph.js'
import { renderChats } from '../../src/core/render.js'
import { collectSpan, mergeGaps, promptText, shownContext, turnTranscript } from '../../src/core/session.js'

const system = { type: 'system/message', data: {} }
const user = (text, kind = 'user', source = {}) => ({ type: 'user/message', data: { source: { kind, ...source }, content: [{ type: 'text', text }] } })
const says = (text, calls = []) => ({ type: 'assistant/message', data: { message: { content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(([name, args, id]) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))] } } })
const result = (id, value) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } })
const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
// As dsh-goal-round-driver and dsh-goal write them.
const round = (objective, n, { goalId = 'g1', revision = 1 } = {}) => user(`<goal_round>\nObjective: ${JSON.stringify(objective)}\nRound: ${n}/256\n\nContinue working toward the objective in this same session.\n</goal_round>`, 'goal', { goalId, revision, round: n })
const goalSet = (objective, { goalId = 'g1', revision = 1, operation = 'create' } = {}) => ({ type: 'goal/change', data: { kind: 'goal/change', version: 1, operation, goal: { id: goalId, revision, objective, phase: 'active', maxGoalRounds: 256 }, roundsStarted: 0 } })
// As dsh-schedule frames a due reminder.
const reminder = (prompt) => user(`[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-11-18T09:00:00.000Z\nreminder_prompt_json: ${JSON.stringify(prompt)}`, 'schedule')
// As dsh-user-questions steers a late answer in.
const reply = (callId, questions, answers) => user(JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions, answers }), 'user-question-reply', { callId, outcome: 'answered' })

test('#71 turns follow dsh\'s turn/start numbers: a steer stays in its turn, a goal round has its own', () => {
  const log = [
    system,
    ...turn(1, user('set up the deploy key'), says('Checking.', [['bash', { cmd: 'ls' }, 'c1']]), result('c1', 'out'), user('use ed25519, not rsa'), says('Done with ed25519.')),
    goalSet('rotate the deploy key yearly'),
    ...turn(2, round('rotate the deploy key yearly', 1), says('Rotation scheduled.')),
    ...turn(3, user('thanks'), says('You are welcome.'))
  ]
  const eventAt = (s) => log[s]
  const span = collectSpan(eventAt)
  assert.deepEqual(span.messages.map((m) => [m.text, m.turn]), [
    ['set up the deploy key', 1], ['Checking.', 1], ['use ed25519, not rsa', 1], ['Done with ed25519.', 1],
    ['rotate the deploy key yearly', 2], ['Rotation scheduled.', 2], ['thanks', 3], ['You are welcome.', 3]
  ])
  assert.equal(span.userTurns, 3)
  assert.deepEqual([span.turnAt(6), span.turnAt(11), span.turnAt(999)], [1, 2, undefined], 'any seq of the log has its turn; none past it')
  assert.equal(turnTranscript(eventAt, 1).text, 'user:\nset up the deploy key\n\nassistant:\nChecking.\n\n[tools: bash]\n\nuser:\nuse ed25519, not rsa\n\nassistant:\nDone with ed25519.', 'the steer and its answer stay in turn 1')
  assert.equal(turnTranscript(eventAt, 2).text, 'goal:\nrotate the deploy key yearly\n\nassistant:\nRotation scheduled.')
  assert.deepEqual([turnTranscript(eventAt, 3).seq, turnTranscript(eventAt, 3).endSeq], [13, 16])
  assert.equal(turnTranscript(eventAt, 4), undefined)
})

test('#69 goal rounds and reminders are prompts and turns; a goal\'s objective is read once per revision', () => {
  const objective = 'ship the parquet export'
  const log = [
    system, goalSet(objective),
    ...turn(1, round(objective, 1), says('Wrote the writer.')),
    ...turn(2, round(objective, 2), says('Tests pass.')),
    goalSet(objective, { revision: 2, operation: 'resume' }),
    ...turn(3, round(objective, 3, { revision: 2 }), says('Released.')),
    ...turn(4, reminder('Check that the nightly export ran'), says('It ran.'))
  ]
  const span = collectSpan((s) => log[s])
  assert.deepEqual(span.messages.filter((m) => m.role === 'user').map((m) => [m.text, m.turn]), [[objective, 1], [objective, 3], ['Check that the nightly export ran', 4]])
  assert.equal(span.userTurns, 4, 'every round and the reminder count toward the build threshold')
  assert.equal(promptText(log[3].data), objective, 'the matcher reads the objective, not dsh\'s framing')
})

test('#69 what dsh drives from an off stretch stays private: a goal set there, a reminder scheduled there, the answer to a question asked there', () => {
  const log = [
    system,
    ...turn(1, user('normal question'), says('normal answer')), // 1-4
    goalSet('move the SECRET-VAULT keys'), // 5: /goal typed while off
    ...turn(2, user('remind me about the SECRET audit'), says('Scheduled.', [['schedule_create', { prompt: ' Check the SECRET audit ', title: 'audit', after_seconds: 60 }, 's1']]), result('s1', '{}'),
      says('', [['ask_user_question', { questions: [{ id: 'v', question: 'Which SECRET vault?' }] }, 'q1']]), result('q1', { pending: true })), // 6-12: typed while off
    ...turn(3, round('move the SECRET-VAULT keys', 1), says('Moved one SECRET key.'), user('steer typed after on'), says('ok')), // 13-18
    ...turn(4, reminder('Check the SECRET audit'), says('SECRET audit checked.')), // 19-22
    ...turn(5, reply('q1', [{ id: 'v', question: 'Which SECRET vault?' }], [{ id: 'v', selected: ['the SECRET one'] }]), says('Using it.')), // 23-26
    goalSet('publish the docs', { goalId: 'g2' }), // 27: /goal typed with memory on, right after a private turn
    ...turn(6, reminder('Water the plants'), says('Watered.')), // 28-31
    ...turn(7, round('publish the docs', 1, { goalId: 'g2' }), says('Docs published.')) // 32-35
  ]
  const span = collectSpan((s) => log[s], -1, { gaps: [[5, 12]] })
  assert.deepEqual(span.messages.map((m) => m.text), ['normal question', 'normal answer', 'Water the plants', 'Watered.', 'publish the docs', 'Docs published.'])
  assert.equal(span.userTurns, 3)
  assert.deepEqual(span.hidden, [[5, 26]], 'whole turns, from their turn/start, next to the gap they come from')
  assert.deepEqual(mergeGaps([[5, 12]], span.hidden), [[5, 26]])
  assert.deepEqual(mergeGaps([[1, 2], [9, 9]], [[3, 4], [20, 30]]), [[1, 4], [9, 9], [20, 30]])
  const title = { type: 'session/title', data: { title: 'Moving the SECRET-VAULT keys', messageSeqs: [14] } }
  assert.equal(collectSpan((s) => [...log, title][s], -1, { gaps: [[5, 12]] }).title, undefined, 'nor a dsh title made from such a round')
})

test('#70 the plan handed to exit_plan_mode and the user\'s answers to ask_user_question are read, in the span and in a turn', () => {
  const plan = '# Database layer\n1. Postgres 16\n2. pgbouncer in transaction mode'
  const log = [
    system,
    ...turn(1,
      user('Design the database layer'),
      says('I need one answer first.', [['ask_user_question', { questions: [{ id: 'db', question: 'Which database?', options: [{ label: 'Postgres 16' }, { label: 'MySQL 8' }] }] }, 'q1']]),
      result('q1', { answers: [{ id: 'db', selected: ['Postgres 16'], custom: 'with pgbouncer' }] }),
      says('', [['exit_plan_mode', { plan }, 'p1']]),
      result('p1', 'Plan approved — plan mode exited; carry out the plan starting with your next step.'),
      says('OK.'))
  ]
  const span = collectSpan((s) => log[s])
  assert.deepEqual(span.messages.map((m) => [m.role, m.text]), [
    ['user', 'Design the database layer'],
    ['assistant', 'I need one answer first.'],
    ['user', 'Which database? → Postgres 16; with pgbouncer'],
    ['assistant', `Plan:\n${plan}`],
    ['assistant', 'OK.']
  ])
  assert.equal(span.userTurns, 1, 'an answer is not a turn of its own')
  assert.equal(turnTranscript((s) => log[s], 1).text, `user:\nDesign the database layer\n\nassistant:\nI need one answer first.\n\n[tools: ask_user_question]\n\nuser:\nWhich database? → Postgres 16; with pgbouncer\n\nassistant:\nPlan:\n${plan}\n\n[tools: exit_plan_mode]\n\nassistant:\nOK.`)
  assert.equal(promptText(reply('q2', [{ id: 'k', question: 'Rotate keys?' }], [{ id: 'k', selected: ['Yearly'] }]).data), 'Rotate keys? → Yearly', 'a late answer, as the matcher reads it')
})

test('#73 only recall results count as shown: a file that lists topic ids hides nothing', () => {
  const log = [
    result('r1', '# Notes\n- c3n12 commit signing: an example line\n  - c2n1 another'),
    result('r2', '# c4n7 Some topic\nfact. gist')
  ]
  const shown = shownContext([0, 1], (s) => log[s])
  assert.deepEqual([...shown.ids], ['c4n7'])
})

test('#76 the chat list is left out for a message whose words are in no earlier chat', () => {
  const graph = emptyGraph()
  mergeDelta(graph, { nodes: [{ label: 'commit signing', gist: 'signed with id_ed25519_signing', aliases: ['gpg'], kind: 'decision', msgs: [0] }], edges: [] }, { now: 'T' })
  const views = [{ sid: 'a', cid: 1, meta: { title: 'SSH commit signing', lastActiveAt: 'T' }, graph, own: false }]
  assert.equal(renderChats(views, { prompt: 'what is a good name for my new puppy', related: true }), '')
  assert.match(renderChats(views, { prompt: 'what is a good name for my new puppy' }), /^\[context-graph\] Earlier chats/, 'unchanged without the evidence check')
  assert.match(renderChats(views, { prompt: 'can you check the gpg setup?', related: true }), /\nc1 SSH commit signing/)
  assert.match(renderChats(views, { prompt: 'hello', related: true }), /\nc1 /, 'no words to judge by: listed as before')
})
