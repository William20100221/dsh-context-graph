/**
 * Chat-level protocol shared by every layer. Pure.
 */

/** `source.kind` of every message this plugin adds to a chat, and the marker that opens its blocks. */
export const SOURCE_KIND = 'context-graph'

/** Memory is on in every chat unless `/context-graph off` was run there; the Plugins page switch turns the whole plugin off. */
export const memoryOn = (meta) => meta?.memoryOff !== true

/** Chats are shared with the rest of the workspace unless `/context-graph unshare` was run there. */
export const sharedOn = (meta) => meta?.private !== true
