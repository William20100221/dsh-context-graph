/**
 * Text helpers shared by every layer: token estimates, search words and message text.
 * Pure: no I/O and no dsh imports, so `node --test` covers it without a harness.
 */

/** Hiragana, katakana, CJK ideographs and Hangul: scripts written without spaces between words. */
const CJK_RUN = /[぀-ヿ㐀-鿿가-힯]+/g
const CJK_COUNT = /[぀-ヿ㐀-鿿가-힯]/g
const HIRAGANA = /[぀-ゟ]/

export const STOPWORDS = new Set((
  'a an the and or but if then so of to in on at for with by from as is are was were be been being ' +
  'do does did done have has had can could should would will shall may might must not no yes ' +
  'i me my we our you your he she it its they them this that these those there here what which who ' +
  'how when where why also just like get got make made use used using want need let please ok okay ' +
  'now new one two about into over under again more most some any all each other than too very ' +
  // Everyday words that say nothing about a topic (#23): "can you help, I got an error again".
  'many much before after still even only really thing things something anything way lot lots bit ' +
  'kind sort maybe sure thanks thank hi hello hey right good great best better bad try tried help ' +
  'know think say said tell go going see look show give take put keep keeps kept since until while ' +
  'because though however actually basically back first last next time day days week month year ' +
  'today tomorrow yesterday ago morning tonight ' +
  '的 了 是 在 我 你 他 她 它 们 这 那 个 和 与 或 吗 呢 吧 啊 把 被 给 让 就 都 也 还 很 不 没 有 要 会 能 ' +
  '可以 什么 怎么 这个 那个 一下 一个 ' +
  // Chinese function words: in a prompt they glue the question together and match any topic (#23).
  '之前 上次 最后 最近 现在 已经 还是 时候 我们 你们 他们 可能 应该 需要 觉得 知道 然后 因为 所以 ' +
  '但是 如果 这样 那样 一些 问题 东西 办法 比较 有点 帮我 给我 请问 一直 怎样 如何 为什 哪个 哪里 ' +
  '哪些 多少 今天 昨天 明天 前天 上周 本周 这周 上个 本月 上月'
).split(/\s+/))

/**
 * Characters that only glue a Chinese sentence together. A bigram made of two of them ("我的",
 * "了吗", "是不") is never a search word; one next to a content character ("会话", "性能") still is.
 */
const FUNCTION_CHARS = new Set([...'的了吗呢吧啊呀么嘛哦啦我你他她它们这那哪个些是在和与或把被给让就都也还很不没有要会能又再得地着过对从跟并而且之其此啥咋怎什'])

/** Rough token estimate for budgets; CJK is close to one token per character. */
export function estimateTokens(text) {
  const s = String(text ?? '')
  const cjk = s.match(CJK_COUNT)?.length ?? 0
  return Math.ceil(cjk + (s.length - cjk) / 3.5)
}

const CJK_CHAR = /[぀-ヿ㐀-鿿가-힯]/
const charTokens = (ch) => (CJK_CHAR.test(ch) ? 1 : 1 / 3.5)

/**
 * `text` cut to about `maxTokens`, keeping its head (70%) and tail (30%) around a marker that says
 * how much was left out and where the rest is (`more`). The cut points are found by adding up each
 * character's cost, so Chinese before English (or the reverse) cannot overshoot the budget.
 */
export function clipTokens(text, maxTokens, more = '') {
  const s = String(text ?? '')
  if (estimateTokens(s) <= maxTokens) return s
  const budget = Math.max(0, maxTokens - 24)
  let used = 0
  let head = 0
  while (head < s.length && used + charTokens(s[head]) <= budget * 0.7) used += charTokens(s[head++])
  used = 0
  let tail = s.length
  while (tail > head && used + charTokens(s[tail - 1]) <= budget * 0.3) used += charTokens(s[--tail])
  head = cutBefore(s, head)
  tail = Math.max(head, cutAfter(s, tail))
  return `${s.slice(0, head)}\n…[${tail - head} chars cut${more ? `; ${more}` : ''}]…${tail < s.length ? `\n${s.slice(tail)}` : ''}`
}

const isHigh = (code) => code >= 0xd800 && code <= 0xdbff
const isLow = (code) => code >= 0xdc00 && code <= 0xdfff

/**
 * A cut position that does not split a surrogate pair (an emoji, a rare CJK character): a lone
 * half would make the text invalid, and dsh's own log writers refuse that. `cutBefore` moves an
 * end position back, `cutAfter` moves a start position forward.
 */
export const cutBefore = (s, i) => (i > 0 && i < s.length && isHigh(s.charCodeAt(i - 1)) && isLow(s.charCodeAt(i)) ? i - 1 : i)
export const cutAfter = (s, i) => (i > 0 && i < s.length && isLow(s.charCodeAt(i)) && isHigh(s.charCodeAt(i - 1)) ? i + 1 : i)

