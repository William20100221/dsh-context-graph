/**
 * Chat numbers after a renumbering (#109): existing chats are numbered 1..N, so ids sent before
 * (c14n2, c14t3, c14) may now mean another chat or none. Pure helpers: map an old id to its new
 * one, and the note that tells a chat which numbers changed.
 */

import { day } from './time.js'

/** Old id -> new id after one renumbering (`moves` [{ from, to }], `gone`); undefined for a deleted chat's. */
export function idMapper({ moves, gone }) {
  const to = new Map(moves.map((m) => [m.from, m.to]))
  const dropped = new Set(gone)
  return (value) => {
    const m = /^c(\d+)(.*)$/.exec(String(value))
    if (!m) return value
    const n = Number(m[1])
    if (to.has(n)) return `c${to.get(n)}${m[2]}`
    return dropped.has(n) ? undefined : value
  }
}

/** Numbers as runs: [12, 14, 15, 16] -> ['c12', 'c14–c16']. */
const runs = (numbers) => {
  const out = []
  for (const n of [...numbers].sort((a, b) => a - b)) {
    const last = out.at(-1)
    if (last && n === last[1] + 1) last[1] = n
    else out.push([n, n])
  }
  return out.map(([a, b]) => (a === b ? `c${a}` : `c${a}–c${b}`))
}

/** Moves as runs: [[14, 2], [15, 3], [16, 4]] -> ['c14–c16→c2–c4']. */
const moveRuns = (moves) => {
  const out = []
  for (const [from, to] of [...moves].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1)
    if (last && from === last.from[1] + 1 && to === last.to[1] + 1) { last.from[1] = from; last.to[1] = to } else out.push({ from: [from, from], to: [to, to] })
  }
  const span = ([a, b]) => (a === b ? `c${a}` : `c${a}–c${b}`)
  return out.map((r) => `${span(r.from)}→${span(r.to)}`)
}

/** The renumberings a chat that began at `since` (ms) has not seen numbers after: those after it. */
export const renumberedSince = (events, since) => (Number.isFinite(since) ? events.filter((e) => e.at > since) : [])

/** Whether chat number `n` means something else after any of `events`. */
export const renumberedNumber = (events, n) => events.some((e) => e.gone.includes(n) || e.moves.some(([from]) => from === n))

/**
 * The note telling a chat that numbers changed after it began, or undefined. One line per
 * renumbering, oldest first, with its day: the chat's own messages carry the time they were sent.
 */
export function renumberNotice(events) {
  if (events.length === 0) return undefined
  const lines = events.map((e) => {
    const parts = [...(e.moves.length ? [moveRuns(e.moves).join(', ')] : []), ...(e.gone.length ? [`removed ${runs(e.gone).join(', ')}`] : [])]
    return `${day(e.at)}: ${parts.join('; ')}`
  })
  return `[context-graph] Chat numbers were renumbered after chats' memory was deleted; ids from before that in this chat use the old numbers. ${lines.join(' · ')}.`
}
