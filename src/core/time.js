/**
 * Time: the first filter when a message names a day. Pure; dates are the machine's local days.
 */

const DAY = 86400000
const dayStart = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

/**
 * A from/to range (to exclusive) when the text names a time: yesterday, today, N days ago, last/this
 * week or month, 2026-11-01, 11月1日, 昨天, 上周 ... `undefined` otherwise. No model call.
 */
export function parseTimeRange(text, now = new Date()) {
  const s = String(text ?? '').toLowerCase()
  const today = dayStart(now)
  const days = (offset, label, span = 1) => ({ from: new Date(+today + offset * DAY), to: new Date(+today + (offset + span) * DAY), label })
  let m
  if ((m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(s))) {
    const d = new Date(+m[1], +m[2] - 1, +m[3])
    return { from: d, to: new Date(+d + DAY), label: m[0] }
  }
  if ((m = /(\d{1,2})月(\d{1,2})[日号]/.exec(s))) {
    const d = new Date(now.getFullYear(), +m[1] - 1, +m[2])
    if (d > now) d.setFullYear(d.getFullYear() - 1)
    return { from: d, to: new Date(+d + DAY), label: m[0] }
  }
  if (/day before yesterday|前天/.test(s)) return days(-2, 'the day before yesterday')
  if (/\byesterday\b|昨天|昨日/.test(s)) return days(-1, 'yesterday')
  if (/\btoday\b|this morning|今天|今早|今日/.test(s)) return days(0, 'today')
  if ((m = /\b(\d+) days? ago\b/.exec(s)) || (m = /(\d+)天前/.exec(s))) return days(-Number(m[1]), m[0])
  const monday = new Date(+today - ((today.getDay() + 6) % 7) * DAY)
  if (/\blast week\b|上周|上星期|上个星期/.test(s)) return { from: new Date(+monday - 7 * DAY), to: monday, label: 'last week' }
  if (/\bthis week\b|本周|这周|这星期|这个星期/.test(s)) return { from: monday, to: new Date(+monday + 7 * DAY), label: 'this week' }
  if (/\blast month\b|上个月|上月/.test(s)) {
    return { from: new Date(now.getFullYear(), now.getMonth() - 1, 1), to: new Date(now.getFullYear(), now.getMonth(), 1), label: 'last month' }
  }
  if (/\bthis month\b|本月|这个月/.test(s)) {
    return { from: new Date(now.getFullYear(), now.getMonth(), 1), to: new Date(now.getFullYear(), now.getMonth() + 1, 1), label: 'this month' }
  }
  return undefined
}

export const inRange = (iso, range) => Boolean(iso) && new Date(iso) >= range.from && new Date(iso) < range.to

/** A chat overlaps the range when it was active at any point inside it. */
export const chatInRange = (meta, range) => Boolean(meta?.startedAt) && new Date(meta.startedAt) < range.to && new Date(meta.lastActiveAt ?? meta.startedAt) >= range.from

/** Local calendar day (YYYY-MM-DD) of a timestamp, the same day recall("YYYY-MM-DD") and "today" search. */
export function day(iso) {
  const d = new Date(iso ?? NaN)
  if (Number.isNaN(+d)) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
