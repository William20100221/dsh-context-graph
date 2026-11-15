/**
 * Text helpers shared by every layer: token estimates, search tokens and message text.
 * Pure: no I/O and no dsh imports, so `node --test` covers it without a harness.
 */

export const STOPWORDS = new Set((
  'a an the and or but if then so of to in on at for with by from as is are was were be been being ' +
  'do does did done have has had can could should would will shall may might must not no yes ' +
  'i me my we our you your he she it its they them this that these those there here what which who ' +
  'how when where why also just like get got make made use used using want need let please ok okay ' +
  'now new one two about into over under again more most some any all each other than too very ' +
  '的 了 是 在 我 你 他 她 它 们 这 那 个 和 与 或 吗 呢 吧 啊 把 被 给 让 就 都 也 还 很 不 没 有 要 会 能 可以 什么 怎么 这个 那个 一下 一个'
).split(/\s+/))

/** Rough token estimate for budget caps; CJK is close to one token per char. */
export function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) if (/[぀-ヿ㐀-鿿가-힯]/.test(ch)) cjk++
  return Math.ceil(cjk + (text.length - cjk) / 3.5)
}

/**
 * Lowercased word tokens plus CJK bigrams, stopwords removed.
 * "clear_conversation tool" -> ["clear_conversation", "clear", "conversation", "tool"]
 * "清除上下文" -> ["清除", "除上", "上下", "下文"]
 */
export function tokenize(text) {
  const out = new Set()
  const lower = String(text ?? '').toLowerCase()
  for (const run of lower.match(/[぀-ヿ㐀-鿿가-힯]+/g) ?? []) {
    if (run.length === 1) { if (!STOPWORDS.has(run)) out.add(run); continue }
    for (let i = 0; i + 1 < run.length; i++) {
      const bigram = run.slice(i, i + 2)
      if (!STOPWORDS.has(bigram)) out.add(bigram)
    }
  }
  for (const word of lower.replace(/[぀-ヿ㐀-鿿가-힯]+/g, ' ').match(/[a-z0-9_./-]{2,}/g) ?? []) {
    if (STOPWORDS.has(word)) continue
    out.add(word)
    if (/[_./-]/.test(word)) for (const part of word.split(/[_./-]+/)) if (part.length >= 2 && !STOPWORDS.has(part)) out.add(part)
  }
  return [...out]
}

/** The text blocks of a dsh message's content, joined. */
export function textOf(content) {
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim()
}
