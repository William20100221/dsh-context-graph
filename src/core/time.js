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

/** A date named without a year: this year's, or last year's when this year's is still ahead. */
function pastDate(now, year, month, d) {
  const x = date(year ? +year : now.getFullYear(), month, d)
  return x && !year && x > now ? date(now.getFullYear() - 1, month, d) : x
}

const oneDay = (d) => ({ from: d, to: dayAt(d, 1), label: iso(d) })

// Chinese time words count only where they are words: 目前天气 is not 前天, 登上月球 is not 上月,
// 这周期 is not 这周 (#25). 大前天 is not 前天, 上上周 is not 上周, 二十天前 is not 十天前 (#84).
// 两天前端 is frontend and 三天前后 about three days, not 2 or 3 days ago (review of #84); 3天前端口
// and 3天前后端 still are (second review).
const ZH = {
  threeDaysAgo: /大前天/,
  dayBefore: /(?<![目之以提从先此日])前天(?!气)/,
  yesterday: /昨天|昨日|昨晚/,
  today: /今天|今早|今日|今晚/,
  ago: /(?<![这那了续一两二三四五六七八九十\d])(\d+|[一两二三四五六七八九十])\s*(天|周|个?星期|个?礼拜)前(?!端(?!口)|后(?![端台]))/,
  weekBeforeLast: /上上(?:周|个?星期|个?礼拜)/,
  lastWeek: /上周(?![期边围])|上星期|上个星期|上礼拜/,
  thisWeek: /(?:本|这)周(?![期边围到全正长])|这星期|这个星期|本星期/,
  monthBeforeLast: /上上个?月(?![球亮光])/,
  lastMonth: /上个月|(?<![登爬马])上月(?![球亮光])/,
  thisMonth: /本月(?!球)|这个月/
}

// "two days ago", "a week ago", "nov 3", "on monday" (#84). Whole month names only: "market 5" and
// "decided 3" are not dates. "1.5 weeks ago" is not 5 weeks ago (review of #84).
const NUMBER = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
const AGO = /\b((?<!\.)\d+|an?|one|two|three|four|five|six|seven|eight|nine|ten) (day|week)s? ago\b/
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const MONTH_DAY = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.? (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?\b/
const ON_MONTH_DAY = new RegExp(`\\bon ${MONTH_DAY.source.slice(2)}`)
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const ON_WEEKDAY = new RegExp(`\\b(?:on|last) (${WEEKDAYS.join('|')})\\b`)

/**
 * A from/to range (to exclusive) when the text names a time: yesterday, last night, today, N days or
 * weeks ago, last/this week or month, on monday, nov 3, 2026-11-01, 2025年11月1日, 11月1日, 昨天,
 * 大前天, 三天前, 上周, 上上周 ... `undefined` otherwise. No model call.
 */
export function parseTimeRange(text, now = new Date()) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  const days = (offset, label, span = 1) => ({ from: dayAt(now, offset), to: dayAt(now, offset + span), label })
  const monday = -((now.getDay() + 6) % 7)
  const weeksAgo = (n) => days(monday - 7 * n, n === 1 ? 'last week' : `${n} weeks ago`, 7)
  const y = now.getFullYear()
  const mo = now.getMonth()
  const monthsAgo = (n, label) => ({ from: new Date(y, mo - n, 1), to: new Date(y, mo - n + 1, 1), label })
  let m
  if ((m = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(s))) {
    const d = date(+m[1], +m[2], +m[3])
    if (d) return oneDay(d)
  }
  if ((m = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(s))) {
    const d = pastDate(now, m[1], +m[2], +m[3])
    if (d) return oneDay(d)
  }
  // "on nov 10" is the day asked about, also in "... on nov 10? I need it for today's standup" (second
  // review), when it is past: "yesterday ... the launch on dec 3" asks about yesterday (third check).
  if ((m = ON_MONTH_DAY.exec(s))) {
    const d = date(m[3] ? +m[3] : now.getFullYear(), MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2])
    if (d && d <= now) return oneDay(d)
  }
  if (ZH.threeDaysAgo.test(s)) return days(-3, '3 days ago')
  if (/\bday before yesterday\b/.test(s) || ZH.dayBefore.test(s)) return days(-2, 'the day before yesterday')
  if (/\b(?:yesterday|last night)\b/.test(s) || ZH.yesterday.test(s)) return days(-1, 'yesterday')
  if (/\b(?:today|this morning|this afternoon|this evening|tonight)\b/.test(s) || ZH.today.test(s)) return days(0, 'today')
  if ((m = AGO.exec(s) ?? ZH.ago.exec(s))) {
    const n = NUMBER[m[1]] ?? Number(m[1])
    // "a week ago" is fuzzy: the whole calendar week it falls in, like "last week".
    return m[2] === 'day' || m[2] === '天' ? days(-n, `${n} days ago`) : weeksAgo(n)
  }
  if (ZH.weekBeforeLast.test(s)) return weeksAgo(2)
  if (/\blast week\b/.test(s) || ZH.lastWeek.test(s)) return weeksAgo(1)
  if (/\bthis week\b/.test(s) || ZH.thisWeek.test(s)) return days(monday, 'this week', 7)
  if (ZH.monthBeforeLast.test(s)) return monthsAgo(2, '2 months ago')
  if (/\blast month\b/.test(s) || ZH.lastMonth.test(s)) return monthsAgo(1, 'last month')
  if (/\bthis month\b/.test(s) || ZH.thisMonth.test(s)) return monthsAgo(0, 'this month')
  // After the phrases above: "on monday last week" is last week. The weekday is the latest one before today.
  if ((m = ON_WEEKDAY.exec(s))) return oneDay(dayAt(now, -((now.getDay() - WEEKDAYS.indexOf(m[1]) + 7) % 7 || 7)))
  // Last: a month date is often what the talk was about, "the may 1 launch last week" (review of #84).
  if ((m = MONTH_DAY.exec(s))) {
    const d = pastDate(now, m[3], MONTHS.indexOf(m[1].slice(0, 3)) + 1, +m[2])
    if (d) return oneDay(d)
  }
  return undefined
}

