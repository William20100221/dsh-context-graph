/**
 * dsh-context-graph: memory of past chats as small per-chat graphs.
 *
 * On in every chat by default. `/context-graph off` stops one chat; switching the plugin off on
 * dsh's Plugins page stops all of them. While on:
 * - builder (src/host/builder.js): every few human turns, one auxiliary model call (at the route's
 *   lowest reasoning effort) indexes the new span into `<workspace>/.context-graph/chats/<session>/`
 *   (topics.json, the cited text in msgs.json, the chat's summary in meta.json).
 * - memory (src/host/memory.js): on a human turn, match the prompt against the other shared chats
 *   and append one short `[context-graph]` block at the end of the request, only when relevant;
 *   the first message of a chat also gets one line per earlier chat.
 * - recall (src/host/recall.js): a topic (c3n12), a chat (c3), a day (2026-11-01), or a turn of
 *   another chat (c3t7, read from dsh's own log) or of this one (t7).
 * - meter (src/host/meter.js) and the /context-graph command (src/host/command.js); the savings
 *   estimate is kept per chat in the workspace ledger (#35).
 * - page (src/host/page.js): owner-only routes for the plugin's page in Plugins: totals and the map.
 * Nothing is merged between chats; sharing is a flag on the chat. Stock compaction is untouched.
 */

import { registerBuilder } from './builder.js'
import { registerCommand } from './command.js'
import { DEFAULTS, upgradeConfig, version } from './config.js'
import { registerMemory } from './memory.js'
import { registerKeeper } from './keeper.js'
import { registerPage } from './page.js'
import { createMeter, registerMeter } from './meter.js'
import { registerRecall } from './recall.js'
import { createRuntime } from './runtime.js'
import { startUpdateCheck } from './update.js'

export const name = 'context-graph'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const { _updates, _sort, ...rest } = config
  // dsh's agents service finds the chat behind a nested subagent (runtime.ownerMeta).
  const rt = createRuntime({ ...DEFAULTS, ...upgradeConfig(rest) }, { agentById: (id) => ctx.get('agents')?.get?.(id), sessionQuery: () => ctx.get('sessionQuery') })
  // `_updates` lets tests stand in for the network check.
  const updates = _updates ?? startUpdateCheck(version)
  const meter = createMeter()
  // `_sort: false` lets tests that count model calls leave out the subject sorting call (#96).
  const { build, turnOn, onAtIdle, sortWorkspace } = registerBuilder(ctx, rt, meter, { sort: _sort !== false })
  registerMemory(ctx, rt, meter)
  registerMeter(ctx, meter, rt)
  registerRecall(ctx, rt, meter)
  registerCommand(ctx, rt, { build, turnOn, onAtIdle, meter, updates })
  const page = registerPage(ctx, rt)
  // Chats indexed before 0.13.0 get their whole indexed span from dsh's log, once per run (#93).
  const keeper = registerKeeper(rt, { dirs: async () => (await page.known()).map((k) => k.dir) })
  return { rt, page, keeper, sortWorkspace }
}
