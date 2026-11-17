/**
 * Reading dsh session events: the human/assistant exchange, turns, titles, and what this plugin has
 * already put into a chat. Pure: callers pass `eventAt(seq)` and surface seqs.
 */

import { SOURCE_KIND } from './chat.js'
import { clipTokens, estimateTokens, sliceChars, textOf } from './text.js'

export const isHuman = (event) => event?.type === 'user/message' && event.data?.source?.kind === 'user'

/**
 * `source.kind` of the user/message events that carry the user's input, however dsh drove it (#69,
 * #70): typed (a steer too), a /goal round, a scheduled reminder, a late answer to a question.
 */
export const PROMPT_KINDS = new Set(['user', 'goal', 'schedule', 'user-question-reply'])
export const isPrompt = (event) => event?.type === 'user/message' && PROMPT_KINDS.has(event.data?.source?.kind)

/** The text of a user or assistant event, as the builder stores it. */
export const eventText = (event) => textOf(event?.data?.content ?? event?.data?.message?.content)

const parse = (text) => { try { return JSON.parse(text) } catch { return undefined } }

// dsh writes these values as JSON on a line of their own: dsh-goal-round-driver and dsh-schedule.
const OBJECTIVE = /^Objective: (.+)$/m
const REMINDER = /^reminder_prompt_json: (.+)$/m
const REMINDERS = /^reminders_json: (.+)$/m
const jsonAt = (re, text) => parse(re.exec(text)?.[1])

/** A reminder's own prompts (dsh frames one, or a batch), trimmed as dsh stores them. */
function reminderPrompts(text) {
  const one = jsonAt(REMINDER, text)
  const batch = jsonAt(REMINDERS, text)
  const prompts = typeof one === 'string' ? [one] : Array.isArray(batch) ? batch.map((r) => r?.reminder_prompt) : []
  return prompts.filter((p) => typeof p === 'string').map((p) => p.trim())
}

/** The user's choices, each after its question when known: "Which database? → Postgres 16" (#70). */
function answersText(answers, questions) {
  if (!Array.isArray(answers)) return ''
  const asked = new Map((Array.isArray(questions) ? questions : []).map((q) => [q?.id, q?.question]))
  return answers.map((a) => {
    const chosen = [...(Array.isArray(a?.selected) ? a.selected : []), a?.custom].filter((s) => typeof s === 'string' && s.trim()).join('; ')
    const question = asked.get(a?.id)
    return chosen && (typeof question === 'string' ? `${question} → ${chosen}` : chosen)
  }).filter(Boolean).join('\n')
}

/**
 * A prompt's words as the builder and the matcher read them (#69, #70): a goal round's objective and
 * a reminder's own prompt without dsh's framing around them, the choices of a late answer.
 */
export function promptText(message) {
  const text = textOf(message?.content)
  switch (message?.source?.kind) {
    case 'goal': {
      const objective = jsonAt(OBJECTIVE, text)
      return typeof objective === 'string' ? objective : text
    }
    case 'schedule': return reminderPrompts(text).join('\n') || text
    case 'user-question-reply': {
      const reply = parse(text)
      return reply ? answersText(reply.answers, reply.questions) : text
    }
    default: return text
  }
}

const argsOf = (block) => (typeof block?.arguments === 'string' ? parse(block.arguments) : block?.arguments) ?? {}

// How dsh-plan-mode's exit_plan_mode result words the user's review: approved, or sent back to
// planning with the user's own words (review of #70).
const APPROVED = /^Plan approved\b/
const SENT_BACK = /^(?:Error: )?The user chose to keep planning; their feedback: ([^]+)$/

const planText = (plan) => (typeof plan === 'string' && plan.trim() ? `Plan:\n${plan.trim()}` : '')

/**
 * An assistant message's text, with each plan it handed to exit_plan_mode that the user approved
 * (`approved(callId)`): dsh keeps the plan only as that call's argument (#70), and a plan the user
 * sent back is not the plan (review).
 */
function assistantText(blocks, approved) {
  const plans = blocks.filter((b) => b?.type === 'tool-call' && b.name === 'exit_plan_mode' && approved(b.id)).map((b) => planText(argsOf(b).plan))
  return [textOf(blocks), ...plans].filter(Boolean).join('\n\n')
}

