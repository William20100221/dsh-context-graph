/**
 * Core tests for the review of v0.10.0 (privacy lens): tool calls made from run_code under dsh's
 * ptc preset (K1), a plan the user sent back in plan mode (R1). Each fails without its fix.
 *   node --test test/core/cycle4-review-privacy.test.js
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { collectSpan, turnTranscript } from '../../src/core/session.js'

const system = { type: 'system/message', data: {} }
const user = (text, kind = 'user', source = {}) => ({ type: 'user/message', data: { source: { kind, ...source }, content: [{ type: 'text', text }] } })
const says = (text, calls = []) => ({ type: 'assistant/message', data: { message: { content: [...(text ? [{ type: 'text', text }] : []), ...calls.map(([name, args, id]) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) }))] } } })
const result = (id, value) => ({ type: 'tool/result', data: { message: { toolCallId: id, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } } })
const turn = (n, ...events) => [{ type: 'turn/start', data: { turn: n } }, ...events, { type: 'turn/end', data: { turn: n } }]
// As dsh-schedule frames a due reminder, and dsh-user-questions steers a late answer in.
const reminder = (prompt) => user(`[SCHEDULE REMINDER]\nThis is a scheduled message from the user\nschedule_id_json: "schedule-1"\noccurrence_at: 2026-11-18T09:00:00.000Z\nreminder_prompt_json: ${JSON.stringify(prompt)}`, 'schedule')
const reply = (callId, questions, answers) => user(JSON.stringify({ kind: 'answer_to_pending_question', tool: 'ask_user_question', callId, questions, answers }), 'user-question-reply', { callId, outcome: 'answered' })
// Under the ptc preset the model calls only run_code; dsh-tools logs each call its program makes
// (dsh-tools lib/index.js 1400-1430): these shapes are copied from a real run_code run.
const runCode = (id, name) => says('', [['run_code', { code: `return await tools.${name}(args)`, description: name }, id]])
const ptc = (callId, name, args, value, isError = false) => {
  const sub = { rootCallId: callId, parentCallId: callId, subCallId: `${callId}:ptc:1`, name, arguments: args }
  return [
    { type: 'tool/ptc-dispatch-start', data: sub },
    { type: 'tool/ptc-dispatch', data: { ...sub, isError, content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }] } }
  ]
}
// dsh-plan-mode's results: approved, sent back with the user's words, sent back without.
const APPROVED = 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
const SENT_BACK = 'Error: The user chose to keep planning; their feedback: No MongoDB, we standardise on Postgres.'

test('K1 under the ptc preset, a reminder scheduled from run_code while memory is off stays private when it fires after on', () => {
  const prompt = 'rotate the vault, passphrase SECRET-42'
  const log = [
    system,
    ...turn(1, user('Our release runbook and the CI pipeline.'), says('Noted.')), // 1-4
    ...turn(2, user(`remind me in 10 minutes: ${prompt}`), runCode('c1', 'schedule_create'), ...ptc('c1', 'schedule_create', { title: 'Vault', prompt, after_seconds: 600 }, { id: 's1' }),
      result('c1', '(run_code completed with no output)'), says('Reminder set.')), // 5-12: typed while off
    ...turn(3, reminder(prompt), says('Rotated the vault as reminded.')), // 13-16
    ...turn(4, reminder('Water the plants'), says('Watered.')) // 17-20
  ]
  const span = collectSpan((s) => log[s], 4, { gaps: [[5, 12]] })
  assert.deepEqual(span.messages.map((m) => m.text), ['Water the plants', 'Watered.'])
  assert.deepEqual(span.hidden, [[5, 16]], 'the reminder\'s turn joins the stretch it was scheduled in')
})

test('K1 under the ptc preset, the approved plan and the user\'s answers come from run_code\'s calls; a question asked there is answered late in the open, or privately', () => {
  const questions = [{ id: 'db', question: 'Which database?' }]
  const log = [
    system,
    ...turn(1,
      user('Design the database layer'), // 2
      runCode('c1', 'ask_user_question'), ...ptc('c1', 'ask_user_question', { questions }, { answers: [{ id: 'db', selected: ['Postgres 16'] }] }), // 3-5
      result('c1', { answers: [{ id: 'db', selected: ['the program\'s own value, never read'] }] }), // 6
      runCode('c2', 'exit_plan_mode'), ...ptc('c2', 'exit_plan_mode', { plan: '# Plan B\nPostgres 16 behind pgbouncer' }, APPROVED), result('c2', { approved: true }), // 7-10
      runCode('c3', 'ask_user_question'), ...ptc('c3', 'ask_user_question', { questions: [{ id: 'k', question: 'Rotate keys?' }] }, { pending: true, callId: 'c3:ptc:1', message: 'No answer batch arrived before the timeout.' }), // 11-13
      says('Implementing Plan B.')), // 14
    ...turn(2, reply('c3:ptc:1', [{ id: 'k', question: 'Rotate keys?' }], [{ id: 'k', selected: ['Yearly'] }]), says('Yearly it is.'))
  ]
  const eventAt = (s) => log[s]
  assert.deepEqual(collectSpan(eventAt).messages.map((m) => [m.role, m.text]), [
    ['user', 'Design the database layer'],
    ['user', 'Which database? → Postgres 16'],
    ['assistant', 'Plan:\n# Plan B\nPostgres 16 behind pgbouncer'],
    ['assistant', 'Implementing Plan B.'],
    ['user', 'Rotate keys? → Yearly'],
    ['assistant', 'Yearly it is.']
  ])
  assert.equal(turnTranscript(eventAt, 1).text, 'user:\nDesign the database layer\n\n[tools: run_code]\n\nuser:\nWhich database? → Postgres 16\n\n[tools: run_code]\n\nassistant:\nPlan:\n# Plan B\nPostgres 16 behind pgbouncer\n\n[tools: run_code]\n\nassistant:\nImplementing Plan B.')
  // The same question asked while memory was off: its late answer stays private.
  assert.deepEqual(collectSpan(eventAt, -1, { gaps: [[11, 13]] }).messages.map((m) => m.text).slice(-2), ['Plan:\n# Plan B\nPostgres 16 behind pgbouncer', 'Implementing Plan B.'])
})

test('R1 a plan the user sent back is not read as the plan; the words it was sent back with are the user\'s', () => {
  const log = [
    system,
    ...turn(1,
      user('Design the database layer'), // 2
      says('', [['exit_plan_mode', { plan: '# Plan A\nMongoDB 7, one collection per tenant' }, 'p1']]), result('p1', SENT_BACK), // 3-4
      says('', [['exit_plan_mode', { plan: '# Plan C\nMySQL 8' }, 'p2']]), result('p2', 'Error: The user chose to keep planning; revise the plan and present it again.'), // 5-6
      says('', [['exit_plan_mode', { plan: '# Plan B\nPostgres 16' }, 'p3']]), result('p3', APPROVED), // 7-8
      says('OK.')), // 9
    ...turn(2, user('/plan again'), runCode('c1', 'exit_plan_mode'), ...ptc('c1', 'exit_plan_mode', { plan: '# Plan D\nSQLite' }, SENT_BACK, true), says('Revising.'))
  ]
  const eventAt = (s) => log[s]
  assert.deepEqual(collectSpan(eventAt).messages.map((m) => [m.role, m.text]), [
    ['user', 'Design the database layer'],
    ['user', 'No MongoDB, we standardise on Postgres.'],
    ['assistant', 'Plan:\n# Plan B\nPostgres 16'],
    ['assistant', 'OK.'],
    ['user', '/plan again'],
    ['user', 'No MongoDB, we standardise on Postgres.'],
    ['assistant', 'Revising.']
  ])
  assert.equal(turnTranscript(eventAt, 1).text, 'user:\nDesign the database layer\n\n[tools: exit_plan_mode]\n\nuser:\nNo MongoDB, we standardise on Postgres.\n\n[tools: exit_plan_mode]\n\nassistant:\nPlan:\n# Plan B\nPostgres 16\n\n[tools: exit_plan_mode]\n\nassistant:\nOK.')
  // An approval that may not be read (past another chat's indexed position, in an off stretch) approves nothing.
  assert.doesNotMatch(turnTranscript(eventAt, 1, { limitSeq: 7 }).text, /Plan B/)
  assert.doesNotMatch(collectSpan(eventAt, -1, { gaps: [[8, 8]] }).messages.map((m) => m.text).join('\n'), /Plan B/)
})
