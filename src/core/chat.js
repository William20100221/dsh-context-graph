/**
 * Chat-level protocol shared by every layer. Pure.
 */

/** `source.kind` of every message this plugin adds to a chat, and the marker that opens its blocks. */
export const SOURCE_KIND = 'context-graph'

/** Memory is on in every chat unless `/context-graph off` was run there; the Plugins page switch turns the whole plugin off. */
export const memoryOn = (meta) => meta?.memoryOff !== true

/** Chats are shared with the rest of the workspace unless `/context-graph unshare` was run there. */
export const sharedOn = (meta) => meta?.private !== true

/**
 * Where a chat's memory went off, or undefined while it is on: the point `off` recorded, else (off
 * under 0.8.0, a meta recovered fail-closed, a fork that starts off) the chat's last index, so all
 * of what came after counts as typed while off (#59).
 */
export const offPoint = (meta) => (Number.isInteger(meta?.offSeq) ? meta.offSeq : memoryOn(meta) ? undefined : Number.isInteger(meta?.builtSeq) ? meta.builtSeq : -1)

/**
 * Whether `seq` of a chat lies where its off stretches were lost: a meta recovered after damage
 * (turnsClosed) cannot tell, up to where memory was turned on again (`closedThrough`, set by on).
 */
/**
 * The stretches a chat's log is read with as private: its gaps, and for a meta whose off stretches
 * were lost (turnsClosed), everything up to where memory was turned on again, so a goal set in a
 * lost stretch stays private when it is resumed (third check of #69).
 */
export const walkGaps = (meta) => {
  const gaps = Array.isArray(meta?.gaps) ? meta.gaps : []
  return meta?.turnsClosed === true ? [[0, Number.isInteger(meta.closedThrough) ? meta.closedThrough : Infinity], ...gaps] : gaps
}
export const closedAt = (meta, seq) => meta?.turnsClosed === true && seq <= (Number.isInteger(meta.closedThrough) ? meta.closedThrough : Infinity)