/**
 * The log event by event, with dsh's own turn numbers (#71) and what stays private (#59, #69).
 * Turns: a message belongs to the turn its `turn/start` opened, so a steer stays in its turn and a
 * goal round or reminder has one of its own; a log without numbered turns counts prompts instead.
 * Private: a seq in `gaps`; a turn whose first prompt is private, as a whole; after a private
 * prompt, the rest of its turn. A prompt is private when typed in a gap or driven from there: a
 * round of a goal that /goal or a goal tool changed in a private stretch, a reminder scheduled
 * there, the answer to a question asked there (one whose goal or question is unknown, too).
 * Each step: { seq, event, turn, start, prompt, hidden, from, role, text }, `from` being where the
 * private stretch of a hidden step starts (a turn made private by its prompt, from its turn/start).
 * Tool calls count however the model made them: as blocks of its message, or under dsh's ptc
 * preset from its run_code program, which dsh logs as tool/ptc-dispatch-start, then (settled, with
 * the result) tool/ptc-dispatch (review of #69, #70). `limit`: the last seq a call's result is
 * looked for at.
 */
function* walk(eventAt, gaps = [], limit = Infinity) {
  const goals = new Map()
  const reminders = new Set()
  const asks = new Map()
  const plans = new Set()
  const drivenFromGap = ({ source, content }) => {
    if (source.kind === 'goal') return goals.get(source.goalId) ?? true
    if (source.kind === 'schedule') return reminderPrompts(textOf(content)).some((p) => reminders.has(p))
    if (source.kind === 'user-question-reply') return asks.get(source.callId)?.hidden ?? true
    return false
  }
  // A tool call, `isHidden` when made in a private stretch.
  const called = (name, args, id, isHidden) => {
    if (name === 'ask_user_question') asks.set(id, { questions: args.questions, hidden: isHidden })
    else if (name === 'exit_plan_mode') plans.add(id)
    // A reminder scheduled in a private stretch stays private when it comes back (#69).
    else if ((name === 'schedule_create' || name === 'schedule_update') && isHidden && typeof args.prompt === 'string') reminders.add(args.prompt.trim())
  }
  // What a call's result holds of the user's own: the answers to ask_user_question (#70), the
  // words a plan was sent back with (review). The only tool output read (#47).
  const answerIn = (id, content) => {
    const ask = asks.get(id)
    if (ask) return answersText(parse(textOf(content))?.answers, ask.questions)
    return plans.has(id) ? SENT_BACK.exec(textOf(content))?.[1].trim() ?? '' : ''
  }
  // Whether the result of exit_plan_mode call `id` (made at `seq`) approves the plan: looked for in
  // the call's turn, up to `limit` and outside the gaps (review of #70).
  const approvedAfter = (seq, id) => {
    for (let s = seq + 1; s <= limit; s++) {
      const e = eventAt(s)
      if (!e || e.type === 'turn/start' || e.type === 'turn/end') return false
      if (e.type === 'tool/result' && e.data?.message?.toolCallId === id) return !inGap(s, gaps) && APPROVED.test(textOf(e.data.message.content))
    }
    return false
  }
  let numbered = false
  let turn
  let turnSeq = -1
  let turnHidden = false
  let hidden = false
  let prompted = false
  for (let seq = 0; ; seq++) {
    const event = eventAt(seq)
    if (!event) return
    const gap = inGap(seq, gaps)
    const prompt = isPrompt(event)
    let start = false
    if (event.type === 'turn/start' && Number.isInteger(event.data?.turn)) { numbered = true; turn = event.data.turn; start = true }
    else if (prompt && !numbered) { turn = (turn ?? 0) + 1; start = true }
    if (start) { turnSeq = seq; turnHidden = gap; hidden = gap; prompted = false }
    let from = seq
    let role
    let text
    if (prompt) {
      const own = gap || drivenFromGap(event.data)
      if (!prompted && own && !turnHidden) { turnHidden = true; from = turnSeq }
      hidden = turnHidden || own
      prompted = true
      role = 'user'
      text = promptText(event.data)
    } else if (event.type === 'assistant/message') {
      const blocks = Array.isArray(event.data?.message?.content) ? event.data.message.content : []
      role = 'assistant'
      text = assistantText(blocks, (id) => approvedAfter(seq, id))
      for (const b of blocks) if (b?.type === 'tool-call') called(b.name, argsOf(b), b.id, gap || hidden)
    } else if (event.type === 'tool/result') {
      const id = event.data?.message?.toolCallId
      text = id === undefined ? '' : answerIn(id, event.data.message.content)
      if (text) role = 'user'
    } else if (event.type === 'tool/ptc-dispatch-start') {
      called(event.data?.name, argsOf(event.data), event.data?.subCallId, gap || hidden)
    } else if (event.type === 'tool/ptc-dispatch') {
      const { name, subCallId, content } = event.data ?? {}
      if (name === 'exit_plan_mode' && APPROVED.test(textOf(content))) {
        role = 'assistant'
        text = planText(argsOf(event.data).plan)
      } else {
        text = answerIn(subCallId, content)
        if (text) role = 'user'
      }
    } else if (event.type === 'goal/change') {
      const id = event.data?.goal?.id ?? event.data?.cleared?.id
      if (id !== undefined) goals.set(id, goals.get(id) === true || gap || hidden)
    }
    const step = { seq, event, turn, start, prompt, hidden: gap || hidden, from, role, text }
    // What comes between turns (a /goal typed then) is judged by the gaps alone.
    if (event.type === 'turn/end') hidden = false
    yield step
  }
}

