/**
 * On-disk layout under `<dir>` (default `<workspace>/.context-graph`), one folder per chat:
 *   chats/<sessionId>/meta.json    { cid, title, workspace, startedAt, lastActiveAt, turns, memory, shared }
 *   chats/<sessionId>/graph.json   the chat's graph (see graph.js)
 *   chats/<sessionId>/src/<id>.md  verbatim source text of one node, one section appended per build
 * Nothing is merged or copied between chats; the list of chats is the list of folders.
 * ponytail: last writer wins across concurrent sessions; add a lock file if two agents share a workspace.
 */

import { mkdir, readdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import { emptyGraph, GRAPH_VERSION } from './graph.js'

export const chatDir = (dir, sid) => join(dir, 'chats', String(sid))

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJson(path, value) {
  await mkdir(join(path, '..'), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 1), 'utf8')
  await rename(tmp, path)
}

export async function loadGraph(chat) {
  const graph = await readJson(join(chat, 'graph.json'))
  if (graph?.version !== GRAPH_VERSION || typeof graph.nodes !== 'object' || !Array.isArray(graph.edges)) return emptyGraph()
  return graph
}

export const saveGraph = (chat, graph) => writeJson(join(chat, 'graph.json'), graph)

export const loadMeta = (dir, sid) => readJson(join(chatDir(dir, sid), 'meta.json'))

export const saveMeta = (dir, sid, meta) => writeJson(join(chatDir(dir, sid), 'meta.json'), meta)

/** Every chat folder with a readable meta.json, newest activity first. */
export async function listChats(dir) {
  let names = []
  try { names = await readdir(join(dir, 'chats')) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  const chats = []
  for (const sid of names) {
    const meta = await loadMeta(dir, sid)
    if (meta) chats.push({ sid, meta })
  }
  return chats.sort((a, b) => String(b.meta.lastActiveAt ?? '').localeCompare(String(a.meta.lastActiveAt ?? '')))
}

/** The chat's meta, created on first sight with the next free chat number. */
export async function ensureMeta(dir, sid, { title, workspace, now }) {
  const existing = await loadMeta(dir, sid)
  if (existing) return existing
  const cid = (await listChats(dir)).reduce((max, c) => Math.max(max, c.meta.cid ?? 0), 0) + 1
  const meta = { cid, title, workspace, startedAt: now, lastActiveAt: now, turns: 0, memory: false, shared: false }
  await saveMeta(dir, sid, meta)
  return meta
}

/** Append one build's verbatim messages to the node's source file. */
export async function appendSource(chat, id, { session, turn, at, messages }) {
  await mkdir(join(chat, 'src'), { recursive: true })
  const body = messages.map((m) => `**${m.role}** (seq ${m.seq}):\n\n${m.text}`).join('\n\n')
  await appendFile(join(chat, 'src', `${id}.md`), `## ${at} session ${session} turn ${turn}\n\n${body}\n\n`, 'utf8')
}

export async function readSource(chat, id) {
  try {
    return await readFile(join(chat, 'src', `${id}.md`), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
