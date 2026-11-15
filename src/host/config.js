/**
 * Plugin configuration defaults and fixed names. Every key here can be overridden in the
 * `config:` block of the plugin's row in cordis.patch.yml.
 */

import { readFileSync } from 'node:fs'

export const PURPOSE = 'context-graph'
export const USAGE = '[on|off|share|unshare|stats|build|map|find <words>]'
export const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

export const DEFAULTS = {
  dir: '.context-graph',
  buildEveryTurns: 4,
  buildMinChars: 400,
  maxHits: 5,
  inlineMaxChars: 1200,
  surfaceMaxChats: 20,
  builderMaxTokens: 8192,
  builderMaxInputChars: 60000,
  rangeMaxChats: 3,
  rangeMaxTopics: 3,
  provider: '',
  model: ''
}
