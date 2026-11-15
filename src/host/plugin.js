/**
 * dsh-context-graph: memory of past chats as small per-chat graphs.
 *
 * On in every chat by default. `/context-graph off` stops one chat; switching the plugin off on
 * dsh's Plugins page stops all of them. While on:
 * - builder (src/host/builder.js): every few human turns, one auxiliary model call indexes the new
 *   span into `<workspace>/.context-graph/chats/<session>/graph.json` and stores the cited text.
 * - memory (src/host/memory.js): on a human turn, match the prompt against the other shared chats
 *   and append one short `[context-graph]` block at the end of the request.
 * - recall (src/host/recall.js): a topic (c3n12), a chat (c3), a day (2026-11-01) or a turn (t7).
 * - meter (src/host/meter.js) and the /context-graph command (src/host/command.js).
 * Nothing is merged between chats; sharing is a flag on the chat. Stock compaction is untouched.
 */

import { registerBuilder } from './builder.js'
import { registerCommand } from './command.js'
import { DEFAULTS, version } from './config.js'
import { registerMemory } from './memory.js'
import { createMeter, registerMeter } from './meter.js'
import { registerRecall } from './recall.js'
import { createRuntime } from './runtime.js'
import { startUpdateCheck } from './update.js'

export const name = 'context-graph'
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const { _updates, ...rest } = config
  const rt = createRuntime({ ...DEFAULTS, ...rest })
  // `_updates` lets tests stand in for the network check.
  const updates = _updates ?? startUpdateCheck(version)
  const meter = createMeter()
  const build = registerBuilder(ctx, rt, meter)
  registerMemory(ctx, rt, meter, updates)
  registerMeter(ctx, meter)
  registerRecall(ctx, rt, meter)
  registerCommand(ctx, rt, { build, meter, updates })
}