/**
 * The human/assistant exchange after `afterSeq`, read from the durable session log (seq 0, 1, 2 ...
 * until `eventAt` returns nothing). Not from the surface: dsh compaction replaces old turns on the
 * surface with one checkpoint, and turns that were still waiting to be indexed would be lost (#13).
 * Within one session the log is never edited, so nothing outside the conversation is read.
 * Each message carries its dsh turn number (see walk) and its time. Prompts are what the user
 * typed or dsh drove (a goal round's objective once per goal revision, #69); assistant text
 * includes the plans handed to exit_plan_mode that the user approved, and the user's answers to
 * ask_user_question, or the words a plan was sent back with, are user text (#70, review).
 * `completeOnly`: stop before a turn that is still running (a `turn/start` with no `turn/end` after
 * it), so a build started by a command mid-turn never splits that turn's question from its answer.
 * `gaps`: seq ranges `[from, to]` typed while memory was off; never read, nor what they drove (#59, #69).
 * `titleFrom`: only dsh titles at or after this seq, and made only from prompts at or after it,
 * count: a fork passes its first own prompt, so neither its parent's titles nor the rename dsh
 * gives a new fork ("<parent's title> (1)") nor a title listing inherited prompts is used (#60, review).
 * @returns { messages: [{ seq, role, text, turn, time }], lastSeq, userTurns, turns, title, open, hidden, turnAt }
 *   `userTurns`: turns of the span with a prompt that is not private; `turns`: turns with a prompt
 *   up to the end; `title`: the chat's latest dsh title (model-made, or the user's own rename), if
 *   any (#41); `open`: the span stopped before a running turn; `hidden`: the private stretches of
 *   the whole log, `[from, to]`, the gaps included; `turnAt(seq)`: the turn of any seq of the log.
 */
export function collectSpan(eventAt, afterSeq = -1, { completeOnly = false, gaps = [], titleFrom = 0 } = {}) {
  const all = []
  const prompts = []
  const starts = []
  const hidden = []
  const hiddenPrompts = new Set()
  const objectives = new Set()
  let end = -1
  let openTurn = -1
  let title
  let run
  for (const step of walk(eventAt, gaps)) {
    const { seq, event } = step
    end = seq
    if (step.start) starts.push([seq, step.turn])
    if (step.hidden) {
      if (run && step.from <= run[1] + 1) run[1] = seq
      else hidden.push(run = [step.from, seq])
    }
    if (step.prompt) {
      prompts.push(step)
      if (step.hidden) hiddenPrompts.add(seq)
    }
    if (event.type === 'turn/start') openTurn = seq
    else if (event.type === 'turn/end') openTurn = -1
    else if (event.type === 'session/title' && seq >= titleFrom && typeof event.data?.title === 'string' && event.data.title.trim() && !titleFromGap(event, seq, gaps, hiddenPrompts) && !madeBefore(event, titleFrom)) title = event.data.title.trim()
    let text = step.text
    const source = step.prompt && !step.hidden ? event.data.source : undefined
    if (source?.kind === 'goal') {
      // Every round repeats its goal's objective word for word: read once per goal revision (#69).
      const key = `${source.goalId}:${source.revision}`
      if (objectives.has(key)) text = ''
      objectives.add(key)
    }
    if (text && seq > afterSeq && !step.hidden) all.push({ seq, role: step.role, text, turn: step.turn, time: event.time })
  }
  const limit = completeOnly && openTurn >= 0 ? openTurn - 1 : end
  const turnsOf = (list) => new Set(list.filter((p) => p.seq <= limit).map((p) => p.turn)).size
  return {
    messages: all.filter((m) => m.seq <= limit),
    lastSeq: Math.max(afterSeq, limit),
    userTurns: turnsOf(prompts.filter((p) => !p.hidden && p.seq > afterSeq)),
    turns: turnsOf(prompts),
    title,
    open: completeOnly && openTurn >= 0,
    hidden,
    // Seqs past the log (messages migrated from other sessions) have no turn here.
    turnAt: (seq) => (seq <= end ? starts.findLast(([s]) => s <= seq)?.[1] : undefined)
  }
}

