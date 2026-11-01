/**
 * On-disk layout under `<dir>` (default `<workspace>/.context-graph`):
 *   graph.json      the graph (see graph.js)
 *   src/<id>.md     verbatim source text of one node, one section appended per build
 * ponytail: last writer wins across concurrent sessions; add a lock file if two agents share a workspace.
 */

import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises'
import { join } from 'node:path'

import { emptyGraph, GRAPH_VERSION } from './graph.js'

export async function loadGraph(dir) {
  try {
    const graph = JSON.parse(await readFile(join(dir, 'graph.json'), 'utf8'))
    if (graph?.version !== GRAPH_VERSION || typeof graph.nodes !== 'object' || !Array.isArray(graph.edges)) return emptyGraph()
    return graph
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyGraph()
    throw error
  }
}

export async function saveGraph(dir, graph) {
  await mkdir(dir, { recursive: true })
  const target = join(dir, 'graph.json')
  const tmp = `${target}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(graph, null, 1), 'utf8')
  await rename(tmp, target)
}

/** Append one build's verbatim messages to the node's source file. */
export async function appendSource(dir, id, { session, turn, at, messages }) {
  await mkdir(join(dir, 'src'), { recursive: true })
  const body = messages.map((m) => `**${m.role}** (seq ${m.seq}):\n\n${m.text}`).join('\n\n')
  await appendFile(join(dir, 'src', `${id}.md`), `## ${at} session ${session} turn ${turn}\n\n${body}\n\n`, 'utf8')
}

export async function readSource(dir, id) {
  try {
    return await readFile(join(dir, 'src', `${id}.md`), 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
