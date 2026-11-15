/**
 * Time words in a message: which days it names, and whether it asks about the past. Pure. Days are
 * the machine's local calendar days, computed with calendar arithmetic, so a daylight-saving change
 * can no longer shift a range by an hour (#25).
 */

const dayAt = (now, offset) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset)
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** A real calendar date, or undefined: "2026-02-31" is not March 3 (#25). */
function date(y, m, d) {
  const x = new Date(y, m - 1, d)
  return x.getFullYear() === y && x.getMonth() === m - 1 && x.getDate() === d ? x : undefined
}

const oneDay = (d) => ({ from: d, to: dayAt(d, 1), label: iso(d) })

// Chinese time words count only where they are words: 目前天气 is not 前天, 登上月球 is not 上月,
// 这周期 is not 这周 (#25).
const ZH = {
  dayBefore: /(?<![目之以提从先此日])前天(?!气)/,
  yesterday: /昨天|昨日|昨晚/,
  today: /今天|今早|今日|今晚/,
  daysAgo: /(\d+)\s*天前/,
  lastWeek: /上周(?![期边围])|上星期|上个星期|上礼拜/,
  thisWeek: /(?:本|这)周(?![期边围到全正长])|这星期|这个星期|本星期/,
  lastMonth: /上个月|(?<![登爬马])上月(?![球亮光])/,
  thisMonth: /本月(?!球)|这个月/
}

/**
 * A from/to range (to exclusive) when the text names a time: yesterday, today, N days ago, last/this
 * week or month, 2026-11-01, 2025年11月1日, 11月1日, 昨天, 上周 ... `undefined` otherwise. No model call.
 */
export function parseTimeRange(text, now = new Date()) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  const days = (offset, label, span = 1) => ({ from: dayAt(now, offset), to: dayAt(now, offset + span), label })
  let m
  if ((m = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s))) {
    const d = date(+m[1], +m[2], +m[3])
    if (d) return oneDay(d)
  }
  if ((m = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(s))) {
    // Without a year: this year's date, or last year's when that would still be in the future.
    let d = date(m[1] ? +m[1] : now.getFullYear(), +m[2], +m[3])
    if (d && !m[1] && d > now) d = date(now.getFullYear() - 1, +m[2], +m[3])
    if (d) return oneDay(d)
  }
  if (/\bday before yesterday\b/.test(s) || ZH.dayBefore.test(s)) return days(-2, 'the day before yesterday')
  if (/\byesterday\b/.test(s) || ZH.yesterday.test(s)) return days(-1, 'yesterday')
  if (/\b(?:today|this morning|this afternoon|this evening|tonight)\b/.test(s) || ZH.today.test(s)) return days(0, 'today')
  if ((m = /\b(\d+) days? ago\b/.exec(s)) || (m = ZH.daysAgo.exec(s))) return days(-Number(m[1]), `${m[1]} days ago`)
  const monday = -((now.getDay() + 6) % 7)
  if (/\blast week\b/.test(s) || ZH.lastWeek.test(s)) return days(monday - 7, 'last week', 7)
  if (/\bthis week\b/.test(s) || ZH.thisWeek.test(s)) return days(monday, 'this week', 7)
  const y = now.getFullYear()
  const mo = now.getMonth()
  if (/\blast month\b/.test(s) || ZH.lastMonth.test(s)) return { from: new Date(y, mo - 1, 1), to: new Date(y, mo, 1), label: 'last month' }
  if (/\bthis month\b/.test(s) || ZH.thisMonth.test(s)) return { from: new Date(y, mo, 1), to: new Date(y, mo + 1, 1), label: 'this month' }
  return undefined
}

// Phrases that point at shared earlier work, not bare connectives: "before lunch", "what was the
// score", 今天做了红烧肉 or 帮我总结一下新闻 name a day without asking about this memory.
// Every phrase names "we"/"you" or the conversation itself: "did we win", "the last time I smoked",
// 和朋友聊过 are about life, not about this memory (second review of #24).
const MEMORY_VERB = '(?:decide|decided|discuss|discussed|talk|talked|agree|agreed|choose|chose|pick|picked|fix|fixed|change|changed|try|tried|build|built|write|wrote|set up|settle|settled|say|said|do|did|done|plan|planned|use|used|work on|worked on)'
const PAST_EN = new RegExp(`\\b(?:(?:did|have|had) we (?:already |ever )?${MEMORY_VERB}|we ${MEMORY_VERB}\\b|what (?:did|have) (?:we|you|i) (?:just |already )?${MEMORY_VERB}|last time (?:we|you)|where were we|remind me (?:what|how|why|where|when|which) (?:we|you)|you (?:said|mentioned|suggested))\\b`)
const PAST_ZH = /上次(?:我们|咱们|你|聊|说|讨论|提|定|做|改)|之前(?:我们|咱们|你|说|聊|讨论|提|定|做)|(?:我们|咱们)(?:之前|刚才|上次)|(?:我们|咱们)[^。？?！!]{0,8}(?:聊|讨论|定|决定|说|谈)(?:过|了|的)|刚才(?:说|聊|提|讨论)|(?:说|聊|讨论|提到)的那个|(?:聊|讨论|做|干)了(?:什么|哪些|啥)|那天(?:我们|聊|说)/

/**
 * Whether a message asks about earlier work in this memory ("what did we do", "last time", 之前我们,
 * 上次). Only such a message gets a day digest: "today I want to learn rust" names a day but is not
 * about memory (#24).
 */
export function asksAboutPast(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  return PAST_EN.test(s) || PAST_ZH.test(s)
}

export const inRange = (iso, range) => Boolean(iso) && new Date(iso) >= range.from && new Date(iso) < range.to

/** A chat overlaps the range when it was active at any point inside it. */
export const chatInRange = (meta, range) => Boolean(meta?.startedAt) && new Date(meta.startedAt) < range.to && new Date(meta.lastActiveAt ?? meta.startedAt) >= range.from

/** Local calendar day (YYYY-MM-DD) of a timestamp, the same day recall("YYYY-MM-DD") and "today" search. */
export function day(value) {
  const d = new Date(value ?? NaN)
  return Number.isNaN(+d) ? '' : iso(d)
}