/**
 * A dsh title that comes from what stays private: written in an off stretch, or derived from a
 * prompt typed there or driven from there (`messageSeqs` names the prompts a generated title was
 * made from; #59, #69). Never shown to other chats.
 */
const titleFromGap = (event, seq, gaps, hiddenPrompts) => inGap(seq, gaps) || (Array.isArray(event.data?.messageSeqs) && event.data.messageSeqs.some((s) => inGap(s, gaps) || hiddenPrompts.has(s)))

/** A dsh title made (in part) from prompts before `from`: in a fork, its parent's prompts. */
const madeBefore = (event, from) => Array.isArray(event.data?.messageSeqs) && event.data.messageSeqs.some((s) => s < from)

/** The seq of the first human prompt at or after `from`, or undefined (none yet). */
export function firstPromptSeq(eventAt, from = 0) {
  for (let seq = from; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event)) return seq
  }
}

/** Whether a seq lies in one of the `[from, to]` ranges typed while memory was off (#59). */
export const inGap = (seq, gaps = []) => (Array.isArray(gaps) ? gaps : []).some((g) => Array.isArray(g) && seq >= g[0] && seq <= g[1])

/** The first gap that starts after `seq`, or undefined. */
export const nextGap = (seq, gaps = []) => (Array.isArray(gaps) ? gaps : []).filter((g) => Array.isArray(g) && g[0] > seq).sort((a, b) => a[0] - b[0])[0]

/**
 * `gaps` with `ranges` added, in order, touching ones joined. Past 50 the two oldest merge, also
 * covering the stretch between them: a gap is never dropped (as `on` keeps them).
 */
export function mergeGaps(gaps = [], ranges = []) {
  const out = []
  for (const [from, to] of [...(Array.isArray(gaps) ? gaps : []), ...ranges].filter(Array.isArray).sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to)
    else out.push([from, to])
  }
  while (out.length > 50) out.splice(0, 2, [out[0][0], out[1][1]])
  return out
}

