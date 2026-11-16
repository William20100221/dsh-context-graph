/**
 * Token meter: watches every `llm/stream` call and adds its usage to one bucket:
 *   main     the conversation's own requests (dsh's isAgentLoopRequest)
 *   builder  this plugin's indexing calls (purpose 'context-graph')
 *   other    everything else, such as dsh compaction and session titles (#21)
 * These counters live for the app run; /context-graph stats shows them.
 *
 * It also feeds the per-chat savings estimate (#35, src/core/ledger.js) of every chat that had a
 * human turn in this run: each conversation request re-sends the plugin's blocks still in context
 * and carries the recall tool, and each indexing call reports its real usage. All of it is counted
 * in memory and written to the ledger at turn end (src/host/builder.js).
 */

import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'

import { PURPOSE } from './config.js'

const bucket = () => ({ requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 })

export function createMeter() {
  return { main: bucket(), builder: bucket(), other: bucket(), builds: 0, injected: 0, injectedTokens: 0, recalls: 0 }
}

/** Which bucket a request belongs to. `isAgentLoopRequest` checks object identity, so pass the options as received. */
export function bucketOf(meter, options) {
  if (options?.purpose === PURPOSE) return meter.builder
  return isAgentLoopRequest(options) ? meter.main : meter.other
}

export function registerMeter(ctx, meter, rt) {
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    const target = bucketOf(meter, options)
    // Only chats the memory hook has seen (a human turn in this run): subagents and other sessions are not charged.
    const st = options?.sessionId === undefined ? undefined : rt?.tracked(String(options.sessionId))
    if (st && target === meter.main) {
      st.delta.requests++
      // Blocks sent with this very request count as sent, not as re-sent.
      st.delta.resent += Math.max(0, st.inContext - st.justSent)
      st.delta.tool += rt.toolTokens
      st.justSent = 0
    } else if (!st && target === meter.main && options?.sessionId !== undefined) {
      // A subagent forked from a chat re-sends that chat's blocks and carries the recall tool with
      // every request it makes: charged to the chat that started it (review of #35).
      const fork = rt?.forkedFrom?.(String(options.sessionId))
      if (fork) {
        fork.st.delta.requests++
        fork.st.delta.resent += fork.tokens
        fork.st.delta.tool += rt.toolTokens
      }
    }
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk?.type === 'usage' && chunk.usage) {
            const u = chunk.usage
            target.input += u.inputTokens ?? 0
            target.cacheRead += u.cacheReadTokens ?? 0
            target.cacheWrite += u.cacheWriteTokens ?? 0
            target.output += u.outputTokens ?? 0
            if (st && target === meter.builder) {
              st.delta.indexIn += (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0)
              st.delta.indexCached += u.cacheReadTokens ?? 0
              st.delta.indexOut += u.outputTokens ?? 0
            }
          }
          yield chunk
        }
      } finally {
        target.requests++
      }
    }
    return tracked()
  })
}