const HEAD = 4500
const TAIL = 1000

/**
 * A long message as it is stored: its head and tail; the full text stays in dsh's own session log.
 * Here in the core because the savings estimate counts every source as if it was stored this way.
 */
export function capText(text) {
  const s = String(text ?? '')
  if (s.length <= HEAD + TAIL + 200) return s
  const head = cutBefore(s, HEAD)
  const tail = cutAfter(s, s.length - TAIL)
  return `${s.slice(0, head)}\n…[${tail - head} chars omitted; the full turn is in the chat's dsh log]…\n${s.slice(tail)}`
}

/** The first `max` characters of `s`, never half a surrogate pair. */
export const sliceChars = (s, max) => s.slice(0, cutBefore(s, Math.min(max, s.length)))

const searchable = (a, b) => !(FUNCTION_CHARS.has(a) && FUNCTION_CHARS.has(b)) && !(HIRAGANA.test(a) && HIRAGANA.test(b))

// Katakana words (transliterations such as データベース) and Hangul words are written as one run
// of syllables: a run of either script is one word, however long.
const SINGLE_WORD_SCRIPT = /[゠-ヿ]+|[가-힯]+|[^゠-ヿ가-힯]+/g
const isSingleWordScript = (run) => /^[゠-ヿ]+$/.test(run) || /^[가-힯]+$/.test(run)

/**
 * Whether a word is code: it has _ or . (identifiers, file names), or is a path of three or more
 * parts, or has a slash and a digit (api/v1). "ci/cd" or "read/write" are plain words.
 */
function isCode(word) {
  const slashes = word.split('/').length - 1
  return /[_.]/.test(word) || slashes >= 2 || (slashes === 1 && /\d/.test(word))
}

/**
 * A text's search words, grouped by the word they came from, so evidence can be counted per word:
 *   { kind: 'word', tokens, code }  one word in any alphabet (NFKC, so full-width "ＡＰＩ" is "api"),
 *                                   then its identifier parts; `code`: see isCode
 *   { kind: 'cjk', bigrams, one }   one run of CJK text as its bigrams in order, null where a bigram
 *                                   is not a search word; `one` when the run is a single word
 *                                   (katakana or Hangul)
 * Stopwords are dropped, and so are CJK bigrams made only of particles/pronouns or only of
 * hiragana, which match everything (#23, #25).
 */
export function searchUnits(text) {
  const units = []
  const lower = String(text ?? '').normalize('NFKC').toLowerCase()
  for (const cjk of lower.match(CJK_RUN) ?? []) {
    for (const run of cjk.match(SINGLE_WORD_SCRIPT) ?? []) {
      if (run.length === 1) {
        if (!STOPWORDS.has(run) && !FUNCTION_CHARS.has(run) && !HIRAGANA.test(run)) units.push({ kind: 'cjk', bigrams: [run], one: false })
        continue
      }
      const bigrams = []
      for (let i = 0; i + 1 < run.length; i++) {
        const bigram = run.slice(i, i + 2)
        bigrams.push(!STOPWORDS.has(bigram) && searchable(run[i], run[i + 1]) ? bigram : null)
      }
      if (bigrams.some(Boolean)) units.push({ kind: 'cjk', bigrams, one: isSingleWordScript(run) })
    }
  }
  for (const raw of lower.replace(CJK_RUN, ' ').match(/[\p{L}\p{N}_./-]{2,}/gu) ?? []) {
    // Most words have no separator: one plain word, no parts (#66).
    if (!/[_./-]/.test(raw)) {
      if (!STOPWORDS.has(raw)) units.push({ kind: 'word', tokens: [raw], code: false })
      continue
    }
    const word = raw.replace(/[./-]+$/, '')
    if (word.length < 2 || !/[\p{L}\p{N}]/u.test(word) || STOPWORDS.has(word)) continue
    const tokens = [word]
    if (/[_./-]/.test(word)) for (const part of word.split(/[_./-]+/)) if (part.length >= 2 && !STOPWORDS.has(part) && !tokens.includes(part)) tokens.push(part)
    units.push({ kind: 'word', tokens, code: isCode(word) })
  }
  return units
}

/**
 * Every search word of a text, once.
 * "clear_conversation tool" -> ["clear_conversation", "clear", "conversation", "tool"]
 * "清除上下文" -> ["清除", "除上", "上下", "下文"]
 */
export function tokenize(text) {
  const out = new Set()
  for (const unit of searchUnits(text)) for (const t of unit.kind === 'cjk' ? unit.bigrams : unit.tokens) if (t) out.add(t)
  return [...out]
}

/** The text blocks of a dsh message's content, joined. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}
