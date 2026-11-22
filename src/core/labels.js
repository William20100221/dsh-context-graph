/**
 * Chat labels (#94): what a chat, or a part of it, is for (a type from a fixed list) and the
 * project it works on. Indexing names them; matching uses them only to ORDER topics a message
 * already matched: a topic in a chat or part whose label the message names comes first. A label
 * never matches on its own, so it adds no unrelated topic and no input tokens. Pure.
 */

import { tokenize } from './text.js'

/** The types a chat or part can have, in the order Memory tree lists them. */
export const CHAT_TYPES = ['coding', 'debugging', 'research', 'study', 'writing', 'planning', 'setup', 'data', 'creative', 'language', 'question', 'chat']

/**
 * Words that name each type in a message. Everyday words a question about anything could hold
 * ("question", "chat", "help") name nothing; a single CJK character cannot be a cue (matching is by
 * bigrams).
 */
const CUES = {
  coding: ['code', 'coding', 'function', 'repo', 'implement', 'refactor', 'script', 'plugin', '代码', '编程', '函数', '插件'],
  debugging: ['bug', 'bugs', 'fix', 'fixed', 'fixing', 'error', 'errors', 'crash', 'debug', 'broken', '报错', '修复', '错误', '故障'],
  research: ['research', 'sources', 'paper', 'papers', 'look up', '研究', '资料', '调研'],
  study: ['homework', 'exam', 'exams', 'study', 'studying', 'revise', 'revision', 'assignment', 'course', '作业', '考试', '复习', '学习'],
  writing: ['essay', 'draft', 'write', 'writing', 'article', 'rewrite', '写作', '文章', '草稿', '作文'],
  planning: ['plan', 'plans', 'planning', 'schedule', 'roadmap', '计划', '安排', '规划'],
  setup: ['install', 'installed', 'setup', 'configure', 'config', 'settings', '安装', '配置', '设置'],
  data: ['data', 'dataset', 'analysis', 'chart', 'spreadsheet', '数据', '分析', '图表'],
  creative: ['story', 'poem', 'lyrics', 'brainstorm', '故事', '诗歌', '创意'],
  language: ['translate', 'translation', 'grammar', 'idiom', 'idioms', '翻译', '语法', '成语']
}
const CUE_TOKENS = Object.fromEntries(Object.entries(CUES).map(([type, words]) => [type, words.map((w) => tokenize(w)).filter((t) => t.length > 0)]))

/** A type from the list, or undefined. */
export const chatType = (value) => (CHAT_TYPES.includes(value) ? value : undefined)

/** Whether a message's tokens (`words`, a Set) name a type: all tokens of one of its cue words. */
const names = (type, words) => (CUE_TOKENS[type] ?? []).some((cue) => cue.every((t) => words.has(t)))

/**
 * How strongly a message names a topic's chat or part: 2 the chat's project (all its words), 1 the
 * chat's type or the type of a part holding one of the topic's sources (`refs`, seqs), 0 neither.
 */
export function labelCue(meta, words, refs = []) {
  if (!meta) return 0
  const project = typeof meta.project === 'string' ? tokenize(meta.project) : []
  if (project.length > 0 && project.every((t) => words.has(t))) return 2
  if (names(meta.type, words)) return 1
  for (const part of Array.isArray(meta.parts) ? meta.parts : []) {
    if (names(part?.type, words) && refs.some((seq) => seq >= part.from && seq <= part.to)) return 1
  }
  return 0
}

/** At most this many parts are kept per chat; the oldest go first. */
const MAX_PARTS = 12

/**
 * A chat's parts after a build: the new ones follow the old ones (a later span comes later in the
 * chat); one that continues the last one (same type and subject) extends it.
 * Each part: `{ from, to, turns: [first, last], type, about }`, `from`/`to` being seqs.
 */
export function mergeParts(old, found) {
  const out = (Array.isArray(old) ? old : []).map((p) => ({ ...p, turns: [...(p.turns ?? [])] }))
  for (const part of found) {
    const last = out.at(-1)
    if (last && last.type === part.type && last.about === part.about && part.from > last.to) {
      last.to = part.to
      last.turns = [last.turns[0], part.turns.at(-1)]
      continue
    }
    if (!last || part.from > last.to) out.push(part)
  }
  return out.slice(-MAX_PARTS)
}
