/**
 * A fake dsh harness for host tests: a session whose log grows like dsh's (`commit` appends what a
 * pre-step decided to send), a scripted builder model, and the plugin's listeners, tool and command
 * captured for direct calls. Host tests need DSH_NODE_MODULES (see resolve-dsh.mjs).
 */

export const skip = !process.env.DSH_NODE_MODULES
export const NO_UPDATES = { current: () => undefined }

export const user = (text, time) => ({ type: 'user/message', ...(time ? { time } : {}), data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } })
export const assistant = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
export const ask = (text) => ({ kind: 'enter', messages: [{ source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
export const system = () => ({ type: 'system/message', data: {} })

/** A system prompt then `turns` human/assistant pairs about commit signing. */
export const chatEvents = (turns, reply = 'Noted, signing configured.') => [
  system(),
  ...Array.from({ length: turns }, (_, i) => [user(`We decided to sign commits with the SSH key, step ${i}. `.repeat(4)), assistant(reply)]).flat()
]

export const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Poll `check` (sync or async) until it returns something truthy, and return that. For work the
 * plugin starts in the background (a build at turn end): a fixed wait was flaky under a full,
 * parallel test run. Fails after `timeout` ms.
 */
// 15 s, every 50 ms: with every test file writing at once, Windows can hold a file for seconds
// (a scan on each open), and polling a file every few ms keeps it held; a real failure still fails.
export async function until(check, { timeout = 15000, every = 50 } = {}) {
  const end = Date.now() + timeout
  for (;;) {
    const value = await Promise.resolve().then(check).catch(() => undefined)
    if (value) return value
    if (Date.now() > end) throw new Error(`until: still not true after ${timeout} ms`)
    await wait(every)
  }
}

export async function quietly(fn) {
  const original = console.error
  console.error = () => {}
  try { return await fn() } finally { console.error = original }
}

/**
 * A session whose log grows. `surface` starts as every seq; `compact(from, to)` replaces a surface
 * range with one checkpoint, the way dsh compaction does (the events stay in the log).
 */
export function liveSession(id, cwd, events, { header = {}, inheritedEventCount = 0 } = {}) {
  const log = [...events]
  const surface = { nodes: log.map((_, i) => i), replaceGeneration: 0 }
  return {
    id,
    header: { id, cwd, ...header },
    inheritedEventCount,
    surface,
    log,
    eventAt: (seq) => log[seq],
    requestHeader: () => ({ config: { provider: 'p', model: 'm' } }),
    commit(messages) {
      for (const m of messages) surface.nodes.push(log.push({ type: 'user/message', data: m }) - 1)
    },
    append(event) {
      surface.nodes.push(log.push(event) - 1)
    },
    compact(fromSeq, toSeq) {
      const seq = log.push({ type: 'user/message', data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'summary' }] } }) - 1
      const a = surface.nodes.indexOf(fromSeq)
      const b = surface.nodes.indexOf(toSeq)
      surface.nodes.splice(a, b - a + 1, seq)
      surface.replaceGeneration++
    }
  }
}

/**
 * A builder model that answers `reply` (after `gate` resolves, when given) and records each call.
 * `finish(options)` picks the finish kind (default 'stop'; 'max-tokens' for a cut-off answer);
 * `efforts` makes it report reasoning efforts through resolveModelInfo, like dsh-llm does.
 */
export function scriptedLlm({ reply, gate, finish, efforts } = {}) {
  const llm = {
    calls: 0,
    promptChars: 0,
    options: [],
    prompts: [],
    async *stream(options) {
      llm.calls++
      llm.options.push(options)
      llm.prompts.push(options.messages[0].content[0].text)
      llm.promptChars = options.messages[0].content[0].text.length
      if (gate) await gate
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'aborted' } } }
        return
      }
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: typeof reply === 'function' ? reply(options) : reply }
      yield { type: 'finish', reason: { kind: finish ? finish(options) : 'stop' } }
    }
  }
  if (efforts) llm.resolveModelInfo = async () => ({ reasoning: { efforts: efforts.map((id) => ({ id, name: id })) } })
  return llm
}

/**
 * The plugin applied to a fake context; `run` calls the command, `step` runs a pre-step and commits
 * it. `services` are what `ctx.get` returns besides the llm (e.g. a fake sessionQuery).
 */
export async function setup(config = {}, llm = scriptedLlm({ reply: DEFAULT_REPLY }), services = {}) {
  const { apply } = await import('../../index.js')
  const listeners = {}
  const tools = []
  const commands = []
  const ctx = {
    on: (event, fn) => { listeners[event] = fn },
    get: (service) => (service === 'llm' ? llm : services[service]),
    tools: { register: (tool) => tools.push(tool) },
    // Like cordis: a nested plugin starts only when every service it injects is there.
    plugin: (nested) => {
      const available = { commands: { register: (c) => { commands.push(c); return () => {} } }, ...services }
      if ((nested.inject ?? []).every((name) => name in available)) nested.apply({ effect: (gen) => { for (const _ of gen()); }, ...available })
    }
  }
  // The subject sorting call (#96) would add a model call to every test that counts them: off here,
  // on in the tests of #96 (`_sort: true`).
  const plugin = apply(ctx, { _updates: NO_UPDATES, _sort: false, ...config })
  const run = (agent, rawInput, extra = {}) => commands[0].handler({ rawInput, agent, ...extra })
  const step = async (agent, decision) => {
    const out = await listeners['agent/pre-step']({ agent, messages: decision.messages }, async () => decision)
    agent.session.commit(out.messages)
    return out
  }
  const recall = (agent, id) => tools[0].execute({ id }, { agent })
  return { ctx, listeners, tools, commands, llm, run, step, recall, plugin }
}

export const DEFAULT_REPLY = JSON.stringify({ nodes: [{ id: null, label: 'commit signing', gist: 'signed with id_ed25519_signing', aliases: ['gpg'], kind: 'decision', msgs: [0] }], edges: [] })

export const agentOf = (sid, cwd, events, options = {}) => ({ options: { cwd }, session: liveSession(sid, cwd, events, options), runMaintenance: (fn) => fn() })
