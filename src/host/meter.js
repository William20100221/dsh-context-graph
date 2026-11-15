/**
 * Token meter: watches every `llm/stream` call and adds its usage to one bucket:
 *   main     the conversation's own requests (dsh's isAgentLoopRequest)
 *   builder  this plugin's indexing calls (purpose 'context-graph')
 *   other    everything else, such as dsh compaction and session titles (#21)
 * Counters live for the app run; /context-graph stats shows them.
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

export function registerMeter(ctx, meter) {
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    const target = bucketOf(meter, options)
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk?.type === 'usage' && chunk.usage) {
            target.input += chunk.usage.inputTokens ?? 0
            target.cacheRead += chunk.usage.cacheReadTokens ?? 0
            target.cacheWrite += chunk.usage.cacheWriteTokens ?? 0
            target.output += chunk.usage.outputTokens ?? 0
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