// Phrases that point at shared earlier work, not bare connectives: "before lunch", "what was the
// score", 今天做了红烧肉 or 帮我总结一下新闻 name a day without asking about this memory.
// Every phrase names "we"/"you" or the conversation itself: "did we win", "the last time I smoked",
// 和朋友聊过 are about life, not about this memory (second review of #24).
const MEMORY_VERB = '(?:decide|decided|discuss|discussed|talk|talked|agree|agreed|choose|chose|pick|picked|fix|fixed|change|changed|try|tried|build|built|write|wrote|set up|settle|settled|say|said|do|did|done|plan|planned|use|used|work on|worked on)'
// "what did I do wrong" asks for a diagnosis, not for this memory (review of #80).
const PAST_EN = new RegExp(`\\b(?:(?:did|have|had) we (?:already |ever )?${MEMORY_VERB}|what (?:did|have) (?:we|you|i) (?:just |already )?${MEMORY_VERB}(?! wrong)|last time (?:we|you)|where were we|remind me (?:what|how|why|where|when|which) (?:we|you)|you (?:said|mentioned|suggested))\\b`)
// A bare "we <verb>" counts only in the past and after a relative word: "the port we picked", "how
// we fixed" name earlier work; "what should we do tonight", "yesterday we tried a new route" do not.
// Nor does a story that says how the thing went (review of #80, #84): its clause goes on with is or
// was and a word of how it went ("the restaurant we tried last night was amazing, find me a similar
// one"), or it opens the message and asks nothing ("the hotel we picked two days ago cancelled").
// "the bug we fixed yesterday is back", "the port we picked?" and "the config we changed, show it"
// ask about earlier work (second review of #80). Within the clause: a pasted transcript with no
// punctuation must not cost a scan to its end at every clause.
const PAST_VERB = '(?:decided|discussed|talked|agreed|chose|picked|fixed|changed|tried|built|wrote|set up|settled|said|did|done|planned|used|worked on|left off)'
const STORY_WORDS = '(?:so |too |really |very |pretty |quite )?(?:amazing|awesome|great|lovely|fun|delicious|beautiful|boring|awful|terrible|horrible|crazy|torn|steep|dry|cancell?ed|expensive)'
const RELATIVE_EN = new RegExp(`\\b(?:what|which|how|why|where|when|that|the [\\w-]+) we (?:already |just )?${PAST_VERB}\\b(?![^,.;!?]{0,40}\\b(?:is|are|was|were|looks?|seems?) ${STORY_WORDS}\\b)`)
const STORY_EN = new RegExp(`^the [\\w-]+ we (?:already |just )?${PAST_VERB}\\b(?![^?]*\\b(?:it|them|what|which|show|remind|recap|summari[sz]e|list|(?:is|are) back|anymore|(?:is|are|was|were) broken|failing|fails|failed|wrong|errors?)\\b)[^?]*$`)
// Nor does a plan in Chinese: 我们要讨论的, 我们打算定的 (#80); 我们主要讨论了 still counts, and so
// do 会话, 会议, 开会 and 想法, which are no plans (review of #80).
const PAST_ZH = /上次(?:我们|咱们|你|聊|说|讨论|提|定|做|改)|之前(?:我们|咱们|你|说|聊|讨论|提|定|做)|(?:我们|咱们)(?:之前|刚才|上次)|(?:我们|咱们)(?:(?!(?<!主)要|将|(?<!开)会(?![话议上])|想(?!法)|打算|准备)[^。？?！!]){0,8}(?:聊|讨论|定|决定|说|谈)(?:过|了|的)|刚才(?:说|聊|提|讨论)|(?:说|聊|讨论|提到)的那个|(?:聊|讨论|做|干)了(?:什么|哪些|啥)|那天(?:我们|聊|说)/

/**
 * Whether a message asks about earlier work in this memory ("what did we do", "last time", 之前我们,
 * 上次). Only such a message gets a day digest: "today I want to learn rust" names a day but is not
 * about memory (#24).
 */
export function asksAboutPast(text) {
  const s = String(text ?? '').normalize('NFKC').toLowerCase()
  return PAST_EN.test(s) || (RELATIVE_EN.test(s) && !STORY_EN.test(s)) || PAST_ZH.test(s)
}

export const inRange = (iso, range) => Boolean(iso) && new Date(iso) >= range.from && new Date(iso) < range.to

/** A chat overlaps the range when it was active at any point inside it. */
export const chatInRange = (meta, range) => Boolean(meta?.startedAt) && new Date(meta.startedAt) < range.to && new Date(meta.lastActiveAt ?? meta.startedAt) >= range.from

/** Local calendar day (YYYY-MM-DD) of a timestamp, the same day recall("YYYY-MM-DD") and "today" search. */
export function day(value) {
  const d = new Date(value ?? NaN)
  return Number.isNaN(+d) ? '' : iso(d)
}
