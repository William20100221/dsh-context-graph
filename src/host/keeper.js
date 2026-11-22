/**
 * Completes the stored messages of chats indexed before 0.13.0 (#93). Up to then a chat kept only
 * the messages its topics cite, cut to their head and tail, so once dsh's session was deleted the
 * rest of the chat was gone for good. Once per app run, a minute after start and one chat at a time,
 * every chat whose dsh session can still be read gets its whole indexed span from dsh's log, read
 * with the same off stretches every reader uses (runtime offsOf, chat closedAt), so nothing typed
 * while memory was off is stored. A chat whose session is gone keeps what it has. No model is called.
 */

import { closedAt } from '../core/chat.js'
import { collectSpan } from '../core/session.js'
import { chatDir, listChats } from '../store/chats.js'
import { saveMessages, storeComplete } from '../store/messages.js'

const DELAY_MS = 60000

/** `dirs()`: the memory folders this app knows (page.js known). */
export function registerKeeper(rt, { dirs }) {
  /** One chat: 'whole' already, 'completed' now, 'unreadable' (no session to read), or 'skipped'. */
  async function complete(dir, { sid, meta }) {
    // Nothing indexed yet; or a meta that lost its off stretches, which cannot vouch for its log.
    if (!Number.isInteger(meta.builtSeq) || (meta.turnsClosed === true && !Number.isInteger(meta.closedThrough))) return 'skipped'
    const folder = chatDir(dir, sid)
    if (await storeComplete(folder)) return 'whole'
    const observation = await rt.observe(sid)
    if (!observation) return 'unreadable'
    try {
      const bySeq = new Map(observation.events.map((event, i) => [Number.isInteger(event?.seq) ? event.seq : i, event]))
      // A fork's inherited part is its parent's: only its own part is its to keep (runtime indexStart).
      const inherited = observation.header?.isSeeded === true && Number.isInteger(observation.inheritedEventCount) ? observation.inheritedEventCount : 0
      const forkSeq = Math.max(Number(meta.forkSeq) || 0, inherited)
      const span = collectSpan((seq) => bySeq.get(seq), forkSeq - 1, { gaps: await rt.offsOf(dir, meta) })
      const messages = span.messages.filter((m) => m.seq <= meta.builtSeq && !closedAt(meta, m.seq))
      await saveMessages(folder, messages, { complete: true })
      return 'completed'
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  /** Every chat of every known folder, one at a time; one that fails is left for the next run. */
  async function sweep() {
    const done = {}
    for (const dir of await dirs()) {
      for (const chat of await listChats(dir).catch(() => [])) {
        const outcome = await complete(dir, chat).catch((error) => {
          console.error(`context-graph: messages of chat ${chat.sid} not completed (non-fatal; tried again next run)`, error?.message ?? error)
          return 'failed'
        })
        done[outcome] = (done[outcome] ?? 0) + 1
      }
    }
    return done
  }

  // A plain timer that keeps nothing alive, like runtime.js's retries: a sweep left over after the
  // plugin is unloaded only reads logs and adds messages, which is harmless.
  setTimeout(() => { sweep().catch(() => {}) }, DELAY_MS).unref?.()
  return { sweep, complete }
}
