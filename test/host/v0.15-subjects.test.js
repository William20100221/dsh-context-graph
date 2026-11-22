/**
 * v0.15.0 (#96): indexing names a chat's subject, older chats are sorted into subjects in one call,
 * and a message naming a subject with no matching topic is told which chats hold it.
 *   DSH_NODE_MODULES=<dsh install>/node_modules node --import ./test/helpers/resolve-dsh.mjs --test test/host/v0.15-subjects.test.js
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { updateMeta } from '../../src/store/chats.js'
import { agentOf, ask, chatEvents, scriptedLlm, setup, skip, system, wait } from '../helpers/harness.js'

async function inWorkspace(fn) {
  const cwd = await mkdtemp(join(tmpdir(), 'cg-subjects-'))
  try { await fn(cwd) } finally { await wait(30); await rm(cwd, { recursive: true, force: true, maxRetries: 10 }) }
}

const metaOf = async (cwd, sid) => JSON.parse(await readFile(join(cwd, '.context-graph', 'chats', sid, 'meta.json'), 'utf8'))
const built = (label, extra = {}) => JSON.stringify({ summary: `About ${label}`, ...extra, nodes: [{ id: null, label, gist: `${label}, decided`, aliases: [], kind: 'decision', msgs: [0] }], edges: [] })
const blockOf = (out) => (out.messages.length > 1 ? out.messages.at(-1).content[0].text : '')

test('indexing stores the chat\'s subject, offered the subjects of chats others may draw on, never a private or hidden one\'s (#96)', { skip }, () => inWorkspace(async (cwd) => {
  let next = built('ocean currents', { subject: 'Earth and Space Science' })
  const llm = scriptedLlm({ reply: () => next })
  const h = await setup({}, llm)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  assert.equal((await metaOf(cwd, 'sA')).subject, 'Earth and Space Science')
  next = built('battery limit', { subject: 'Secret project' })
  await h.run(agentOf('sP', cwd, chatEvents(4)), 'build')
  await updateMeta(join(cwd, '.context-graph'), 'sP', (m) => ({ ...m, private: true }))
  next = built('fan curve', { subject: 'Hidden subject' })
  await h.run(agentOf('sH', cwd, chatEvents(4)), 'build')
  await updateMeta(join(cwd, '.context-graph'), 'sH', (m) => ({ ...m, hidden: true }))
  next = built('tides', { subject: 'earth and space science' })
  await h.run(agentOf('sB', cwd, chatEvents(4)), 'build')
  const prompt = llm.prompts.at(-1)
  assert.match(prompt, /Workspace subjects: Earth and Space Science\n/, 'one spelling each, only from chats others may draw on')
  assert.match(prompt, /Current subject: \(none yet\)/)
}))

test('chats indexed before get a subject and type in one call per app run; what their index named stays (#96)', { skip }, () => inWorkspace(async (cwd) => {
  const dir = join(cwd, '.context-graph')
  const sorting = JSON.stringify({ chats: [{ cid: 1, subject: 'Earth and Space Science', type: 'study', project: 'NZQA ESS' }, { cid: 2, subject: 'Laptop care', type: 'setup' }, { cid: 3, subject: 'Must not land', type: 'chat' }] })
  const llm = scriptedLlm({ reply: (options) => (options.messages[0].content[0].text.startsWith('You sort the chats') ? sorting : built('commit signing')) })
  const h = await setup({ _sort: true }, llm)
  for (const sid of ['s1', 's2', 's3']) await h.run(agentOf(sid, cwd, chatEvents(4)), 'build')
  // As older versions left them: no subject; chat 2 had its type; chat 3 is private.
  await updateMeta(dir, 's2', (m) => ({ ...m, type: 'coding' }))
  await updateMeta(dir, 's3', (m) => ({ ...m, private: true }))
  for (const sid of ['s1', 's2', 's3']) await updateMeta(dir, sid, (m) => { const { subject, ...rest } = m; return rest })
  const fresh = await setup({ _sort: true }, llm) // a new app run
  const before = llm.calls
  await fresh.run(agentOf('s4', cwd, chatEvents(4)), 'build')
  await wait(100)
  assert.equal(llm.calls, before + 2, 'the index, then one sorting call')
  const asked = llm.prompts.at(-1)
  assert.match(asked, /^You sort the chats/)
  assert.match(asked, /\nc1 \| [^\n]*commit signing/)
  assert.doesNotMatch(asked, /\nc3 /, 'a private chat is not sent')
  assert.doesNotMatch(asked, /\nc4 /, 'the chat just indexed named its own')
  assert.deepEqual([(await metaOf(cwd, 's1')).subject, (await metaOf(cwd, 's1')).type, (await metaOf(cwd, 's1')).project], ['Earth and Space Science', 'study', 'NZQA ESS'])
  assert.deepEqual([(await metaOf(cwd, 's2')).subject, (await metaOf(cwd, 's2')).type], ['Laptop care', 'coding'], 'the type its index named stays')
  assert.equal((await metaOf(cwd, 's3')).subject, undefined)
  await fresh.run(agentOf('s5', cwd, chatEvents(4)), 'build')
  await wait(100)
  assert.equal(llm.calls, before + 3, 'not again in this run')
}))

test('a question about earlier work that names a subject but matches no topic is told which chats hold it, once (#96)', { skip }, () => inWorkspace(async (cwd) => {
  const llm = scriptedLlm({ reply: built('ocean currents summary', { subject: 'Earth and Space Science' }) })
  const h = await setup({}, llm)
  await h.run(agentOf('sA', cwd, chatEvents(4)), 'build')
  const b = agentOf('sB', cwd, [system()])
  const hint = blockOf(await h.step(b, ask('what did we decide about the earth and space science exam dates?')))
  assert.match(hint, /No topic of earlier chats matches this message/)
  assert.match(hint, /- "Earth and Space Science": c1$/m)
  assert.doesNotMatch(blockOf(await h.step(b, ask('and what did we say about the earth and space science exams before?'))), /No topic of earlier chats/, 'once per subject per chat')
  const c = agentOf('sC', cwd, [system()])
  assert.doesNotMatch(blockOf(await h.step(c, ask('earth and space science is fun'))), /No topic of earlier chats/, 'not for a message that does not ask about earlier work')
  assert.match(blockOf(await h.step(c, ask('what was our earth and space science ocean currents summary?'))), /c1n1 ocean currents summary/, 'a topic found in the subject is sent as usual')
}))
