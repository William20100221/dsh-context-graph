/**
 * Plugin configuration defaults and fixed names. Every key here can be overridden in the
 * `config:` block of the plugin's row in cordis.patch.yml.
 */

import { readFileSync } from 'node:fs'

export const PURPOSE = 'context-graph'
export const USAGE = '[on|off|share|unshare|stats|build|map|find <words>]'
export const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

/**
 * Budgets are in tokens (estimateTokens), not characters: Chinese costs about 3.5x more per
 * character, so a character cap let a block cost three times its English size (#39).
 */
export const DEFAULTS = {
  dir: '.context-graph',
  buildEveryTurns: 4,
  buildMinChars: 400,
  /** Topics per message at most; usually fewer, only relevant ones pass (#23). */
  maxHits: 5,
  /** A clearly leading hit has its source inlined only up to this size. */
  inlineMaxTokens: 300,
  /** The chat list a new chat gets once (#27). */
  listMaxTokens: 200,
  /** recall of a topic: its newest cited messages, sharing one token budget (#29). */
  sourceMaxMessages: 3,
  sourceMaxTokens: 1000,
  /** recall of a turn (#47). */
  turnMaxTokens: 2000,
  builderMaxTokens: 8192,
  builderMaxInputChars: 60000,
  rangeMaxChats: 3,
  rangeMaxTopics: 3,
  provider: '',
  model: ''
}

/**
 * Keys of an older config block (cordis.patch.yml asks users to restate the whole block) mapped to
 * today's: `inlineMaxChars` (0.2-0.7) becomes `inlineMaxTokens` at about 4 characters a token, so
 * `0` still turns inlining off; `surfaceMaxChats` becomes `listMaxChats`, a cap on the lines of the
 * chat list. An explicit new key wins.
 */
export function upgradeConfig(config) {
  const { inlineMaxChars, surfaceMaxChats, ...out } = config
  if (inlineMaxChars !== undefined && out.inlineMaxTokens === undefined) out.inlineMaxTokens = Math.round((Number(inlineMaxChars) || 0) / 4)
  if (surfaceMaxChats !== undefined && out.listMaxChats === undefined) out.listMaxChats = Number(surfaceMaxChats) || 0
  return out
}
