/**
 * Token meter: watches every `llm/stream` call and adds its usage to the conversation or the builder
 * bucket. Counters live for the app run; /context-graph stats shows them.
 */

import { PURPOSE } from './config.js'

export function createMeter() {
  return {
    main: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builder: { requests: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    builds: 0,
    injected: 0,
    injectedTokens: 0,
    recalls: 0
  }
}

export function registerMeter(ctx, meter) {
  ctx.on('llm/stream', (options, next) => {
    const inner = next()
    const bucket = options.purpose === PURPOSE ? meter.builder : meter.main
    async function* tracked() {
      try {
        for await (const chunk of inner) {
          if (chunk?.type === 'usage' && chunk.usage) {
            bucket.input += chunk.usage.inputTokens ?? 0
            bucket.cacheRead += chunk.usage.cacheReadTokens ?? 0
            bucket.cacheWrite += chunk.usage.cacheWriteTokens ?? 0
            bucket.output += chunk.usage.outputTokens ?? 0
          }
          yield chunk
        }
      } finally {
        bucket.requests++
      }
    }
    return tracked()
  })
}