const TOPIC_LINE = /^\s*- (c\d+n\d+) /gm
const RECALLED = /^(?:# |\s*- )(c\d+n\d+) /gm
const RECALL_RESULT = /^(?:# [ct]\d|\[context-graph\])/

/**
 * What this chat already holds in context, read from the surface (so after compaction drops a
 * block, its topics can be sent again):
 *   ids     topics listed in the plugin's blocks, or fetched with recall (#31). Only topic lines
 *           count, never ids inside prose, so an example id cannot hide a real topic (#51).
 *   texts   whole block texts (an identical day digest is not sent twice)
 *   list    whether the chat list (the top layer) is on the surface (#26)
 *   tokens  the plugin's blocks and recall results still in context: what every request of the
 *           chat re-sends as cached input (#35)
 */
export function shownContext(nodes, eventAt) {
  const ids = new Set()
  const texts = new Set()
  let list = false
  let tokens = 0
  for (const seq of nodes) {
    const event = eventAt(seq)
    if (event?.type === 'user/message' && event.data?.source?.kind === SOURCE_KIND) {
      const text = textOf(event.data.content)
      texts.add(text)
      tokens += estimateTokens(text)
      if (event.data.source.layer === 'surface') list = true
      for (const m of text.matchAll(TOPIC_LINE)) ids.add(m[1])
    } else if (event?.type === 'tool/result') {
      const text = textOf(event.data?.message?.content)
      // Only a recall result names what this chat holds: a file or command output with a
      // "- c3n12 ..." line hides no topic, and is not scanned (#73).
      if (!RECALL_RESULT.test(text)) continue
      tokens += estimateTokens(text)
      for (const m of text.matchAll(RECALLED)) ids.add(m[1])
    }
  }
  return { ids, texts, list, tokens }
}

/**
 * The answer of the newest turn: the assistant's text after the last prompt on the surface (a
 * goal round's answer is its own, #69). Used once per turn to see which shown topics the answer
 * actually used (#35).
 */
export function lastAnswer(nodes, eventAt) {
  const parts = []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const event = eventAt(nodes[i])
    if (isPrompt(event)) break
    if (event?.type === 'assistant/message') parts.unshift(textOf(event.data?.message?.content))
  }
  return parts.filter(Boolean).join('\n')
}

/**
 * First human prompt of the log (at or after `from`), shortened: the chat's title until dsh names
 * it; from seq 0 it is also the key fork detection uses, since a fork starts with its parent's log.
 */
export function titleOf(eventAt, width = 60, from = 0, gaps = []) {
  for (let seq = from; ; seq++) {
    const event = eventAt(seq)
    if (!event) return undefined
    if (isHuman(event) && !inGap(seq, gaps)) {
      const text = textOf(event.data.content).replace(/\s+/g, ' ')
      return text.length > width ? `${sliceChars(text, width - 1)}…` : text
    }
  }
}

/** "read_file ×3, bash": tool names in first-use order with counts. */
function toolLine(names) {
  const counts = new Map()
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
  return `[tools: ${[...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ')}]`
}

/**
 * Parts kept within `maxTokens`: the prompt and the final answer first (each clipped if huge), then
 * the steps between them, newest first; the oldest steps that do not fit become one marker.
 */
function fit(parts, maxTokens) {
  const joined = (list) => list.map((p) => p.text).join('\n\n')
  if (estimateTokens(joined(parts)) <= maxTokens) return joined(parts)
  const lastAnswer = parts.findLastIndex((p, i) => i > 0 && p.kind === 'assistant')
  const head = { ...parts[0], text: clipTokens(parts[0].text, Math.floor(maxTokens * 0.35)) }
  const answer = lastAnswer > 0 ? { ...parts[lastAnswer], text: clipTokens(parts[lastAnswer].text, Math.floor(maxTokens * 0.45)) } : undefined
  const after = lastAnswer > 0 ? parts.slice(lastAnswer + 1) : []
  const middle = parts.slice(1, lastAnswer > 0 ? lastAnswer : parts.length)
  let room = maxTokens - estimateTokens(joined([head, ...(answer ? [answer] : []), ...after])) - 16
  const kept = []
  for (let i = middle.length - 1; i >= 0; i--) {
    const cost = estimateTokens(middle[i].text) + 1
    if (cost > room) break
    room -= cost
    kept.unshift(middle[i])
  }
  const dropped = middle.length - kept.length
  const marker = dropped > 0 ? [{ text: `…[${dropped} earlier step${dropped === 1 ? '' : 's'} left out]…` }] : []
  return joined([head, ...marker, ...kept, ...(answer ? [answer] : []), ...after])
}

/** How a recalled turn names a prompt dsh drove rather than one the user typed. */
const DRIVEN = { goal: 'goal', schedule: 'reminder' }

/**
 * Turn `n` as dsh numbers it (#71: from its turn/start to the next one), lean (#47): its prompts,
 * the assistant's text and approved plans, the user's answers to its questions and to its plans
 * (#70, review), and its tool use as one line; tool output is left out (it averaged 9,000 tokens
 * on real logs). Capped at about `maxTokens`.
 * @param limitSeq last seq that may be read: another chat's turn stops at its indexed position.
 * @returns { text, seq, endSeq } or undefined when the log has nothing of turn n at or before `limitSeq`.
 */
export function turnTranscript(eventAt, n, { maxTokens = 2000, limitSeq = Infinity } = {}) {
  const parts = []
  let tools = []
  const flush = () => {
    if (tools.length > 0) parts.push({ kind: 'tools', text: toolLine(tools) })
    tools = []
  }
  let start = -1
  let end = -1
  // A plan's approval past `limitSeq` is not read either.
  for (const step of walk(eventAt, [], limitSeq)) {
    if (step.seq > limitSeq || (start >= 0 && step.start)) break
    if (start < 0 && !(step.start && step.turn === n)) continue
    if (start < 0) start = step.seq
    end = step.seq
    const { event } = step
    if (step.role && (step.text || step.prompt)) {
      flush()
      parts.push({ kind: step.role, text: `${(step.prompt && DRIVEN[event.data.source.kind]) || step.role}:\n${step.text}` })
    }
    const blocks = event.type === 'assistant/message' && Array.isArray(event.data?.message?.content) ? event.data.message.content : []
    for (const b of blocks) if (b?.type === 'tool-call' && b.name) tools.push(b.name)
  }
  flush()
  return parts.length > 0 ? { text: fit(parts, maxTokens), seq: start, endSeq: end } : undefined
}
