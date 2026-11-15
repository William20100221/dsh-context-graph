/**
 * Package entry for dsh: the plugin's name, injections and apply(). The code lives in src/:
 *   src/core    pure logic (text, graph, matching, time, rendering, builder prompt, session events)
 *   src/store   files on disk under <workspace>/.context-graph
 *   src/host    dsh wiring (builder, memory injection, recall tool, command, meter, update check)
 *   src/client  the browser module (command card)
 * See docs/architecture.md.
 */
export { name, inject, apply } from './src/host/plugin.js'
